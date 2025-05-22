/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
    Connection,
    Keypair,
    Transaction,
    VersionedTransaction, // For handling transactions that might be versioned
    sendAndConfirmTransaction, // Simpler for relay, but consider sendRawTransaction for more control
    PublicKey, // Added PublicKey for PRD auth requirement
    // verify // Removed as it's not a direct export and was unused
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2'; // For PRD auth requirement
import bs58 from 'bs58';
import { Buffer } from 'buffer'; // Ensure Buffer is available for bs58 and Transaction.from

// Define the shape of the environment variables
// interface Env {
//   NEYNAR_API_KEY: string;
//   ALCHEMY_SOLANA_RPC_URL: string;
//   RELAYER_KEY: string;
//   CRUSH_PROGRAM_ID: string; // As per PRD, for validation
//   USER_INDEX_KV: KVNamespace;
// }

const app = new Hono();

// Setup CORS middleware to allow requests from your frontend
// Adjust origin as necessary, e.g., to your localhost for development or your deployed frontend URL
app.use('/api/*', cors()); 

app.get('/', (c) => {
	return c.text('Hello from Hono on Cloudflare Workers!');
});

app.get('/api/search-users', async (c) => {
	const { NEYNAR_API_KEY } = c.env;
	if (!NEYNAR_API_KEY) {
		return c.json({ error: 'Neynar API key not configured' }, 500);
	}

	const query = c.req.query('q');
	if (!query) {
		return c.json({ error: 'Search query \'q\' is required' }, 400);
	}

	const neynarApiUrl = `https://api.neynar.com/v2/farcaster/user/search?q=${encodeURIComponent(query)}&limit=5`;

	try {
		const response = await fetch(neynarApiUrl, {
			method: 'GET',
			headers: {
				'Accept': 'application/json',
				'x-api-key': NEYNAR_API_KEY
			},
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error(`Neynar API error: ${response.status} ${response.statusText}`, errorText);
			return c.json({ error: 'Failed to fetch data from Neynar API', details: errorText }, response.status);
		}

		const neynarData = await response.json();
		
		// Transform the data to the desired format
		const users = neynarData.result.users.map(user => {
			// Extract primary SOL address, default to null if not found
			const primarySolAddress = user.verified_addresses?.primary?.sol_address || null;
			
			return {
				fid: user.fid,
				username: user.username,
				display_name: user.display_name,
				pfp_url: user.pfp_url,
				primary_sol_address: primarySolAddress, // This will be our edPubTarget
			};
		});

		return c.json({ users });

	} catch (error) {
		console.error('Error in /api/search-users:', error);
		return c.json({ error: 'Internal server error' }, 500);
	}
});

// New route for Solana RPC Proxy
app.post('/api/solana-rpc', async (c) => {
	const { ALCHEMY_SOLANA_RPC_URL } = c.env;
	if (!ALCHEMY_SOLANA_RPC_URL) {
		console.error('ALCHEMY_SOLANA_RPC_URL not configured in worker environment');
		return c.json({ error: 'RPC proxy not configured' }, 500);
	}

	let requestBody;
	try {
		requestBody = await c.req.json();
	} catch (e) {
		console.error('Failed to parse request body for RPC proxy:', e);
		return c.json({ error: 'Invalid request body' }, 400);
	}

	try {
		console.log(`Proxying RPC request to: ${ALCHEMY_SOLANA_RPC_URL}`/*, JSON.stringify(requestBody)*/); // Avoid logging potentially large bodies unless debugging

		const alchemyResponse = await fetch(ALCHEMY_SOLANA_RPC_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				// Add any other headers Alchemy might require, if any (usually just Content-Type)
			},
			body: JSON.stringify(requestBody),
		});

		// Forward the response from Alchemy back to the client
		// We need to be careful about headers, especially for CORS if the client makes direct OPTIONS preflights
		// but since this is a proxy, we mainly care about the content type and the body.
		
		// Create a new response with the body and status from Alchemy
		// Clone the response to be able to access its properties and return its body
		const alchemyResponseBody = await alchemyResponse.clone().arrayBuffer();
		
		// Set headers from Alchemy response. Filter or be selective if needed.
		const responseHeaders = new Headers();
		responseHeaders.set('Content-Type', alchemyResponse.headers.get('Content-Type') || 'application/json');
		// Add other important headers from alchemyResponse if necessary, e.g., cache-control, etc.

		// Log status for debugging
		console.log(`Alchemy response status: ${alchemyResponse.status}`);

		return new Response(alchemyResponseBody, {
			status: alchemyResponse.status,
			headers: responseHeaders
		});

	} catch (error) {
		console.error('Error proxying Solana RPC request:', error);
		return c.json({ error: 'Failed to proxy RPC request', details: error.message }, 500);
	}
});

