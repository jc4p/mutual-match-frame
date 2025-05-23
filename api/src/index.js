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
		// console.log(`Proxying RPC request to: ${ALCHEMY_SOLANA_RPC_URL}`/*, JSON.stringify(requestBody)*/); // Avoid logging potentially large bodies unless debugging

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
		// console.log(`Alchemy response status: ${alchemyResponse.status}`);

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

        // console.log('Relay: Received base64 transaction string for new relay logic.');

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
            // console.log('Relay: Successfully deserialized received transaction.');
        } catch (deserializeError) {
            // console.error('Relay: Failed to deserialize received transaction:', deserializeError);
            return c.json({ error: 'Failed to deserialize transaction.', details: deserializeError.message }, 400);
        }

        if (isReceivedVersioned) {
            // This simplified relay logic is primarily for legacy transactions where feePayer is set by client.
            // console.error('Relay: Received a VersionedTransaction. This relay path is optimized for legacy transactions with client-set relayer feePayer.');
            return c.json({ error: 'Versioned transactions need a different relay handling for fee substitution.' }, 400);
        }

        // --- Start: New Relay Logic for Legacy Transactions ---
        // console.log('Relay: Applying new relay logic for legacy transaction.');

        const relayerKeypair = Keypair.fromSeed(bs58.decode(RELAYER_KEY));

        // 1. Verify the transaction's feePayer is the relayer
        if (!receivedTransaction.feePayer || !receivedTransaction.feePayer.equals(relayerKeypair.publicKey)) {
            console.error(`Relay: Received transaction feePayer (${receivedTransaction.feePayer ? receivedTransaction.feePayer.toBase58() : 'null'}) does not match relayer public key (${relayerKeypair.publicKey.toBase58()}).`);
            return c.json({ error: 'Transaction feePayer mismatch. Client must set feePayer to relayer.' }, 400);
        }
        // console.log('Relay: Transaction feePayer matches relayer public key.');

        // 2. Program ID and Instruction Count Checks (using the received transaction directly)
        if (!receivedTransaction.instructions || receivedTransaction.instructions.length !== 1) {
            return c.json({ error: 'Transaction must contain exactly one instruction.' }, 400);
        }
        if (!receivedTransaction.instructions[0].programId.equals(new PublicKey(CRUSH_PROGRAM_ID))) {
            return c.json({ error: 'Instruction programId does not match CRUSH_PROGRAM_ID.' }, 400);
        }
        // console.log('Relay: Instruction programId and count checks passed.');
        
        // 3. (Crucial) Verify pkPrime's signature on the received transaction
        // The transaction message includes relayer as feePayer. pkPrime must have signed this specific message.
        const messageBytes = receivedTransaction.serializeMessage(); // Message with relayer as feePayer

        // Identify pkPrime's public key and the relayer's public key from the instruction's signers.
        // The instruction for submit_crush expects two signers:
        // 1. user_signer (pkPrime)
        // 2. relayer (which is also the transaction feePayer)
        let pkPrimePublicKey;
        let instructionRelayerPublicKey;

        const instructionAccountMetas = receivedTransaction.instructions[0].keys;
        const instructionSignerMetas = instructionAccountMetas.filter(k => k.isSigner);

        if (instructionSignerMetas.length !== 2) {
             console.error(`Relay: Expected exactly two signers in the instruction's accounts. Found ${instructionSignerMetas.length}.`);
             return c.json({ error: 'Instruction signer configuration error: Incorrect number of signers in instruction accounts.'}, 400);
        }

        // Iterate through the signers in the instruction to identify pkPrime and the relayer
        // pkPrime is the signer that is NOT the overall transaction feePayer (relayerKeypair.publicKey)
        // The other signer in the instruction MUST be the relayerKeypair.publicKey
        let foundPkPrime = false;
        let foundInstructionRelayer = false;

        for (const signerMeta of instructionSignerMetas) {
            if (signerMeta.pubkey.equals(relayerKeypair.publicKey)) {
                instructionRelayerPublicKey = signerMeta.pubkey;
                foundInstructionRelayer = true;
            } else {
                // This must be pkPrime
                if (pkPrimePublicKey) { // Should not find a second non-relayer signer
                    console.error('Relay: Found multiple potential pkPrime signers in the instruction.');
                    return c.json({ error: 'Instruction signer configuration error: Ambiguous pkPrime.' }, 400);
                }
                pkPrimePublicKey = signerMeta.pubkey;
                foundPkPrime = true;
            }
        }

        if (!foundPkPrime) {
            console.error('Relay: pkPrime (user_signer) not found as a signer in the instruction accounts.');
            return c.json({ error: 'Instruction signer configuration error: pkPrime missing from instruction signers.' }, 400);
        }
        if (!foundInstructionRelayer) {
            console.error('Relay: Relayer not found as a signer in the instruction accounts, but was expected.');
            // This case should ideally be caught if feePayer is relayer and instruction has 2 signers, one of which isn't relayer.
            // Adding for robustness.
            return c.json({ error: 'Instruction signer configuration error: Relayer missing from instruction signers.' }, 400);
        }
        
        // console.log(`Relay: Identified pkPrimePublicKey: ${pkPrimePublicKey.toBase58()} and instructionRelayerPublicKey: ${instructionRelayerPublicKey.toBase58()}`);

        // Find pkPrime's signature on the overall transaction
        const pkPrimeSignatureEntry = receivedTransaction.signatures.find(s => s.publicKey.equals(pkPrimePublicKey));
        let pkPrimeSignature;

        if (!pkPrimeSignatureEntry || !pkPrimeSignatureEntry.signature) {
            console.error(`Relay: Signature for pkPrime (${pkPrimePublicKey.toBase58()}) not found on received transaction.`);
            return c.json({ error: 'User signature not found on transaction.' }, 400);
        }
        pkPrimeSignature = pkPrimeSignatureEntry.signature; // This is a Buffer

        // Verify pkPrime's signature
        // Note: @noble/ed25519 verify function expects Uint8Array for signature and message.
        // PublicKey.toBytes() gives Uint8Array. pkPrimeSignature is already Buffer/Uint8Array.
        // We need the raw public key bytes for noble's ed25519.verify
        const { ed25519 } = await import('@noble/curves/ed25519');
        if (!ed25519.verify(pkPrimeSignature, messageBytes, pkPrimePublicKey.toBytes())) {
           console.error("Relay: pkPrime's signature verification failed for the received transaction message (relayer as feePayer).");
        //    console.log("pkPrime public key for sig verify:", pkPrimePublicKey.toBase58());
           // console.log("pkPrime signature for sig verify (b64):", Buffer.from(pkPrimeSignature).toString('base64'));
           // console.log("Message bytes for sig verify (hex):", Buffer.from(messageBytes).toString('hex'));
           return c.json({ error: "Invalid user signature on transaction." }, 400);
        }
        // console.log("Relay: pkPrime's signature on received transaction (with relayer as feePayer) VERIFIED.");

        // 4. Relayer adds its signature (as feePayer)
        // The transaction already has relayer as feePayer and pkPrime's signature.
        // Relayer's signature slot should be null or require signing.
        // console.log('Relay: Relayer signing the transaction (as feePayer)...');
        receivedTransaction.partialSign(relayerKeypair); 
        // partialSign is appropriate as pkPrime's signature is already there.
        // It will fill the signature slot for relayerKeypair.publicKey.
        
        // console.log('Relay: Signatures after relayer signs:', JSON.stringify(receivedTransaction.signatures.map(sig => ({ 
        //     publicKey: sig.publicKey.toBase58(), 
        //     signature: sig.signature ? Buffer.from(sig.signature).toString('base64') : null
        // })), null, 2));

        // 5. Serialize the fully signed transaction for sending
        // Default `serialize()` options: requireAllSignatures: true, verifySignatures: true
        // This will internally verify all signatures again.
        let finalTxBuffer;
        try {
            // console.log('Relay: Serializing final transaction (will verify all signatures)...');
            finalTxBuffer = receivedTransaction.serialize();
        } catch (serializeError) {
            // console.error('Relay: Error serializing final transaction:', serializeError);
            // Log signatures again if serialization fails
            if (receivedTransaction.signatures) {
                console.log('Relay: Signatures at time of serialization failure:', JSON.stringify(receivedTransaction.signatures.map(sig => ({ 
                    publicKey: sig.publicKey.toBase58(), 
                    signature: sig.signature ? Buffer.from(sig.signature).toString('base64') : null
                })), null, 2));
            }
            return c.json({ error: 'Failed to serialize final transaction.', details: serializeError.message }, 500);
        }
        // console.log('Relay: Final transaction serialized successfully.');
        // --- End: New Relay Logic ---
        
        const connection = new Connection(ALCHEMY_SOLANA_RPC_URL, 'confirmed');
        // console.log('Relay: Sending final transaction to Solana network...');
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
        // console.log(`Relay: Transaction sent. Signature: ${signature}`);

        // 8. Return the signature immediately after sending
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
        console.log(`GET /api/user/${walletAddress}: Fetching user data.`);
        // User data might include encryptedIndex and appPublicKeyHex
        const userDataString = await USER_INDEX_KV.get(walletAddress);

        if (userDataString === null) {
            console.log(`GET /api/user/${walletAddress}: No data found.`);
            return c.json({ encryptedIndex: null, appPublicKeyHex: null }, 404); // Return 404 and specific structure
        }
        
        const userData = JSON.parse(userDataString); // Assuming stored as JSON string
        console.log(`GET /api/user/${walletAddress}: Found user data.`);
        return c.json({ 
            encryptedIndex: userData.encryptedIndex || null,
            appPublicKeyHex: userData.appPublicKeyHex || null 
        });

    } catch (error) {
        console.error(`Error getting user data for ${walletAddress}:`, error);
        // If JSON parsing fails or other error
        if (error instanceof SyntaxError) {
            console.warn(`GET /api/user/${walletAddress}: Data found but couldn't parse as JSON. Returning raw string if it exists or null.`);
            // Attempt to return raw if it was a string, otherwise indicate error.
            // This path is tricky; ideally, data is always valid JSON or null.
            // For now, let's assume if it's not JSON, it's an older format or corrupted.
             const rawDataFallback = await USER_INDEX_KV.get(walletAddress); // re-fetch raw
             if (rawDataFallback && typeof rawDataFallback === 'string' && !rawDataFallback.startsWith('{')) {
                // If it looks like an old encryptedIndex string (not JSON)
                console.log(`GET /api/user/${walletAddress}: Returning raw data as likely old format encryptedIndex.`);
                return c.json({ encryptedIndex: rawDataFallback, appPublicKeyHex: null });
             }
        }
        return c.json({ error: 'Failed to retrieve or parse user data.', details: error.message }, 500);
    }
});

