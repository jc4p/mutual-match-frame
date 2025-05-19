import './style.css';
import * as frame from '@farcaster/frame-sdk';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import bs58 from 'bs58';

const API_ROOT = 'https://mutual-match-api.kasra.codes';

console.log("Encrypted Mutual Match App Initializing...");

// --- Debug Console Start ---
let debugConsoleVisible = true;
const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

function addLogToDebugConsole(message, level = 'log') {
    const consoleContent = document.getElementById('debug-console-content');
    if (consoleContent) {
        const entry = document.createElement('div');
        entry.classList.add('debug-entry', `debug-${level}`);
        
        let displayMessage = message;
        if (typeof message === 'object') {
            try {
                displayMessage = JSON.stringify(message, (key, value) =>
                    typeof value === 'bigint' ? value.toString() + 'n' : // Convert BigInts for JSON.stringify
                    value instanceof Uint8Array ? `Uint8Array(${value.length})[${bytesToHex(value.slice(0,16))}...]` :
                    value,
                2);
            } catch (e) {
                displayMessage = '[Unserializable Object]';
            }
        }
        entry.textContent = `[${new Date().toLocaleTimeString()}] [${level.toUpperCase()}] ${displayMessage}`;
        consoleContent.appendChild(entry);
        consoleContent.scrollTop = consoleContent.scrollHeight; // Auto-scroll
    }
}

console.log = function(...args) {
    originalConsole.log(...args);
    addLogToDebugConsole(args.length === 1 ? args[0] : args, 'log');
};
console.warn = function(...args) {
    originalConsole.warn(...args);
    addLogToDebugConsole(args.length === 1 ? args[0] : args, 'warn');
};
console.error = function(...args) {
    originalConsole.error(...args);
    addLogToDebugConsole(args.length === 1 ? args[0] : args, 'error');
};

function initDebugConsole() {
    const style = document.createElement('style');
    style.textContent = `
        #debug-console-floater {
            position: fixed;
            bottom: 10px;
            right: 10px;
            width: 350px;
            max-height: 250px;
            background-color: rgba(0,0,0,0.85);
            color: white;
            border: 1px solid #444;
            border-radius: 5px;
            font-family: monospace;
            font-size: 12px;
            z-index: 9999;
            display: flex;
            flex-direction: column;
            box-shadow: 0 0 10px rgba(0,0,0,0.5);
        }
        #debug-console-header {
            background-color: #333;
            padding: 5px 8px;
            cursor: grab;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #444;
        }
        #debug-console-header span { font-weight: bold; }
        #debug-console-toggle, #debug-console-clear {
            background: #555;
            color: white;
            border: 1px solid #777;
            border-radius: 3px;
            padding: 2px 5px;
            cursor: pointer;
            margin-left: 5px;
        }
        #debug-console-toggle:hover, #debug-console-clear:hover { background: #777; }
        #debug-console-content {
            padding: 8px;
            overflow-y: auto;
            flex-grow: 1;
            height: 200px; /* Default height when expanded */
        }
        .debug-entry { 
            padding: 2px 0;
            border-bottom: 1px dotted #555;
            word-break: break-all;
        }
        .debug-entry:last-child { border-bottom: none; }
        .debug-warn { color: #ffdd57; }
        .debug-error { color: #ff3860; }
        #debug-console-floater.minimized #debug-console-content { display: none; }
        #debug-console-floater.minimized { max-height: 35px; height: 35px; }
    `;
    document.head.appendChild(style);

    const floater = document.createElement('div');
    floater.id = 'debug-console-floater';
    floater.innerHTML = `
        <div id="debug-console-header">
            <span>Debug Console</span>
            <div>
                <button id="debug-console-clear">Clear</button>
                <button id="debug-console-toggle">Minimize</button>
            </div>
        </div>
        <div id="debug-console-content"></div>
    `;
    document.body.appendChild(floater);

    const toggleButton = document.getElementById('debug-console-toggle');
    toggleButton.addEventListener('click', () => {
        debugConsoleVisible = !debugConsoleVisible;
        floater.classList.toggle('minimized', !debugConsoleVisible);
        toggleButton.textContent = debugConsoleVisible ? 'Minimize' : 'Maximize';
    });

    document.getElementById('debug-console-clear').addEventListener('click', () => {
        const consoleContent = document.getElementById('debug-console-content');
        if (consoleContent) consoleContent.innerHTML = '';
        addLogToDebugConsole('Console cleared.', 'info');
    });
    console.log("Debug console initialized.");
}
// --- Debug Console End ---