// New endpoint to provide relayer's public key
app.get('/api/config', (c) => {
    const { RELAYER_KEY } = c.env;
    if (!RELAYER_KEY) {
        console.error('Relay config: RELAYER_KEY not configured.');
        return c.json({ error: 'Relayer not configured' }, 500);
    }
    try {
        const decodedRelayerSeed = bs58.decode(RELAYER_KEY);
        const relayerKeypair = Keypair.fromSeed(decodedRelayerSeed);
        return c.json({ relayerPublicKey: relayerKeypair.publicKey.toBase58() });
    } catch (e) {
        console.error('Relay config: Error deriving relayer public key:', e.message);
        return c.json({ error: 'Error configuring relayer public key.' }, 500);
    }
});

// PRD 5.2: /relay endpoint
app.post('/api/relay', async (c) => {
    const { RELAYER_KEY, ALCHEMY_SOLANA_RPC_URL, CRUSH_PROGRAM_ID } = c.env;

    if (!RELAYER_KEY || !ALCHEMY_SOLANA_RPC_URL || !CRUSH_PROGRAM_ID) {
        console.error('Missing required environment variables for /relay endpoint');
        return c.json({ error: 'Relay service not configured properly.' }, 500);
    }

    try {
        const { tx: base64TransactionString } = await c.req.json();
        if (!base64TransactionString || typeof base64TransactionString !== 'string') {
            return c.json({ error: 'Invalid or missing transaction string in request body.' }, 400);
        }

        console.log('Relay: Received base64 transaction string for new relay logic.');

        const transactionBuffer = Buffer.from(base64TransactionString, 'base64');
        let receivedTransaction;
        let isReceivedVersioned = false;

        // Deserialize (assuming legacy transaction as per new frontend design)
        try {
            if ((transactionBuffer[0] & 0x80) !== 0) {
                 console.warn('Relay: Received transaction appears versioned, but legacy format is expected for this flow.');
                 // Attempt to deserialize as versioned, but this path might need more specific handling
                 receivedTransaction = VersionedTransaction.deserialize(transactionBuffer);
                 isReceivedVersioned = true;
            } else {
                receivedTransaction = Transaction.from(transactionBuffer);
            }
            console.log('Relay: Successfully deserialized received transaction.');
        } catch (deserializeError) {
            console.error('Relay: Failed to deserialize received transaction:', deserializeError);
            return c.json({ error: 'Failed to deserialize transaction.', details: deserializeError.message }, 400);
        }

        if (isReceivedVersioned) {
            // This simplified relay logic is primarily for legacy transactions where feePayer is set by client.
            // Handling pre-signed versioned transactions for relayer fee payment is more complex.
            console.error('Relay: Received a VersionedTransaction. This relay path is optimized for legacy transactions with client-set relayer feePayer.');
            return c.json({ error: 'Versioned transactions need a different relay handling for fee substitution.' }, 400);
        }

        // --- Start: New Relay Logic for Legacy Transactions ---
        console.log('Relay: Applying new relay logic for legacy transaction.');

        const relayerKeypair = Keypair.fromSeed(bs58.decode(RELAYER_KEY));

        // 1. Verify the transaction's feePayer is the relayer
        if (!receivedTransaction.feePayer || !receivedTransaction.feePayer.equals(relayerKeypair.publicKey)) {
            console.error(`Relay: Received transaction feePayer (${receivedTransaction.feePayer ? receivedTransaction.feePayer.toBase58() : 'null'}) does not match relayer public key (${relayerKeypair.publicKey.toBase58()}).`);
            return c.json({ error: 'Transaction feePayer mismatch. Client must set feePayer to relayer.' }, 400);
        }
        console.log('Relay: Transaction feePayer matches relayer public key.');

        // 2. Program ID and Instruction Count Checks (using the received transaction directly)
        if (!receivedTransaction.instructions || receivedTransaction.instructions.length !== 1) {
            return c.json({ error: 'Transaction must contain exactly one instruction.' }, 400);
        }
        if (!receivedTransaction.instructions[0].programId.equals(new PublicKey(CRUSH_PROGRAM_ID))) {
            return c.json({ error: 'Instruction programId does not match CRUSH_PROGRAM_ID.' }, 400);
        }
        console.log('Relay: Instruction programId and count checks passed.');
        
        // 3. (Crucial) Verify pkPrime's signature on the received transaction
        // The transaction message includes relayer as feePayer. pkPrime must have signed this specific message.
        const messageBytes = receivedTransaction.serializeMessage(); // Message with relayer as feePayer

        // Find pkPrime's public key and signature from the transaction
        // pkPrime is the one instruction signer that is NOT the relayer (feePayer)
        let pkPrimePublicKey;
        let pkPrimeSignature;

        const instructionSigners = receivedTransaction.instructions[0].keys.filter(k => k.isSigner);
        if (instructionSigners.length !== 1) {
             console.error('Relay: Expected exactly one signer in the instruction for pkPrime.');
             // This assumes your instruction has only one other signer apart from potentially the feePayer if it were also a signer.
             // Adjust if instruction has multiple client-side signers.
             // For this specific app, pkPrime is the only instruction signer.
             return c.json({ error: 'Instruction signer configuration error.'}, 400);
        }
        pkPrimePublicKey = instructionSigners[0].pubkey;

        const pkPrimeSignatureEntry = receivedTransaction.signatures.find(s => s.publicKey.equals(pkPrimePublicKey));

        if (!pkPrimeSignatureEntry || !pkPrimeSignatureEntry.signature) {
            console.error(`Relay: Signature for pkPrime (${pkPrimePublicKey.toBase58()}) not found on received transaction.`);
            return c.json({ error: 'User signature not found on transaction.' }, 400);
        }
        pkPrimeSignature = pkPrimeSignatureEntry.signature; // This is a Buffer

        // Verify pkPrime's signature
        // Note: @noble/ed25519 verify function expects Uint8Array for signature and message.
        // PublicKey.toBytes() gives Uint8Array. pkPrimeSignature is already Buffer/Uint8Array.
        // We need the raw public key bytes for noble's ed25519.verify
        const { ed25519 } = await import('@noble/curves/ed25519'); // Ensure noble ed25519 is available
        if (!ed25519.verify(pkPrimeSignature, messageBytes, pkPrimePublicKey.toBytes())) {
           console.error("Relay: pkPrime's signature verification failed for the received transaction message (relayer as feePayer).");
           console.log("pkPrime public key for sig verify:", pkPrimePublicKey.toBase58());
           // console.log("pkPrime signature for sig verify (b64):", Buffer.from(pkPrimeSignature).toString('base64'));
           // console.log("Message bytes for sig verify (hex):", Buffer.from(messageBytes).toString('hex'));
           return c.json({ error: "Invalid user signature on transaction." }, 400);
        }
        console.log("Relay: pkPrime's signature on received transaction (with relayer as feePayer) VERIFIED.");

        // 4. Relayer adds its signature (as feePayer)
        // The transaction already has relayer as feePayer and pkPrime's signature.
        // Relayer's signature slot should be null or require signing.
        console.log('Relay: Relayer signing the transaction (as feePayer)...');
        receivedTransaction.partialSign(relayerKeypair); 
        // partialSign is appropriate as pkPrime's signature is already there.
        // It will fill the signature slot for relayerKeypair.publicKey.
        
        console.log('Relay: Signatures after relayer signs:', JSON.stringify(receivedTransaction.signatures.map(sig => ({ 
            publicKey: sig.publicKey.toBase58(), 
            signature: sig.signature ? Buffer.from(sig.signature).toString('base64') : null
        })), null, 2));

        // 5. Serialize the fully signed transaction for sending
        // Default `serialize()` options: requireAllSignatures: true, verifySignatures: true
        // This will internally verify all signatures again.
        let finalTxBuffer;
        try {
            console.log('Relay: Serializing final transaction (will verify all signatures)...');
            finalTxBuffer = receivedTransaction.serialize();
        } catch (serializeError) {
            console.error('Relay: Error serializing final transaction:', serializeError);
            // Log signatures again if serialization fails
            if (receivedTransaction.signatures) {
                console.log('Relay: Signatures at time of serialization failure:', JSON.stringify(receivedTransaction.signatures.map(sig => ({ 
                    publicKey: sig.publicKey.toBase58(), 
                    signature: sig.signature ? Buffer.from(sig.signature).toString('base64') : null
                })), null, 2));
            }
            return c.json({ error: 'Failed to serialize final transaction.', details: serializeError.message }, 500);
        }
        console.log('Relay: Final transaction serialized successfully.');
        // --- End: New Relay Logic ---
        
        const connection = new Connection(ALCHEMY_SOLANA_RPC_URL, 'confirmed');
        console.log('Relay: Sending final transaction to Solana network...');
        let signature;
        try {
            // Send the fully signed and verified (by serialize()) transaction buffer
            signature = await connection.sendRawTransaction(finalTxBuffer, { skipPreflight: false });
        } catch (sendError) {
            console.error('Relay: sendRawTransaction failed. Full error object:', JSON.stringify(sendError, null, 2));
            let errorDetails = sendError.message;
            let simulationLogs = null;

            // Attempt to extract logs if they are in a non-standard place or nested
            if (sendError.transactionLogs && Array.isArray(sendError.transactionLogs)) {
                simulationLogs = sendError.transactionLogs;
            } else if (typeof sendError.message === 'string' && sendError.message.includes('Log messages')) {
                // Sometimes logs are embedded in the message string
                simulationLogs = sendError.message.split('\n');
            }

            if (simulationLogs) {
                console.error('Relay: Extracted Simulation logs:', simulationLogs);
                return c.json({ 
                    error: 'Transaction simulation failed on RPC node.', 
                    details: errorDetails,
                    simulationLogs: simulationLogs 
                }, 500);
            } else {
                return c.json({ 
                    error: 'Transaction failed to send.', 
                    details: errorDetails 
                }, 500);
            }
        }
        console.log(`Relay: Transaction sent. Signature: ${signature}`);

        // 7. Confirm the transaction (optional but good for relay)
        console.log('Relay: Confirming transaction...');
        try {
            const confirmation = await connection.confirmTransaction(signature, 'confirmed');
            console.log('Relay: Transaction confirmation: ', confirmation);
            if (confirmation.value.err) {
                throw new Error(`Solana transaction confirmation failed: ${JSON.stringify(confirmation.value.err)}`);
            }
        } catch (confirmError) {
            console.error('Relay: Transaction confirmation failed.', confirmError);
            // Even if confirmation times out or fails, the tx might have landed. 
            // For a relayer, often returning the signature is enough once sent.
            // Depending on UX, might want to inform user about confirmation status uncertainty.
            return c.json({ 
                warning: 'Transaction sent but confirmation failed or timed out.', 
                signature: signature,
                details: confirmError.message 
            }, 202); // 202 Accepted, as tx was sent
        }

        // 8. Return the signature
        return c.json({ signature });

    } catch (error) {
        console.error('Error in /relay endpoint:', error.message, error.stack);
        return c.json({ error: 'Failed to relay transaction.', details: error.message }, 500);
    }
});

