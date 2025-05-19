import './style.css';
import * as frame from '@farcaster/frame-sdk';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import bs58 from 'bs58';

// User Flow (from PRD 3):
// 1. Open Mini-App -> wallet prompt appears once -> user signs constant "farcaster-crush-v1".

// We will need a way to interact with a wallet.
// The PRD mentions `walletProvider.signMessage`.
// The Farcaster SDK provides this via sdk.experimental.getSolanaProvider()

// Store kWallet, publicKey, and selected target user in memory for the session
let sessionKWallet = null;
let sessionPublicKey = null;
let selectedTargetUser = null; // To store { fid, username, display_name, pfp_url, primary_sol_address }

// Debounce utility
function debounce(func, delay) {
    let timeoutId;
    return function(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

async function searchUsers(query) {
    const resultsDiv = document.getElementById('searchResults');
    if (!query || query.length < 2) {
        resultsDiv.innerHTML = '<p><small>Enter at least 2 characters to search.</small></p>';
        return;
    }
    resultsDiv.innerHTML = '<p>Searching...</p>';

    try {
        // Assuming your Cloudflare worker (api/src/index.js) is served at the same origin or proxied
        // If it's on a different port during local dev (e.g. 8787 for worker, 5173 for vite dev server)
        // you might need to use the full URL e.g. http://localhost:8787/api/search-users
        const response = await fetch(`/api/search-users?q=${encodeURIComponent(query)}`);
        if (!response.ok) {
            const errData = await response.json();
            console.error("Search API error:", errData);
            resultsDiv.innerHTML = `<p>Error searching users: ${errData.error || response.statusText}</p>`;
            return;
        }
        const data = await response.json();
        if (data.users && data.users.length > 0) {
            resultsDiv.innerHTML = data.users.map(user => `
                <div class="search-result-item" 
                     data-fid="${user.fid}" 
                     data-username="${user.username}" 
                     data-displayname="${user.display_name}"
                     data-pfpurl="${user.pfp_url}"
                     data-primarysoladdress="${user.primary_sol_address || ''}">
                    <img src="${user.pfp_url}" alt="${user.username}" width="40" height="40" style="border-radius: 50%; margin-right: 10px;">
                    <div>
                        <strong>${user.display_name}</strong> (@${user.username})<br>
                        <small>FID: ${user.fid}${user.primary_sol_address ? ' (SOL verified)' : ' (No primary SOL)'}</small>
                    </div>
                </div>
            `).join('');

            document.querySelectorAll('.search-result-item').forEach(item => {
                item.addEventListener('click', () => {
                    const primarySolAddress = item.dataset.primarysoladdress;
                    if (!primarySolAddress) {
                        resultsDiv.innerHTML = `
                            <p>Selected: <strong>${item.dataset.displayname}</strong> (@${item.dataset.username})</p>
                            <p style="color: red;">This user does not have a verified primary Solana address. Cannot proceed with crush.</p>
                            <p><button id="searchAgainBtn">Search Again</button></p>
                        `;
                        document.getElementById('searchAgainBtn').addEventListener('click', () => {
                             document.getElementById('userSearchInput').value = '';
                             resultsDiv.innerHTML = ''; // Clear selection message
                        });
                        selectedTargetUser = null; // Clear previous selection
                        return;
                    }

                    selectedTargetUser = {
                        fid: parseInt(item.dataset.fid),
                        username: item.dataset.username,
                        display_name: item.dataset.displayname,
                        pfp_url: item.dataset.pfpurl,
                        primary_sol_address: primarySolAddress // This is our edPubTarget
                    };
                    console.log("Selected target user:", selectedTargetUser);
                    resultsDiv.innerHTML = `
                        <p>Selected: <strong>${selectedTargetUser.display_name}</strong> (@${selectedTargetUser.username})</p>
                        <p>Target Solana Address (edPubTarget): ${selectedTargetUser.primary_sol_address}</p>
                        <p>Ready to derive stealth key and proceed.</p>
                        <button id="sendCrushBtn">Send Secret Crush</button>
                    `;
                    document.getElementById('userSearchInput').value = ''; // Clear search input
                    document.getElementById('sendCrushBtn').addEventListener('click', handleSendCrush);
                });
            });
        } else {
            resultsDiv.innerHTML = '<p>No users found for that query.</p>';
        }
    } catch (error) {
        console.error("Failed to fetch or parse search results:", error);
        resultsDiv.innerHTML = '<p>An error occurred while searching. Check console.</p>';
    }
}

const debouncedSearchUsers = debounce(searchUsers, 300);

// Placeholder for wallet interaction and signing
async function connectAndSign() {
    console.log("Attempting to connect wallet and sign message using Farcaster SDK...");
    const contentDiv = document.getElementById('content');
    const statusMessageDiv = document.getElementById('statusMessage');

    if (!contentDiv || !statusMessageDiv) {
        console.error("UI elements (content/statusMessage) not found");
        return null;
    }
    statusMessageDiv.innerHTML = "<p>Connecting to wallet...</p>";

    try {
        const solanaProvider = frame.sdk.experimental.getSolanaProvider();
        if (!solanaProvider) {
            console.error("Solana provider not available through Farcaster SDK.");
            statusMessageDiv.innerHTML = '<p>Error: Solana wallet provider not found.</p>';
            contentDiv.innerHTML = '<p>Please ensure your Farcaster client supports this feature and your wallet is connected.</p>';
            return null;
        }

        let publicKey;
        if (solanaProvider.publicKey) {
            publicKey = solanaProvider.publicKey;
        } else if (typeof solanaProvider.connect === 'function') {
            try {
                statusMessageDiv.innerHTML = "<p>Awaiting wallet connection approval...</p>";
                const connectionResponse = await solanaProvider.connect();
                publicKey = connectionResponse?.publicKey || solanaProvider.publicKey;
            } catch (connectError) {
                console.error("Error connecting to Solana wallet:", connectError);
                statusMessageDiv.innerHTML = `<p>Error connecting to wallet.</p>`;
                contentDiv.innerHTML = `<p>${connectError.message}. You might need to approve the connection in your Farcaster client.</p>`;
                return null;
            }
        }

        if (!publicKey) {
            console.error("Could not get publicKey from Solana provider.");
            statusMessageDiv.innerHTML = '<p>Error: Could not get public key.</p>';
            contentDiv.innerHTML = '<p>Wallet might not be connected or approved. Please check your Farcaster client.</p>';
            return null;
        }
        
        const publicKeyBs58 = bs58.encode(publicKey.toBytes());
        console.log("Connected with publicKey:", publicKeyBs58);
        statusMessageDiv.innerHTML = `<p>Wallet connected: ${publicKeyBs58.slice(0,4)}...${publicKeyBs58.slice(-4)}. Signing message...</p>`;

        const messageString = "farcaster-crush-v1";
        const message = new TextEncoder().encode(messageString);
        const signedMessageResult = await solanaProvider.signMessage(message, "utf8");
        
        let signature;
        if (signedMessageResult && signedMessageResult.signature instanceof Uint8Array) {
            signature = signedMessageResult.signature;
        } else if (signedMessageResult instanceof Uint8Array) {
            signature = signedMessageResult; 
        } else {
            console.error("Unexpected signature format:", signedMessageResult);
            statusMessageDiv.innerHTML = '<p>Error: Unexpected signature format.</p>';
            contentDiv.innerHTML = '<p>Received an unexpected signature format from the wallet.</p>';
            return null;
        }

        if (signature.length !== 64) {
            console.warn(`Expected signature length 64, got ${signature.length}. Proceeding, but this might be an issue.`);
        }

        const kWallet = sha256(signature);
        sessionKWallet = kWallet;
        sessionPublicKey = publicKey;

        console.log('Raw signature (first 16 bytes hex):', bytesToHex(signature.slice(0,16)));
        console.log('kWallet (hex, first 8 bytes):', bytesToHex(kWallet.slice(0,8)));
        
        statusMessageDiv.innerHTML = `<p>Successfully signed message and derived kWallet!</p>`;
        
        // Update UI to show search input instead of follow list message
        contentDiv.innerHTML = `
            <p>Your Public Key: ${publicKeyBs58}</p>
            <p>kWallet derived. You can now search for a user to send a secret crush.</p>
            <input type="text" id="userSearchInput" placeholder="Search Farcaster users...">
            <div id="searchResults"></div>
        `;
        document.getElementById('userSearchInput').addEventListener('input', (e) => {
            debouncedSearchUsers(e.target.value);
        });
        
        const connectButton = document.getElementById('connectWalletBtn');
        if(connectButton) connectButton.style.display = 'none';

        return { kWallet, publicKey };

    } catch (error) {
        console.error("Error during Farcaster signing process:", error);
        statusMessageDiv.innerHTML = `<p>Error: ${error.message}.</p>`;
        contentDiv.innerHTML = `<p>See console for more details. Ensure your Farcaster wallet is set up and active.</p>`;
        return null;
    }
}

// Initialize application
function initializeApp() {
    const appDiv = document.getElementById('app');
    if (appDiv) {
        appDiv.innerHTML = `
            <h1>Encrypted Mutual Match</h1>
            <div id="statusMessage"><p>Connect your wallet to begin.</p></div>
            <button id="connectWalletBtn">Connect Wallet & Sign</button>
            <div id="content">
                <!-- Dynamic content will go here: follow list, crush status, etc. -->
            </div>
        `;
        const connectButton = document.getElementById('connectWalletBtn');
        if (connectButton) {
            connectButton.addEventListener('click', async () => {
                const result = await connectAndSign(); // connectAndSign now updates the UI directly
                if (result && result.kWallet && result.publicKey) {
                    console.log("kWallet and PublicKey obtained. Search UI is now active.");
                }
            });
        }
        document.getElementById('content').innerHTML = '<p>Please connect your wallet and sign the message to start.</p>';
    } else {
        console.error("Could not find #app element in HTML.");
    }
}

initializeApp();

document.addEventListener('DOMContentLoaded', async () => {
    await frame.sdk.actions.ready()
});

// Further steps from PRD section 4.2 (Front-End Requirements - Key steps per crush)
// will be implemented subsequently. This includes:
// - Stealth key derivation (needs kWallet from the signing step)
// - ECDH
// - Symmetric key & tag
// - Encrypt payload
// - Partial Tx build
// - POST /relay
// - Update index

// We will also need the @noble/* crypto libraries mentioned in PRD 4.1.
// Please run:
// npm install @noble/hashes @noble/ed25519 @noble/curves
// You might need an additional library for XChaCha20-Poly1305.

async function handleSendCrush() {
    if (!selectedTargetUser || !selectedTargetUser.primary_sol_address) {
        alert("No target user with a Solana address selected!");
        return;
    }
    if (!sessionKWallet) {
        alert("kWallet not available. Please connect and sign first.");
        return;
    }

    const edPubTarget = selectedTargetUser.primary_sol_address;
    // For Solana addresses (bs58 encoded strings), they first need to be decoded to a Uint8Array to be used as a public key.
    // Noble libraries typically expect Uint8Array for keys.
    let edPubTargetBytes;
    try {
        edPubTargetBytes = bs58.decode(edPubTarget);
        if (edPubTargetBytes.length !== 32) {
            throw new Error(`Invalid public key length: ${edPubTargetBytes.length}. Expected 32.`);
        }
    } catch(e) {
        console.error("Invalid target Solana address (edPubTarget):", edPubTarget, e);
        alert("The target user\'s Solana address appears invalid. Cannot proceed.");
        return;
    }

    console.log("Initiating crush sequence with:");
    console.log("kWallet (first 8B hex):", bytesToHex(sessionKWallet.slice(0,8)));
    console.log("edPubTarget (bs58):", edPubTarget);
    console.log("edPubTarget (bytes, first 8B hex):", bytesToHex(edPubTargetBytes.slice(0,8)));

    const statusDiv = document.getElementById('searchResults'); // Reuse searchResults for status
    statusDiv.innerHTML = "<p>Processing your secret crush... Generating keys...</p>";

    // PRD 4.2: Key steps per crush
    // 1. Stealth key derivation: seed = HMAC-SHA256(kWallet, edPubTarget) sk' = seed, pk' = ed25519.getPublicKey(sk')
    // TODO: Implement with noble libraries
    // const { skPrime, pkPrime } = await deriveStealthKey(sessionKWallet, edPubTargetBytes);
    // statusDiv.innerHTML = `<p>Processing... Stealth key derived: ${bytesToHex(pkPrime.slice(0,8))}...</p>`;

    // 2. ECDH: convert edPubTarget -> xPubT, xPrivS = edToCurve(sk'), shared = scalarMult(xPrivS,xPubT)
    // TODO: Implement with noble libraries (requires ed25519-to-x25519 helper, etc.)
    // const sharedSecret = await performECDH(skPrime, edPubTargetBytes);
    // statusDiv.innerHTML = `<p>Processing... Shared secret calculated.</p>`;

    // 3. Symmetric key & tag: K = SHA256(shared||"pair"), tag = SHA256("tag"||K)
    // TODO: Implement with noble libraries
    // const { K_AB, tag } = await deriveSymmetricKeyAndTag(sharedSecret);
    // statusDiv.innerHTML = `<p>Processing... Symmetric key and tag generated. Tag: ${bytesToHex(tag.slice(0,8))}...</p>`;

    // 4. Encrypt payload: XChaCha20-Poly1305; nonce=24B. Payload = two FIDs + optional note
    // TODO: Implement with noble/ciphers
    // const myFid = getMyFid(); // Need a way to get own FID (from FrameSDK context or user input)
    // const targetFid = selectedTargetUser.fid;
    // const note = ""; // Optional note
    // const cipher = await encryptPayload(K_AB, myFid, targetFid, note);
    // statusDiv.innerHTML = `<p>Processing... Payload encrypted.</p>`;

    // 5. Partial Tx build: Fee-payer blank; instruction = submit_crush(cipher)
    // TODO: Implement Solana transaction building (manually or with a lightweight library)
    // const transaction = await buildPartialTransaction(pkPrime, cipher); // pkPrime is the signer here
    // statusDiv.innerHTML = `<p>Processing... Partial transaction built.</p>`;

    // 6. POST /relay: {tx:base64}
    // TODO: Implement API call to your /relay endpoint (not yet defined in api/src/index.js)
    // const relayResponse = await postToRelay(transaction);
    // statusDiv.innerHTML = `<p>Crush sent to relay! Signature: ${relayResponse.signature}</p>`;
    
    // For now, simulate completion
    setTimeout(() => {
         statusDiv.innerHTML = `<p>Simulated Crush Sent to ${selectedTargetUser.display_name}!</p><p>This is where actual crypto would happen.</p><p>Next: Implement actual crypto, tx building, and relay.</p>`;
    }, 1000);
    alert("Crush sequence initiated (currently simulated). Check console for details and TODOs.");
}