// New endpoint to get just the app public key
app.get('/api/user/:wallet/app-pubkey', async (c) => {
    const { USER_INDEX_KV } = c.env;
    if (!USER_INDEX_KV) {
        return c.json({ error: 'User index service not configured.' }, 500);
    }
    const walletAddress = c.req.param('wallet');
    if (!walletAddress) {
        return c.json({ error: 'Wallet address parameter is required.' }, 400);
    }
    try {
        const userDataString = await USER_INDEX_KV.get(walletAddress);
        if (userDataString === null) {
            return c.json({ error: 'User not found or app key not set.' }, 404);
        }
        const userData = JSON.parse(userDataString);
        
        // Support both old format (single key) and new format (multiple keys)
        if (userData.appPublicKeyHex) {
            // Old format - return the single key
            return c.json({ appPublicKeyHex: userData.appPublicKeyHex });
        } else if (userData.appPublicKeys && userData.appPublicKeys.length > 0) {
            // New format - return the most recent key (last in array)
            const latestKey = userData.appPublicKeys[userData.appPublicKeys.length - 1];
            return c.json({ appPublicKeyHex: latestKey.publicKeyHex });
        } else {
            return c.json({ error: 'App public key not set for this user.' }, 404);
        }
    } catch (error) {
        console.error(`Error getting app public key for ${walletAddress}:`, error);
        return c.json({ error: 'Failed to retrieve app public key.', details: error.message }, 500);
    }
});