// User Flow (from PRD 3):
// 1. Open Mini-App -> wallet prompt appears once -> user signs constant "farcaster-crush-v1".

// We will need a way to interact with a wallet.
// The PRD mentions `walletProvider.signMessage`.
// The Farcaster SDK provides this via sdk.experimental.getSolanaProvider()

// Store kWallet, publicKey, and selected target user in memory for the session
let sessionKWallet = null;
let sessionPublicKey = null;
let selectedTargetUser = null; // To store { fid, username, display_name, pfp_url, primary_sol_address }
let solanaProvider = null; // Moved to higher scope

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
        const apiUrl = `${API_ROOT}/api/search-users?q=${encodeURIComponent(query)}`;
        console.log(`Fetching from: ${apiUrl}`); // Log the URL for debugging
        const response = await fetch(apiUrl);
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
                        primary_sol_address: primarySolAddress
                    };
                    console.log("Selected target user:", selectedTargetUser);
                    resultsDiv.innerHTML = `
                        <p>Selected: <strong>${selectedTargetUser.display_name}</strong> (@${selectedTargetUser.username})</p>
                        <p>Target Solana Address (edPubTarget): ${selectedTargetUser.primary_sol_address}</p>
                        <p>Ready to derive stealth key and proceed.</p>
                        <button id="sendCrushBtn">Send Secret Crush</button>
                    `;
                    document.getElementById('userSearchInput').value = '';
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
    console.log("--- connectAndSign called ---");
    // frame.sdk and solanaProvider are now logged earlier (on DOMContentLoaded)
    // We will use the module-scoped solanaProvider here.

    console.log("frame.sdk:", frame.sdk);
    console.log("frame.sdk.experimental:", frame.sdk.experimental);

    const contentDiv = document.getElementById('content');
    const statusMessageDiv = document.getElementById('statusMessage');

    if (!contentDiv || !statusMessageDiv) {
        console.error("UI elements (content/statusMessage) not found");
        return null;
    }

    if (!solanaProvider) {
        console.error("Solana provider was not initialized earlier. Cannot proceed with connectAndSign.");
        statusMessageDiv.innerHTML = '<p>Error: Solana Wallet Provider not available.</p>';
        contentDiv.innerHTML = '<p>Please ensure your Farcaster client is set up correctly. Check debug console.</p>';
        return null;
    }
    console.log("Using pre-initialized Solana Provider:", solanaProvider);
    statusMessageDiv.innerHTML = "<p>Connecting to wallet...</p>";

    try {
        // publicKey acquisition, signing etc. using the existing solanaProvider variable
        let publicKey;
        if (solanaProvider.publicKey) {
            publicKey = solanaProvider.publicKey;
            console.log("Using existing publicKey from provider:", publicKey?.toString());
        } else if (typeof solanaProvider.connect === 'function') {
            try {
                console.log("Attempting solanaProvider.connect()...");
                statusMessageDiv.innerHTML = "<p>Awaiting wallet connection approval...</p>";
                const connectionResponse = await solanaProvider.connect(); // Might prompt user
                console.log("solanaProvider.connect() response:", connectionResponse);
                publicKey = connectionResponse?.publicKey || solanaProvider.publicKey;
            } catch (connectError) {
                console.error("Error connecting to Solana wallet via provider.connect():", connectError);
                statusMessageDiv.innerHTML = `<p>Error connecting to wallet.</p>`;
                contentDiv.innerHTML = `<p>${connectError.message}. You might need to approve the connection in your Farcaster client.</p>`;
                return null;
            }
        } else {
            console.warn("Solana provider has no publicKey and no connect method. Unable to get publicKey.");
        }

        if (!publicKey) {
            console.error("Could not get publicKey from Solana provider.");
            statusMessageDiv.innerHTML = '<p>Error: Could not get public key.</p>';
            contentDiv.innerHTML = '<p>Wallet might not be connected or approved. Check your Farcaster client and debug console.</p>';
            return null;
        }
        
        const publicKeyBs58 = bs58.encode(publicKey.toBytes());
        console.log("Successfully obtained publicKey:", publicKeyBs58);
        statusMessageDiv.innerHTML = `<p>Wallet connected: ${publicKeyBs58.slice(0,4)}...${publicKeyBs58.slice(-4)}. Signing message...</p>`;

        const messageString = "farcaster-crush-v1";
        const message = new TextEncoder().encode(messageString);
        console.log(`Attempting to sign message: "${messageString}"`);
        const signedMessageResult = await solanaProvider.signMessage(message, "utf8");
        console.log("signMessage result:", signedMessageResult);
        
        let signature;
        if (signedMessageResult && signedMessageResult.signature instanceof Uint8Array) {
            signature = signedMessageResult.signature;
        } else if (signedMessageResult instanceof Uint8Array) {
            signature = signedMessageResult; 
        } else {
            console.error("Unexpected signature format from signMessage:", signedMessageResult);
            statusMessageDiv.innerHTML = '<p>Error: Unexpected signature format.</p>';
            contentDiv.innerHTML = '<p>Received an unexpected signature format from the wallet.</p>';
            return null;
        }

        if (signature.length !== 64) {
            console.warn(`Expected signature length 64 from signMessage, got ${signature.length}.`);
        }

        const kWallet = sha256(signature);
        sessionKWallet = kWallet;
        sessionPublicKey = publicKey; // Store the actual PublicKey object

        console.log('Raw signature (first 16 bytes hex):', bytesToHex(signature.slice(0,16)));
        console.log('kWallet (hex, first 8 bytes):', bytesToHex(kWallet.slice(0,8)));
        
        statusMessageDiv.innerHTML = `<p>Successfully signed message and derived kWallet!</p>`;
        
        contentDiv.innerHTML = `
            <p>Your Public Key: ${publicKeyBs58}</p>
            <p>kWallet derived. You can now search for a user to send a secret crush.</p>
            <p><small>Raw Signature (first 16B hex): ${bytesToHex(signature.slice(0,16))}</small></p>
            <p><small>kWallet (first 8B hex): ${bytesToHex(kWallet.slice(0,8))}</small></p>
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
        console.error("Error in connectAndSign process:", error);
        statusMessageDiv.innerHTML = `<p>Error: ${error.message}.</p>`;
        contentDiv.innerHTML = `<p>See debug console for more details. Ensure your Farcaster wallet is set up and active.</p>`;
        return null;
    }
}

function initializeApp() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initDebugConsole);
    } else {
        initDebugConsole();
    }

    const appDiv = document.getElementById('app');
    if (appDiv) {
        appDiv.innerHTML = `
            <h1>Encrypted Mutual Match</h1>
            <div id="statusMessage"><p>App Initialized. Farcaster SDK loading...</p></div>
            <button id="connectWalletBtn">Connect Wallet & Sign</button>
            <div id="content">
                <p>Please wait for Farcaster SDK to be ready.</p>
            </div>
        `;
        const connectButton = document.getElementById('connectWalletBtn');
        if (connectButton) {
            connectButton.addEventListener('click', connectAndSign);
        }
    } else {
        console.error("Could not find #app element in HTML.");
    }
}

initializeApp();

document.addEventListener('DOMContentLoaded', async () => {
    console.log("DOMContentLoaded event fired. Farcaster SDK (frame.sdk):", frame.sdk);
    await frame.sdk.actions.ready();
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
