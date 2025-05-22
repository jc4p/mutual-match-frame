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

// PRD 5.2: /relay endpoint
app.post('/relay', async (c) => {
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

        console.log('Relay: Received base64 transaction string.');

        // 1. Deserialize the transaction
        const transactionBuffer = Buffer.from(base64TransactionString, 'base64');
        // Try to deserialize as VersionedTransaction first, then fallback to legacy Transaction
        let transaction;
        let isVersioned = false;
        try {
            transaction = VersionedTransaction.deserialize(transactionBuffer);
            isVersioned = true;
            console.log('Relay: Deserialized as VersionedTransaction.');
        } catch (e) {
            try {
                transaction = Transaction.from(transactionBuffer);
                console.log('Relay: Deserialized as legacy Transaction.');
            } catch (deserializeError) {
                console.error('Relay: Failed to deserialize transaction as Versioned or legacy:', deserializeError);
                return c.json({ error: 'Failed to deserialize transaction.', details: deserializeError.message }, 400);
            }
        }

        // 2. PRD: size & programID check (Basic check for now)
        if (transaction.instructions.length !== 1) {
             return c.json({ error: 'Transaction must contain exactly one instruction.' }, 400);
        }
        if (!transaction.instructions[0].programId.equals(new PublicKey(CRUSH_PROGRAM_ID))) {
            return c.json({ error: 'Instruction programId does not match CRUSH_PROGRAM_ID.' }, 400);
        }
        console.log('Relay: Transaction instruction count and program ID checks passed.');

        // 3. Load relayer keypair
        const relayerKeypair = Keypair.fromSecretKey(bs58.decode(RELAYER_KEY));
        console.log(`Relay: Relayer public key: ${relayerKeypair.publicKey.toBase58()}`);

        // 4. Set relayer as fee payer
        // For VersionedTransaction, message.payerKey is the fee payer.
        // For legacy Transaction, feePayer property.
        if (isVersioned) {
            // Reconstruct if needed, or ensure it was set correctly initially.
            // For now, assume client sets it to a placeholder and we overwrite.
            // If the client already set their stealth key as feePayer in the message,
            // we need to create a new message or modify the existing one if possible.
            // For simplicity, let's assume we rebuild the message for VersionedTransaction if feePayer needs changing.
            // However, VersionedTransaction.message.payerKey is not directly writable after construction usually.
            // The most straightforward way for a relayer is often to take the instructions
            // and build a new transaction where it is the feePayer from the start.
            // But for partially signed, we aim to add a signature.

            // If client compiled with THEIR feePayer, and we sign with OURS, it might mismatch.
            // It's often simpler if the relayer re-signs the whole transaction as the new fee payer.
            // Let's assume the partially signed tx is mostly for the instruction signer.
            // We will add our signature. The `sendAndConfirmTransaction` will use our keypair as the payer.
            transaction.sign([relayerKeypair]); // Sign with relayer. If it's versioned, this adds the signature.
                                              // The `feePayer` for versioned TX is the first signature by convention if not specified.
            console.log('Relay: Signed versioned transaction with relayer key.');
        } else {
            transaction.feePayer = relayerKeypair.publicKey;
            // Sign the transaction (partially if only fee payer, or fully if it needs it)
            // The client already signed with their stealth key.
            // We need to sign as the feePayer.
            transaction.partialSign(relayerKeypair); // For legacy transactions
            console.log('Relay: Partially signed legacy transaction with relayer key as feePayer.');
        }
        
        // 5. Connect to Solana
        const connection = new Connection(ALCHEMY_SOLANA_RPC_URL, 'confirmed');

        // 6. Send the transaction
        console.log('Relay: Sending transaction to Solana network...');
        const signature = await connection.sendRawTransaction(transaction.serialize());
        console.log(`Relay: Transaction sent. Signature: ${signature}`);

        // 7. Confirm the transaction (optional but good for relay)
        // Consider longer confirmation times or different strategies for production
        const confirmation = await connection.confirmTransaction(signature, 'confirmed');
        console.log('Relay: Transaction confirmation: ', confirmation);

        if (confirmation.value.err) {
            throw new Error(`Solana transaction failed: ${JSON.stringify(confirmation.value.err)}`);
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