// New endpoint to get all app public keys for a user
app.get('/api/user/:wallet/all-app-pubkeys', async (c) => {
    const { USER_INDEX_KV } = c.env;
    if (!USER_INDEX_KV) {
        return c.json({ error: 'User index service not configured.' }, 500);
    }
    const walletAddress = c.req.param('wallet');
    if (!walletAddress) {
        return c.json({ error: 'Wallet address parameter is required.' }, 400);
    }
    try {
        const userDataString = await USER_INDEX_KV.get(walletAddress);
        if (userDataString === null) {
            return c.json({ error: 'User not found.' }, 404);
        }
        const userData = JSON.parse(userDataString);
        
        const allKeys = [];
        
        // Include old format key if it exists
        if (userData.appPublicKeyHex) {
            allKeys.push({
                publicKeyHex: userData.appPublicKeyHex,
                version: 'v1',
                createdAt: userData.appPublicKeyCreatedAt || null
            });
        }
        
        // Include new format keys
        if (userData.appPublicKeys && Array.isArray(userData.appPublicKeys)) {
            allKeys.push(...userData.appPublicKeys);
        }
        
        return c.json({ appPublicKeys: allKeys });
    } catch (error) {
        console.error(`Error getting all app public keys for ${walletAddress}:`, error);
        return c.json({ error: 'Failed to retrieve app public keys.', details: error.message }, 500);
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

    const { encryptedIndex, appPublicKeyHex, appKeyVersion } = requestBody;

    // Validate inputs: encryptedIndex can be null if only updating appPublicKeyHex,
    // and appPublicKeyHex can be null if only updating encryptedIndex.
    // However, at least one should be present for a meaningful PUT.
    // For this app, encryptedIndex is typically a string. appPublicKeyHex is also a string.
    if (typeof encryptedIndex !== 'string' && encryptedIndex !== null && encryptedIndex !== undefined) {
        return c.json({ error: 'encryptedIndex must be a string or null.' }, 400);
    }
    if (typeof appPublicKeyHex !== 'string' && appPublicKeyHex !== null && appPublicKeyHex !== undefined) {
        return c.json({ error: 'appPublicKeyHex must be a string or null.' }, 400);
    }
    if ((encryptedIndex === null || encryptedIndex === undefined) && (appPublicKeyHex === null || appPublicKeyHex === undefined)) {
         return c.json({ error: 'Either encryptedIndex or appPublicKeyHex must be provided.' }, 400);
    }


    try {
        // Fetch existing data to merge, or start fresh
        let existingData = {};
        const existingDataString = await USER_INDEX_KV.get(walletAddress);
        if (existingDataString) {
            try {
                existingData = JSON.parse(existingDataString);
            } catch (e) {
                // If existing data is not JSON (e.g., old format, just a string for encryptedIndex)
                // Treat it as if only encryptedIndex was stored.
                if (typeof existingDataString === 'string' && !existingDataString.startsWith('{')) {
                    console.warn(`PUT /api/user/${walletAddress}: Existing data is not JSON, treating as old encryptedIndex string.`);
                    existingData = { encryptedIndex: existingDataString, appPublicKeyHex: null };
                } else {
                    console.error(`PUT /api/user/${walletAddress}: Failed to parse existing JSON data. Overwriting might occur if not careful. Error: ${e.message}`);
                    // Decide on a strategy: error out, or overwrite. For now, let's allow targeted update.
                    existingData = {}; // Reset to avoid partial corruption if parsing failed badly
                }
            }
        }
        
        // Migrate old format to new format if needed
        if (existingData.appPublicKeyHex && !existingData.appPublicKeys) {
            console.log(`PUT /api/user/${walletAddress}: Migrating from old key format to new format`);
            existingData.appPublicKeys = [{
                publicKeyHex: existingData.appPublicKeyHex,
                version: 'v1',
                createdAt: existingData.appPublicKeyCreatedAt || new Date().toISOString()
            }];
            // Don't delete the old field yet for backwards compatibility
        }
        
        // Update fields if provided in the request
        const dataToStore = { ...existingData };
        
        if (encryptedIndex !== undefined) { // Allows explicit null to clear
            dataToStore.encryptedIndex = encryptedIndex;
        }
        
        if (appPublicKeyHex !== undefined && appPublicKeyHex !== null) {
            // Initialize appPublicKeys array if it doesn't exist
            if (!dataToStore.appPublicKeys) {
                dataToStore.appPublicKeys = [];
            }
            
            // Check if this key already exists
            const keyExists = dataToStore.appPublicKeys.some(key => key.publicKeyHex === appPublicKeyHex);
            
            if (!keyExists) {
                // Add new key with version info
                dataToStore.appPublicKeys.push({
                    publicKeyHex: appPublicKeyHex,
                    version: appKeyVersion || 'v2', // Default to v2 for new keys
                    createdAt: new Date().toISOString()
                });
                
                // Also update the legacy field for backwards compatibility
                dataToStore.appPublicKeyHex = appPublicKeyHex;
                dataToStore.appPublicKeyCreatedAt = new Date().toISOString();
            }
        }

        console.log(`PUT /api/user/${walletAddress}: Storing user data with ${dataToStore.appPublicKeys ? dataToStore.appPublicKeys.length : 0} app keys`);
        await USER_INDEX_KV.put(walletAddress, JSON.stringify(dataToStore));
        console.log(`PUT /api/user/${walletAddress}: User data stored successfully.`);
        return c.json({ success: true, message: 'User data updated.' });

    } catch (error) {
        console.error(`Error putting user data for ${walletAddress}:`, error);
        return c.json({ error: 'Failed to update user data.', details: error.message }, 500);
    }
});

// PRD 5.2: /health endpoint
app.get('/api/health', (c) => {
    return c.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// New endpoint for the client to poll transaction status
app.get('/api/transaction-status', async (c) => {
    const { ALCHEMY_SOLANA_RPC_URL } = c.env;
    if (!ALCHEMY_SOLANA_RPC_URL) {
        console.error('ALCHEMY_SOLANA_RPC_URL not configured for transaction-status check.');
        return c.json({ error: 'Service not configured' }, 500);
    }

    const signature = c.req.query('signature');
    if (!signature) {
        return c.json({ error: 'Missing \'signature\' query parameter' }, 400);
    }

    try {
        const connection = new Connection(ALCHEMY_SOLANA_RPC_URL, 'confirmed');
        console.log(`Polling status for signature: ${signature}`);
        
        // getSignatureStatuses takes an array of signatures
        const result = await connection.getSignatureStatus(signature, {
            searchTransactionHistory: true, // Important for finding older transactions
        });

        console.log(`Signature status for ${signature}:`, JSON.stringify(result, null, 2));

        if (!result) {
            // Signature not found, could be still processing or never landed
            return c.json({ signature, status: 'notFound' });
        }

        let simplifiedStatus = 'pending'; // Default assumption
        if (result.value) {
            if (result.value.err) {
                simplifiedStatus = 'failed';
                return c.json({ 
                    signature, 
                    status: simplifiedStatus, 
                    error: result.value.err, 
                    confirmationStatus: result.value.confirmationStatus 
                });
            }
            // Possible confirmation statuses: 'processed', 'confirmed', 'finalized'
            if (result.value.confirmationStatus === 'finalized') {
                simplifiedStatus = 'finalized';
            } else if (result.value.confirmationStatus === 'confirmed') {
                simplifiedStatus = 'confirmed';
            } else if (result.value.confirmationStatus === 'processed') {
                simplifiedStatus = 'processed';
            }
            return c.json({ 
                signature, 
                status: simplifiedStatus, 
                confirmationStatus: result.value.confirmationStatus 
            });
        } else {
             // Fallback if result.value is null but result itself is not (should be caught by !result earlier)
            return c.json({ signature, status: 'notFoundOrPending' });
        }

    } catch (error) {
        console.error(`Error fetching transaction status for ${signature}:`, error);
        return c.json({ error: 'Failed to fetch transaction status', details: error.message }, 500);
    }
});

export default app;