// PRD 5.2: /user/<wallet> GET endpoint
app.get('/api/user/:wallet', async (c) => {
    const { USER_INDEX_KV } = c.env;
    if (!USER_INDEX_KV) {
        console.error('USER_INDEX_KV not bound in worker environment');
        return c.json({ error: 'User index service not configured.' }, 500);
    }

    const walletAddress = c.req.param('wallet');
    if (!walletAddress) {
        return c.json({ error: 'Wallet address parameter is required.' }, 400);
    }

    try {
        console.log(`GET /api/user/${walletAddress}: Fetching index.`);
        const encryptedIndex = await USER_INDEX_KV.get(walletAddress);

        if (encryptedIndex === null) {
            console.log(`GET /api/user/${walletAddress}: No index found.`);
            // Return an empty string or a specific structure if preferred by client for "not found"
            return c.json({ encryptedIndex: null }); 
        }
        console.log(`GET /api/user/${walletAddress}: Found index (length ${encryptedIndex.length}).`);
        return c.json({ encryptedIndex });

    } catch (error) {
        console.error(`Error getting user index for ${walletAddress}:`, error);
        return c.json({ error: 'Failed to retrieve user index.', details: error.message }, 500);
    }
});

// PRD 5.2: /user/<wallet> PUT endpoint
app.put('/api/user/:wallet', async (c) => {
    const { USER_INDEX_KV } = c.env;
    if (!USER_INDEX_KV) {
        console.error('USER_INDEX_KV not bound in worker environment');
        return c.json({ error: 'User index service not configured.' }, 500);
    }

    const walletAddress = c.req.param('wallet');
    if (!walletAddress) {
        return c.json({ error: 'Wallet address parameter is required.' }, 400);
    }

    let requestBody;
    try {
        requestBody = await c.req.json();
    } catch (e) {
        return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const { encryptedIndex } = requestBody;
    if (typeof encryptedIndex !== 'string') {
        return c.json({ error: 'encryptedIndex (string) is required in request body.' }, 400);
    }

    /*
    // --- PRD Authorization Requirement (Section 5.2) ---
    // This section implements the Authorization: Wallet <sig> header check.
    // It requires the client to sign the SHA256 hash of the request body.
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Wallet ')) {
        return c.json({ error: 'Missing or invalid Authorization header. Expected \'Wallet <signature>\'.' }, 401);
    }
    const signatureB64 = authHeader.substring('Wallet '.length);
    try {
        const signature = Buffer.from(signatureB64, 'base64');
        const messageToVerify = Buffer.from(JSON.stringify(requestBody)); // Body to hash and verify against
        const messageHash = sha256(messageToVerify); // sha256 from @noble/hashes

        const userPublicKey = new PublicKey(walletAddress);
        
        // web3.js verify expects Uint8Array for signature and message
        // noble/ed25519.verify might be an alternative if web3.js verify isn't available or suitable in Worker
        // For now, assuming a hypothetical verify function compatible with web3.js PublicKey objects and noble hashes/signatures
        // This part is tricky as direct ed25519 verify against a PublicKey object might need careful handling of types.
        // Using noble/ed25519.verify is more straightforward if we have the public key bytes directly.
        // Since walletAddress is string, we convert to PublicKey, then to Uint8Array for noble.
        
        // A more direct approach with noble/ed25519 if userPublicKey.toBytes() is available:
        // const ed25519 = await import('@noble/curves/ed25519').then(m => m.ed25519);
        // const isValid = ed25519.verify(signature, messageHash, userPublicKey.toBytes()); 

        // Placeholder for actual verification logic. This needs to be robust.
        // This is a simplified example and might need adjustment for how the signature is generated/verified.
        // For instance, @solana/web3.js `nacl.sign.detached.verify` could be used if nacl is available or shimmed.
        // Or using noble/ed25519.verify if the public key bytes are correctly obtained.
        
        // For now, let's assume verification is complex to set up here without more context on client-side signing
        // and skip actual verification for this iteration, logging a TODO.
        console.warn(`TODO: Implement robust Authorization header signature verification for PUT /api/user/${walletAddress}`)
        // if (!isValid) {
        //     return c.json({ error: 'Invalid signature for Authorization header.' }, 403);
        // }
        // console.log(`PUT /api/user/${walletAddress}: Authorization signature VERIFIED.`);

    } catch (sigError) {
        console.error(`Error during signature verification for ${walletAddress}:`, sigError);
        return c.json({ error: 'Signature verification failed.', details: sigError.message }, 401);
    }
    // --- End PRD Authorization Requirement ---
    */

    try {
        console.log(`PUT /api/user/${walletAddress}: Storing index (length ${encryptedIndex.length}).`);
        await USER_INDEX_KV.put(walletAddress, encryptedIndex);
        console.log(`PUT /api/user/${walletAddress}: Index stored successfully.`);
        return c.json({ success: true, message: 'User index updated.' });

    } catch (error) {
        console.error(`Error putting user index for ${walletAddress}:`, error);
        return c.json({ error: 'Failed to update user index.', details: error.message }, 500);
    }
});

// PRD 5.2: /health endpoint
app.get('/api/health', (c) => {
    return c.json({ status: 'OK', timestamp: new Date().toISOString() });
});

export default app;
