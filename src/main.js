import './style.css';
import * as frame from '@farcaster/frame-sdk';
import { sha256 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import { ed25519, x25519, edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import { concatBytes, randomBytes, bytesToHex as nobleBytesToHex, hexToBytes as nobleHexToBytes, utf8ToBytes, bytesToUtf8 } from '@noble/hashes/utils'; // For randomBytes (nonce) and concatBytes
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'; 
import { gcm } from '@noble/ciphers/aes';
import bs58 from 'bs58';
import * as borsh from '@coral-xyz/borsh'; // Added Borsh
import {
    Connection,
    PublicKey,
    Transaction,
    TransactionInstruction,
    SystemProgram, // If needed for PDA creation or other system calls
    // Message, // If constructing manually, less likely now
} from '@solana/web3.js';
import { Buffer } from 'buffer'; // Import Buffer

const API_ROOT = 'https://mutual-match-api.kasra.codes';
const SOLANA_RPC_URL = `${API_ROOT}/api/solana-rpc`; 
const CRUSH_PROGRAM_ID = new PublicKey('GSAh2GuhF6niNFhwV4Yd2Kbd18m3N7a6ysaseCrQiKy7'); // Updated Program ID

// Alias noble functions to avoid name clashes if any, and for consistency
const bytesToHex = nobleBytesToHex;
const hexToBytes = nobleHexToBytes;

console.log("Encrypted Mutual Match App Initializing...");

// --- Debug Console Start ---
let debugConsoleVisible = false;
const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

function updateStatusMessage(message, isError = false) {
    const statusMessageDiv = document.getElementById('statusMessage');
    if (statusMessageDiv) {
        statusMessageDiv.innerHTML = `<p${isError ? ' style="color:red;"' : ''}>${message}</p>`;
    }
    if (isError) console.error("Status Update (Error):", message);
    else console.log("Status Update:", message);
}

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
    
    // Set initial state based on debugConsoleVisible
    floater.classList.toggle('minimized', !debugConsoleVisible);
    toggleButton.textContent = debugConsoleVisible ? 'Minimize' : 'Maximize';
    
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

// Store kWallet, kIndex, publicKey, and selected target user in memory for the session
let sessionKWallet = null;
let sessionKIndex = null; // Will be derived from kWallet
let sessionPublicKey = null;
let selectedTargetUser = null; // To store { fid, username, display_name, pfp_url, primary_sol_address }
let relayerPublicKeyString = null; // Variable to store relayer's public key

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
        resultsDiv.classList.remove('populated'); // Remove when prompt is shown
        return;
    }
    resultsDiv.innerHTML = '<p>Searching...</p>';
    resultsDiv.classList.add('populated'); // Add when search starts

    try {
        const apiUrl = `${API_ROOT}/api/search-users?q=${encodeURIComponent(query)}`;
        console.log(`Fetching from: ${apiUrl}`); // Log the URL for debugging
        const response = await fetch(apiUrl);
        if (!response.ok) {
            const errData = await response.json();
            console.error("Search API error:", errData);
            resultsDiv.innerHTML = `<p>Error searching users: ${errData.error || response.statusText}</p>`;
            resultsDiv.classList.add('populated'); // Ensure populated on error
            return;
        }
        const data = await response.json();
        if (data.users && data.users.length > 0) {
            resultsDiv.classList.add('populated'); // Ensure populated with results
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
                        resultsDiv.classList.add('populated'); // Ensure populated
                        document.getElementById('searchAgainBtn').addEventListener('click', () => {
                             document.getElementById('userSearchInput').value = '';
                             resultsDiv.innerHTML = ''; // Clear selection message
                             resultsDiv.classList.remove('populated'); // Remove on clear
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
                        <p>Ready to derive stealth key and proceed.</p>
                        <button id="sendCrushBtn">Send Secret Crush</button>
                    `;
                    resultsDiv.classList.add('populated'); // Ensure populated
                    document.getElementById('userSearchInput').value = '';
                    document.getElementById('sendCrushBtn').addEventListener('click', handleSendCrush);
                });
            });
        } else {
            resultsDiv.innerHTML = '<p>No users found for that query.</p>';
            resultsDiv.classList.add('populated'); // Ensure populated for "no users"
        }
    } catch (error) {
        console.error("Failed to fetch or parse search results:", error);
        resultsDiv.innerHTML = '<p>An error occurred while searching. Check console.</p>';
        resultsDiv.classList.add('populated'); // Ensure populated on error
    }
}

const debouncedSearchUsers = debounce(searchUsers, 300);

// Function to fetch relayer's public key
async function fetchRelayerPublicKey() {
    if (relayerPublicKeyString) return relayerPublicKeyString; // Return cached key if available

    console.log("Fetching relayer public key from /api/config...");
    try {
        const response = await fetch(`${API_ROOT}/api/config`);
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(`Failed to fetch relayer config: ${errData.error || response.statusText}`);
        }
        const configData = await response.json();
        if (!configData.relayerPublicKey) {
            throw new Error("Relayer public key not found in config response.");
        }
        relayerPublicKeyString = configData.relayerPublicKey;
        console.log("Relayer public key fetched and cached:", relayerPublicKeyString);
        return relayerPublicKeyString;
    } catch (error) {
        console.error("Error fetching relayer public key:", error);
        updateStatusMessage("Error fetching relayer configuration. Cannot proceed.", true);
        throw error; // Re-throw to stop further execution in handleSendCrush
    }
}

// Placeholder for wallet interaction and signing
async function connectAndSign() {
    console.log("--- connectAndSign called ---");

    const contentDiv = document.getElementById('content');
    updateStatusMessage("Attempting to get Solana Provider...");

    let solanaProvider = null;
    try {
        solanaProvider = await frame.sdk.experimental.getSolanaProvider();

        if (!solanaProvider) {
            console.error("await frame.sdk.experimental.getSolanaProvider() returned null or undefined.");
            updateStatusMessage('Error: Solana Wallet Provider not available.', true);
            if(contentDiv) contentDiv.innerHTML = '<p>Please ensure your Farcaster client is set up correctly.</p>';
            return null;
        }
        
        updateStatusMessage("Solana Provider found! Connecting to wallet...");

        let publicKeyString; 
        try {
            updateStatusMessage("Awaiting wallet connection approval...");
            const connectionResponse = await solanaProvider.request({ method: 'connect' });
            publicKeyString = connectionResponse?.publicKey
            console.log('publicKeyString:', publicKeyString);
        } catch (connectError) {
            console.error("Error connecting to Solana wallet:", connectError);
            updateStatusMessage('Error connecting to wallet.', true);
            if(contentDiv) contentDiv.innerHTML = `<p>${connectError.message}. You might need to approve the connection.</p>`;
            return null;
        }

        if (!publicKeyString || typeof publicKeyString !== 'string') {
            console.error("Could not get publicKey as a string from Solana provider. Received:", publicKeyString);
            updateStatusMessage('Error: Could not get public key string.', true);
            if(contentDiv) contentDiv.innerHTML = '<p>Wallet might not be connected/approved or provider returned unexpected format.</p>';
            return null;
        }
        
        console.log("Successfully obtained publicKey string:", publicKeyString);
        updateStatusMessage(`Wallet connected: ${publicKeyString.slice(0,4)}...${publicKeyString.slice(-4)}. Signing message...`);

        const messageString = "This is a message to confirm you are logging into encrypted mutual match using your Warplet!";
        console.log(`Attempting to sign message: "${messageString}"`);
        const signedMessageResult = await solanaProvider.signMessage(messageString);
        console.log("signMessage result:", signedMessageResult);
        
        let signature;
        const signatureString = signedMessageResult.signature;

        if (signedMessageResult && typeof signatureString === 'string') {
            let decodedSuccessfully = false;

            try {
                const decodedBs58 = bs58.decode(signatureString);
                if (decodedBs58.length === 64) {
                    signature = decodedBs58;
                    decodedSuccessfully = true;
                    console.log("Successfully decoded signature as Base58.");
                } else {
                    console.warn(`Base58 decoded signature has length ${decodedBs58.length}, expected 64. Will try Base64.`);
                }
            } catch (bs58Error) {
                console.log("Could not decode signature as Base58, trying Base64. (BS58 Error: ", bs58Error.message, ")");
            }

            if (!decodedSuccessfully) {
                try {
                    const binaryString = atob(signatureString);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }

                    if (bytes.length === 64) {
                        signature = bytes;
                        decodedSuccessfully = true;
                        console.log("Successfully decoded signature as Base64.");
                    } else {
                        console.error(`Base64 decoded signature has length ${bytes.length}, expected 64. Original string: ${signatureString}`);
                    }
                } catch (b64Error) {
                    console.error("Failed to decode signature as Base64 after Base58 attempt. Error:", b64Error.message, "Original string:", signatureString);
                }
            }

            if (!decodedSuccessfully) {
                 console.error("Could not decode signature as Base58 or Base64 to a 64-byte array. Original string:", signatureString);
                 updateStatusMessage('Error: Could not decode signature.', true);
                 if(contentDiv) contentDiv.innerHTML = '<p>The signature format from the wallet was undecodable or incorrect length.</p>';
                 return null;
            }
        } else {
            console.error("Unexpected signature format from signMessage. Expected an object with a string 'signature' property. Received:", signedMessageResult);
            updateStatusMessage('Error: Unexpected signature format.', true);
            if(contentDiv) contentDiv.innerHTML = '<p>Received an unexpected signature format from the wallet for the message signature.</p>';
            return null;
        }

        if (!signature || signature.length === 0) {
             console.error("Signature is null or empty after processing.");
             updateStatusMessage('Error: Signature processing failed.', true);
             return null;
        }

        sessionKWallet = sha256(signature);
        sessionPublicKey = publicKeyString; 

        // Derive kIndex PRD 4.2: kIndex = SHA256("HOT" || kWallet)
        const hotPrefix = utf8ToBytes("HOT");
        sessionKIndex = sha256(concatBytes(hotPrefix, sessionKWallet));

        console.log('Raw signature (first 16 bytes hex): ', bytesToHex(signature.slice(0,16)));
        console.log('kWallet (hex, first 8 bytes):', bytesToHex(sessionKWallet.slice(0,8)));
        console.log('kIndex (hex, first 8 bytes):', bytesToHex(sessionKIndex.slice(0,8)));
        
        updateStatusMessage(`Signed in! Wallet: ${publicKeyString.slice(0,4)}...${publicKeyString.slice(-4)}`);
        
        if(contentDiv) contentDiv.innerHTML = `
            <p>Welcome! Search for a user to send a secret crush.</p>
            <input type="text" id="userSearchInput" class="user-search-input" placeholder="Search by username...">
            <div id="searchResults" class="search-results-container"></div>
            <div id="userIndexContainerPlaceholder"></div>
        `;
        document.getElementById('userSearchInput').addEventListener('input', (e) => {
            debouncedSearchUsers(e.target.value);
        });
        
        const connectButton = document.getElementById('connectWalletBtn');
        if(connectButton) connectButton.style.display = 'none';

        // Attempt to load existing index from API after successful login
        await loadAndDisplayUserIndex();

        // Fetch relayer public key after successful sign-in
        try {
            await fetchRelayerPublicKey();
        } catch (e) {
            // Error already handled and displayed by fetchRelayerPublicKey
            return null; // Prevent further app operation if config fails
        }

        return { kWallet: sessionKWallet, publicKey: sessionPublicKey, kIndex: sessionKIndex }; 

    } catch (error) {
        console.error("Error in connectAndSign process:", error);
        updateStatusMessage(`Error: ${error.message}.`, true);
        if(contentDiv) contentDiv.innerHTML = `<p>See debug console for details. Ensure your Farcaster wallet is set up.</p>`;
        return null;
    }
}

function initializeApp() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initDebugConsole();
            initHowItWorksModal(); // Initialize modal controls
            populateHowItWorksModal(); // Populate modal content
        });
    } else {
        initDebugConsole();
        initHowItWorksModal();
        populateHowItWorksModal();
    }

    const appDiv = document.getElementById('app');
    if (appDiv) {
        // Step A: Initial Welcome Screen
        appDiv.innerHTML = `
            <div id="statusMessage"><p>Ready.</p></div>
            <div id="content">
                <h3>Fully encrypted and private onchain crushes.</h3>
                <p>Find out if your Farcaster crush is mutual, discreetly.</p>
                <p>Click below to get started by connecting your wallet and signing a message to generate your app-specific keys.</p>
                <button id="getStartedBtn">Get Started & Authenticate</button>
            </div>
        `;

        // Step B: Triggering Wallet Connection
        const getStartedButton = document.getElementById('getStartedBtn');
        if (getStartedButton) {
            getStartedButton.addEventListener('click', () => {
                // Optionally hide or disable the button to prevent multiple clicks
                getStartedButton.disabled = true; 
                getStartedButton.textContent = 'Loading...';
                
                // Clear initial welcome message from content, connectAndSign will populate it
                const contentDiv = document.getElementById('content');
                if(contentDiv) {
                    contentDiv.innerHTML = '<p>Initializing connection...</p>';
                }
                connectAndSign();
            });
        }
    } else {
        console.error("Could not find #app element in HTML.");
    }
}

// --- How It Works Modal Logic ---
function populateHowItWorksModal() {
    const modalContent = document.getElementById('howItWorksModalContent');
    if (modalContent) {
        // Find the existing h2 and insert content after it
        const h2 = modalContent.querySelector('h2');
        const closeButton = modalContent.querySelector('#howItWorksCloseBtn');
        
        const contentHtml = `
        <p>Mutual Match allows Farcaster users to discreetly signal interest in someone. If the interest is mutual, both users are notified. Otherwise, your secret is safe!</p>

        <h3>How It Works (Summary)</h3>
        <ul>
            <li>✍️ <strong>Sign In:</strong> You sign a message with your wallet – this keeps your main Farcaster account details separate and generates a special key for this app.</li>
            <li>🤫 <strong>Express a Crush:</strong> You pick someone you follow. The app uses clever cryptography to prepare your 'crush' message.</li>
            <li>🔒 <strong>Encryption Magic:</strong> Your choice is encrypted using keys that only you and your potential crush can generate if you <em>both</em> express interest. The server or anyone else can't read it.</li>
            <li>🔗 <strong>Onchain (but private!):</strong> An encrypted piece of data is sent to the Solana blockchain. This data doesn't reveal who you are or who you crushed on.</li>
            <li>🎉 <strong>Mutual Match:</strong> If the person you crushed on also crushes on you using this app, the system detects a match! Both of you will be notified. Otherwise, your crush remains a secret.</li>
        </ul>

        <h3>Security & Privacy</h3>
        <ul>
            <li>🛡️ <strong>Stealthy Transactions:</strong> Your actual wallet address isn't directly linked to the onchain crush data. We use 'stealth keys' for this.</li>
            <li>🔐 <strong>Server Can't Peek:</strong> The list of your crushes stored on our server is encrypted with a key derived from your initial wallet signature. We can't decrypt it.</li>
            <li>🚫 <strong>Not <em>Technically</em> Zero-Knowledge:</strong> While we use strong encryption and privacy techniques, this system isn't strictly 'zero-knowledge' in the formal cryptographic sense. However, it's designed to be highly private and secure for its purpose.</li>
        </ul>

        <h3>Benefits</h3>
        <ul>
            <li>Discreet way to find mutual connections.</li>
            <li>Strong encryption protects your choices.</li>
            <li>Anonymous onchain interactions.</li>
        </ul>
        `;
        
        // Clear existing content except h2 and close button
        while(h2.nextSibling && h2.nextSibling !== closeButton && h2.nextSibling.nextSibling !== null) {
             modalContent.removeChild(h2.nextSibling);
        }
        
        // Insert the new content after the H2
        h2.insertAdjacentHTML('afterend', contentHtml);

    } else {
        console.warn("How It Works modal content area not found.");
    }
}

function initHowItWorksModal() {
    const howItWorksBtn = document.getElementById('howItWorksBtn');
    const howItWorksModalOverlay = document.getElementById('howItWorksModalOverlay');
    const howItWorksCloseBtn = document.getElementById('howItWorksCloseBtn');

    if (howItWorksBtn && howItWorksModalOverlay && howItWorksCloseBtn) {
        howItWorksBtn.addEventListener('click', () => {
            howItWorksModalOverlay.style.display = 'block';
        });

        howItWorksCloseBtn.addEventListener('click', () => {
            howItWorksModalOverlay.style.display = 'none';
        });

        howItWorksModalOverlay.addEventListener('click', (event) => {
            if (event.target === howItWorksModalOverlay) { // Clicked on overlay itself
                howItWorksModalOverlay.style.display = 'none';
            }
        });
        console.log("How It Works modal initialized.");
    } else {
        console.warn("How It Works modal elements not found. Button or modal functionality will be missing.");
    }
}
// --- End How It Works Modal Logic ---

initializeApp();

document.addEventListener('DOMContentLoaded', async () => {
    const statusMessageDiv = document.getElementById('statusMessage');
    const contentDiv = document.getElementById('content');
    
    try {
        if (statusMessageDiv) statusMessageDiv.innerHTML = "<p>Farcaster SDK: Waiting for actions.ready()...</p>";
        await frame.sdk.actions.ready();
        if (statusMessageDiv) { // Check if statusMessageDiv is still valid after innerHTML changes
            const currentStatus = document.getElementById('statusMessage');
            if (currentStatus) currentStatus.innerHTML = "<p>Farcaster SDK Ready. Click 'Get Started' to begin.</p>";
        }
        // No need to update contentDiv here as initializeApp sets the initial welcome screen.
        // The original message "<p>Please click 'Connect Wallet & Sign' to begin.</p>" is now obsolete.

    } catch (error) {
        console.error("Error during Farcaster SDK actions.ready():", error);
        const currentStatus = document.getElementById('statusMessage');
        const currentContent = document.getElementById('content');
        if (currentStatus) currentStatus.innerHTML = "<p>Error initializing Farcaster SDK.</p>";
        if (currentContent) currentContent.innerHTML = "<p>An error occurred with Farcaster SDK. See debug console.</p>";
    }
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

// --- Crypto Helper Functions ---

// PRD 4.2: Stealth key derivation
// seed = HMAC-SHA256(kWallet, edPubTargetBytes)
// sk' = seed
// pk' = ed25519.getPublicKey(sk')
async function deriveStealthKey(kWallet, edPubTargetBytes) {
  console.log("deriveStealthKey: kWallet (hex, first 8B):", bytesToHex(kWallet.slice(0,8)));
  console.log("deriveStealthKey: edPubTargetBytes (hex, first 8B):", bytesToHex(edPubTargetBytes.slice(0,8)));

  const seed = await hmac(sha256, kWallet, edPubTargetBytes); // HMAC-SHA256
  const skPrime = seed; // sk' is the seed itself (32 bytes from SHA256)
  const pkPrime = ed25519.getPublicKey(skPrime);

  console.log("deriveStealthKey: seed / skPrime (hex, first 8B):", bytesToHex(skPrime.slice(0,8)));
  console.log("deriveStealthKey: pkPrime (hex, first 8B):", bytesToHex(pkPrime.slice(0,8)));
  
  if (skPrime.length !== 32) {
    console.error(`deriveStealthKey: skPrime length is ${skPrime.length}, expected 32.`);
    throw new Error("Stealth private key (skPrime) is not 32 bytes.");
  }
  if (pkPrime.length !== 32) {
    console.error(`deriveStealthKey: pkPrime length is ${pkPrime.length}, expected 32.`);
    throw new Error("Stealth public key (pkPrime) is not 32 bytes.");
  }
  
  return { skPrime, pkPrime };
}

// PRD 4.2: ECDH
// convert edPubTarget -> xPubT, xPrivS = edToCurve(sk'), shared = scalarMult(xPrivS,xPubT)
async function performECDH(skPrimeEd, edPubTargetBytes) {
  // Convert Ed25519 private key (skPrimeEd) to X25519 private key (scalar)
  const xPrivS = edwardsToMontgomeryPriv(skPrimeEd); // Using directly imported function
  
  // Convert Ed25519 public key (edPubTargetBytes) to X25519 public key
  const xPubT = edwardsToMontgomeryPub(edPubTargetBytes); // Using directly imported function

  console.log("performECDH: xPrivS (scalar, hex, first 8B):", bytesToHex(xPrivS.slice(0,8)));
  console.log("performECDH: xPubT (X25519 pubkey, hex, first 8B):", bytesToHex(xPubT.slice(0,8)));

  // x25519.getSharedSecret is the correct function from the x25519 object obtained from import { ed25519, x25519 ... }
  const sharedSecret = await x25519.getSharedSecret(xPrivS, xPubT); 
  
  console.log("performECDH: sharedSecret (hex, first 8B):", bytesToHex(sharedSecret.slice(0,8)));
  if (sharedSecret.length !== 32) {
    console.error(`performECDH: sharedSecret length is ${sharedSecret.length}, expected 32.`);
    throw new Error("ECDH shared secret is not 32 bytes.");
  }
  return sharedSecret;
}

// TODO: PRD 4.2: Symmetric key & tag
// K = SHA256(sharedSecret || "pair")
// tag = SHA256("tag" || K_AB)
async function deriveSymmetricKeyAndTag(sharedSecret) {
  const pairSuffix = new TextEncoder().encode("pair");
  const K_AB = sha256(concatBytes(sharedSecret, pairSuffix));

  const tagPrefix = new TextEncoder().encode("tag");
  const tag = sha256(concatBytes(tagPrefix, K_AB));
  
  console.log("deriveSymmetricKeyAndTag: K_AB (hex, first 8B):", bytesToHex(K_AB.slice(0,8)));
  console.log("deriveSymmetricKeyAndTag: tag (hex, first 8B):", bytesToHex(tag.slice(0,8)));

  if (K_AB.length !== 32) throw new Error("Symmetric key K_AB is not 32 bytes.");
  if (tag.length !== 32) throw new Error("Tag is not 32 bytes.");
  
  return { K_AB, tag };
}

// TODO: PRD 4.2: Encrypt payload
// XChaCha20-Poly1305; nonce=24 B. Payload = two FIDs + optional note
async function encryptPayload(K_AB, myFid, targetFid, note = "") {
  const myFidBytes = new Uint8Array(new Uint32Array([myFid]).buffer); 
  const targetFidBytes = new Uint8Array(new Uint32Array([targetFid]).buffer); 
  const noteBytes = new TextEncoder().encode(note);

  if (noteBytes.length > 0) {
    // With a 48-byte total target, and 24B nonce + 16B auth tag + 8B FIDs = 48B,
    // there is no space for a note.
    console.error("encryptPayload: Note is not supported if cipher size is fixed to 48 bytes.");
    throw new Error("Note is not supported with the current 48-byte cipher configuration.");
  }

  const payload = concatBytes(myFidBytes, targetFidBytes, noteBytes); // noteBytes will be empty
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(K_AB, nonce);
  const encryptedPayload = cipher.encrypt(payload);
  const combinedCiphertext = concatBytes(nonce, encryptedPayload);

  console.log("encryptPayload: myFidBytes (hex):", bytesToHex(myFidBytes));
  console.log("encryptPayload: targetFidBytes (hex):", bytesToHex(targetFidBytes));
  // console.log("encryptPayload: noteBytes (hex):", bytesToHex(noteBytes)); // Note is empty
  console.log("encryptPayload: payload (FIDs only, hex):", bytesToHex(payload));
  console.log("encryptPayload: K_AB (hex, first 8B):", bytesToHex(K_AB.slice(0,8)));
  console.log("encryptPayload: nonce (hex):", bytesToHex(nonce));
  console.log("encryptPayload: encryptedPayload (incl. Poly1305 tag, hex):", bytesToHex(encryptedPayload));
  console.log("encryptPayload: combinedCiphertext (nonce + encrypted, hex):", bytesToHex(combinedCiphertext));
  console.log("encryptPayload: combinedCiphertext length:", combinedCiphertext.length);
  
  const TARGET_CIPHER_LENGTH = 48;

  if (combinedCiphertext.length > TARGET_CIPHER_LENGTH) {
    console.error(`Encrypted payload is ${combinedCiphertext.length} bytes, exceeds ${TARGET_CIPHER_LENGTH} bytes limit.`);
    throw new Error(`Encrypted payload exceeds ${TARGET_CIPHER_LENGTH} byte limit.`);
  }
  
  let finalCipherForChain = combinedCiphertext;
  if (combinedCiphertext.length < TARGET_CIPHER_LENGTH) {
    // This should not happen if note is empty and FIDs are 4+4 bytes, as 24(nonce) + (8(FIDs)+16(tag)) = 48.
    console.warn(`Combined ciphertext is ${combinedCiphertext.length} bytes, padding to ${TARGET_CIPHER_LENGTH} bytes.`);
    finalCipherForChain = new Uint8Array(TARGET_CIPHER_LENGTH);
    finalCipherForChain.set(combinedCiphertext); 
  } 
  // No explicit else if (combinedCiphertext.length === TARGET_CIPHER_LENGTH) needed, it just passes through.

  return finalCipherForChain; 
}

// --- End Crypto Helper Functions ---

// --- Solana Transaction Helper ---

// PRD 4.2: Partial Tx build
// Fee-payer blank; instruction = submit_crush(cipher)
// Serialize + manual ed25519 sig with sk'
async function buildPartialTransaction(skPrime, pkPrime, tag, cipherForChain, relayerB58PublicKey) {
    console.log("buildPartialTransaction: pkPrime (signer, bs58):", bs58.encode(pkPrime));
    console.log("buildPartialTransaction: tag (for PDA, hex):", bytesToHex(tag));
    console.log("buildPartialTransaction: cipherForChain (hex):", bytesToHex(cipherForChain.slice(0,16)) + "...");
    console.log("buildPartialTransaction: Relayer PubKey for feePayer:", relayerB58PublicKey);

    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

    // Fetch a fresh blockhash just before building the transaction
    console.log("buildPartialTransaction: Fetching fresh blockhash...");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    console.log(`  buildPartialTransaction: Fresh blockhash: ${blockhash}, LastValidBlockHeight: ${lastValidBlockHeight}`);

    // 1. Derive the PDA for the crush account
    const pdaSeeds = [
        Buffer.from("crush"), 
        tag                     
    ];
    const [crushPda, crushPdaBump] = PublicKey.findProgramAddressSync(
        pdaSeeds.map(seed => seed instanceof Uint8Array ? seed : Buffer.from(seed)), 
        CRUSH_PROGRAM_ID
    );
    console.log(`  Crush PDA: ${crushPda.toBase58()}, Bump: ${crushPdaBump}`);

    // 2. Create the instruction
    // Order must match the Anchor program's SubmitCrush accounts struct:
    // 1. crush_pda (Account<'info, CrushPda>)
    // 2. user_signer (Signer<'info>)      <- This is pkPrime
    // 3. relayer (Signer<'info>)          <- This is relayerPublicKeyString, also TX feePayer
    // 4. system_program (Program<'info, System>)
    const keys = [
        { pubkey: crushPda, isSigner: false, isWritable: true },
        { pubkey: new PublicKey(pkPrime), isSigner: true, isWritable: true }, // user_signer (pkPrime) -  MUT constraint violation fix
        { pubkey: new PublicKey(relayerB58PublicKey), isSigner: true, isWritable: true }, // relayer (rent and tx fee payer)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false } 
    ];

    const instructionName = "submit_crush";
    const sighash = sha256(`global:${instructionName}`).slice(0, 8);
    // Instruction arguments are tag and cipher, matching the Rust function
    // submit_crush(ctx: Context<SubmitCrush>, _tag: [u8; 32], cipher: [u8;48])
    // The _tag argument to the instruction itself:
    const tagArgBuffer = Buffer.from(tag);
    const cipherArgBuffer = Buffer.from(cipherForChain);
    const instructionData = Buffer.concat([Buffer.from(sighash), tagArgBuffer, cipherArgBuffer]);

    console.log(`  Instruction data sighash (hex): ${bytesToHex(sighash)}`);
    console.log(`  Instruction data tag arg (hex): ${bytesToHex(tagArgBuffer)}`);
    console.log(`  Instruction data cipher arg (hex): ${bytesToHex(cipherArgBuffer.slice(0,8))}...`);


    const instruction = new TransactionInstruction({
        keys: keys,
        programId: CRUSH_PROGRAM_ID,
        data: instructionData,
    });

    // 3. Create the transaction
    const transaction = new Transaction();
    transaction.add(instruction);
    transaction.recentBlockhash = blockhash;
    
    // ***** CRITICAL CHANGE: Set relayer as fee payer BEFORE pkPrime signs *****
    if (!relayerB58PublicKey) {
        console.error("Relayer public key is not provided to buildPartialTransaction!");
        throw new Error("Relayer public key missing for transaction construction.");
    }
    transaction.feePayer = new PublicKey(relayerB58PublicKey);
    console.log(`  Transaction feePayer set to Relayer: ${transaction.feePayer.toBase58()}`);

    const messageToSign = transaction.compileMessage(); 
    const signature = ed25519.sign(messageToSign.serialize(), skPrime);
    console.log(`  Signature with skPrime (hex, first 16B): ${bytesToHex(signature.slice(0,16))}...`);

    transaction.addSignature(new PublicKey(pkPrime), Buffer.from(signature));

    const serializedTransaction = transaction.serialize({
        requireAllSignatures: false, 
        verifySignatures: false 
    });
    const base64Transaction = Buffer.from(serializedTransaction).toString('base64');
    console.log(`  Serialized Tx for relay (base64, first 32 chars): ${base64Transaction.substring(0,32)}...`);

    return base64Transaction;
}

// --- End Solana Transaction Helper ---

// --- User Index Management --- 

// Define the layout for CrushPda for client-side deserialization
const CRUSH_PDA_LAYOUT = borsh.struct([
    borsh.u8('bump'),
    borsh.u8('filled'),
    borsh.array(borsh.u8(), 48, 'cipher1'),
    borsh.array(borsh.u8(), 48, 'cipher2'),
]);

// AES-GCM encryption for the index file
// Key must be 16, 24, or 32 bytes for AES-128, AES-192, AES-256
// kIndex is SHA256, so it's 32 bytes (AES-256)
async function encryptIndex(indexObject, kIndex) {
    if (kIndex.length !== 32) throw new Error("kIndex must be 32 bytes for AES-256-GCM.");
    const plaintext = utf8ToBytes(JSON.stringify(indexObject));
    const nonce = randomBytes(12); // 12 bytes (96 bits) is recommended for AES-GCM
    const aes = gcm(kIndex, nonce); // noble/ciphers automatically selects AES mode based on key length
    const ciphertext = await aes.encrypt(plaintext);
    // Combine nonce and ciphertext for storage: nonce (12B) + ciphertext
    const encryptedBlob = concatBytes(nonce, ciphertext);
    return Buffer.from(encryptedBlob).toString('base64'); // Return as base64 string
}

async function decryptIndex(encryptedBase64, kIndex) {
    if (kIndex.length !== 32) throw new Error("kIndex must be 32 bytes for AES-256-GCM.");
    if (!encryptedBase64) return []; // No index stored yet, return empty array
    
    const encryptedBlob = Buffer.from(encryptedBase64, 'base64');
    if (encryptedBlob.length < 12) throw new Error("Encrypted index blob too short to contain nonce.");

    const nonce = encryptedBlob.slice(0, 12);
    const ciphertext = encryptedBlob.slice(12);
    
    const aes = gcm(kIndex, nonce);
    try {
        const plaintext = await aes.decrypt(ciphertext);
        return JSON.parse(bytesToUtf8(plaintext));
    } catch (e) {
        console.error("Failed to decrypt or parse index:", e);
        throw new Error("Failed to decrypt index. It might be corrupted or using a different key.");
    }
}

async function updateUserIndexOnApi(updatedIndexArray) {
    if (!sessionKIndex || !sessionPublicKey) {
        console.error("kIndex or sessionPublicKey not available for updating index.");
        updateStatusMessage("Login session error, cannot update crush list.", true);
        return false; // Indicate failure
    }
    updateStatusMessage("Syncing your updated crush list with server...");

    try {
        console.log("Encrypting updated index for server...");
        const newEncryptedIndex = await encryptIndex(updatedIndexArray, sessionKIndex);

        console.log(`PUTting updated index for ${sessionPublicKey}...`);
        const putResponse = await fetch(`${API_ROOT}/api/user/${sessionPublicKey}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ encryptedIndex: newEncryptedIndex }),
        });

        if (!putResponse.ok) {
            const errorData = await putResponse.json().catch(() => ({}));
            console.error("Error updating user index on server:", putResponse.status, errorData);
            throw new Error(`Failed to update user index on server: ${errorData.error || putResponse.statusText}`);
        }

        const putResult = await putResponse.json();
        console.log("Successfully updated user index on server:", putResult);
        updateStatusMessage("Your secret crush list synced with server!");
        displayUserIndex(updatedIndexArray); // Display the list we just successfully saved
        return true; // Indicate success

    } catch (error) {
        console.error("Error in updateUserIndexOnApi:", error);
        updateStatusMessage(`Failed to sync crush list: ${error.message}`, true);
        return false; // Indicate failure
    }
}

async function loadAndDisplayUserIndex(displayStaleOnError = false) {
    if (!sessionKIndex || !sessionPublicKey) {
        console.warn("Cannot load user index: kIndex or publicKey not available.");
        displayUserIndex([]); 
        return;
    }
    updateStatusMessage("Loading your secret crushes & checking for mutuals...");
    console.log(`Attempting to load index for wallet ${sessionPublicKey}...`);

    let localDecryptedIndex = [];

    try {
        const response = await fetch(`${API_ROOT}/api/user/${sessionPublicKey}`);
        if (response.ok) {
            const data = await response.json();
            if (data.encryptedIndex) {
                console.log("Decrypting index from server...");
                localDecryptedIndex = await decryptIndex(data.encryptedIndex, sessionKIndex);
                updateStatusMessage("Crush list loaded from server.");
            } else {
                console.log("No encrypted index found on server for this user.");
                updateStatusMessage("No crushes found on server. Ready to send one!");
            }
        } else if (response.status === 404) {
             console.log("No index found for user (404 from server).");
             updateStatusMessage("No crushes found yet. Send your first!");
        } else {
            const errorData = await response.json().catch(() => ({}));
            console.error("Error fetching user index:", response.status, errorData);
            throw new Error(`API error fetching index: ${errorData.error || response.statusText}`);
        }
    } catch (error) {
        console.error("Failed to load or decrypt user index:", error);
        updateStatusMessage(`Failed to load crush list: ${error.message}`, true);
        if(displayStaleOnError) {
            console.warn("Displaying potentially stale local data due to API error during load.");
        }
        displayUserIndex(localDecryptedIndex); // Display whatever we have (empty if error before fetch)
        return; // Stop further processing if initial load fails badly
    }

    // Log the entire decrypted index to see the state of each entry
    console.log("--- Full Decrypted User Index (before on-chain checks) ---");
    localDecryptedIndex.forEach((entry, idx) => {
        console.log(`Entry ${idx}:`, JSON.stringify(entry, null, 2));
    });
    console.log("--- End Full Decrypted User Index ---");

    // Now, check status of pending crushes
    let anIndexWasUpdated = false;
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

    for (let i = 0; i < localDecryptedIndex.length; i++) {
        const entry = localDecryptedIndex[i];
        if (entry.status === "pending") {
            console.log(`Checking status for pending crush with tag: ${entry.tag}`);
            try {
                const tagBytes = hexToBytes(entry.tag);
                const pdaSeeds = [Buffer.from("crush"), Buffer.from(tagBytes)];
                const [pdaPublicKey, _] = PublicKey.findProgramAddressSync(pdaSeeds, CRUSH_PROGRAM_ID);
                
                console.log(`  Fetching PDA: ${pdaPublicKey.toBase58()}`);
                const accountInfo = await connection.getAccountInfo(pdaPublicKey);

                if (accountInfo && accountInfo.data) {
                    // Skip 8-byte discriminator for Anchor accounts
                    const pdaData = CRUSH_PDA_LAYOUT.decode(accountInfo.data.slice(8));
                    console.log(`  PDA data for ${entry.tag}: filled=${pdaData.filled}, bump=${pdaData.bump}`);

                    if (pdaData.filled === 2) {
                        // Defer loud "MUTUAL MATCH FOUND" log until after successful decryption
                        // localDecryptedIndex[i].status = "mutual"; // Set status later if decryption successful or with specific error status

                        if (entry.K_AB_hex) {
                            const K_AB_bytes = hexToBytes(entry.K_AB_hex);
                            
                            const pdaCipher1_onchain_b64 = Buffer.from(pdaData.cipher1).toString('base64');
                            const pdaCipher2_onchain_b64 = Buffer.from(pdaData.cipher2).toString('base64');
                            let otherCipherBytes_raw;

                            if (entry.cipherMine === pdaCipher1_onchain_b64) {
                                otherCipherBytes_raw = pdaData.cipher2;
                                console.log(`  User's cipher (${entry.cipherMine.substring(0,8)}...) matches PDA.cipher1. Other party's is PDA.cipher2.`);
                            } else if (entry.cipherMine === pdaCipher2_onchain_b64) {
                                otherCipherBytes_raw = pdaData.cipher1;
                                console.log(`  User's cipher (${entry.cipherMine.substring(0,8)}...) matches PDA.cipher2. Other party's is PDA.cipher1.`);
                            } else {
                                console.warn(`  User's cipher (${entry.cipherMine.substring(0,8)}...) does not match PDA.cipher1 (${pdaCipher1_onchain_b64.substring(0,8)}...) or PDA.cipher2 (${pdaCipher2_onchain_b64.substring(0,8)}...). Cannot determine other party's cipher for tag ${entry.tag}.`);
                                otherCipherBytes_raw = null;
                                localDecryptedIndex[i].status = "mutual_decryption_key_mismatch"; // Special status
                                localDecryptedIndex[i].revealedInfo = "Mutual (Cipher Mismatch)";
                                anIndexWasUpdated = true; 
                            }

                            if (otherCipherBytes_raw && otherCipherBytes_raw.length === 48) {
                                // Ensure Uint8Array type for crypto operations
                                const otherCipherForDecryption = Uint8Array.from(otherCipherBytes_raw);
                                const nonce = otherCipherForDecryption.slice(0, 24);
                                const encryptedDataWithAuthTag = otherCipherForDecryption.slice(24);
                                
                                try {
                                    const cryptoInstance = xchacha20poly1305(K_AB_bytes, nonce);
                                    const decryptedPayload = cryptoInstance.decrypt(encryptedDataWithAuthTag);
                                    
                                    console.log(`  MUTUAL MATCH FOUND & DECRYPTED for tag: ${entry.tag}!`);
                                    localDecryptedIndex[i].status = "mutual"; // Set status to full mutual
                                    anIndexWasUpdated = true;

                                    if (decryptedPayload.length === 8) {
                                        const view = new DataView(decryptedPayload.buffer, decryptedPayload.byteOffset, decryptedPayload.byteLength);
                                        const theirFidInPayload = view.getUint32(0, true); 
                                        const myFidInPayload = view.getUint32(4, true);    
                                        
                                        console.log(`  Successfully decrypted other party's payload! Their FID: ${theirFidInPayload}, My FID: ${myFidInPayload}`);
                                        localDecryptedIndex[i].revealedInfo = `Mutual with FID ${theirFidInPayload}`;
                                    } else {
                                        console.warn("  Decrypted payload from other party has unexpected length:", decryptedPayload.length);
                                        localDecryptedIndex[i].revealedInfo = "Mutual (Payload Format Error)";
                                    }
                                } catch (decryptionError) {
                                    console.error(`  Failed to decrypt other party's cipher for tag ${entry.tag}:`, decryptionError);
                                    localDecryptedIndex[i].status = "mutual_decryption_failed"; // Special status
                                    localDecryptedIndex[i].revealedInfo = "Mutual (Decryption Error)";
                                    anIndexWasUpdated = true; 
                                }
                            } else if (otherCipherBytes_raw === null && localDecryptedIndex[i].status !== "mutual_decryption_key_mismatch") {
                                // This case should ideally not be hit if the above logic correctly sets status on mismatch
                                console.warn(`  Could not identify or process other party's cipher for tag ${entry.tag} (otherCipherBytes_raw is null/invalid and not a key mismatch).`);
                                localDecryptedIndex[i].status = "mutual_cipher_unavailable";
                                localDecryptedIndex[i].revealedInfo = "Mutual (Cipher Unavailable)";
                                anIndexWasUpdated = true;
                            }
                        } else {
                            console.warn(`  K_AB_hex missing for tag ${entry.tag}, cannot decrypt mutual payload.`);
                            localDecryptedIndex[i].status = "mutual_key_missing"; // Special status
                            localDecryptedIndex[i].revealedInfo = "Mutual (Key Missing)";
                            anIndexWasUpdated = true; 
                        }

                        const itemElement = document.querySelector(`[data-tag='${entry.tag}']`);
                        if(itemElement) itemElement.style.backgroundColor = 'lightgreen'; 

                    } else {
                        console.log(`  PDA for tag ${entry.tag} is not filled (filled=${pdaData.filled}).`);
                    }
                } else {
                    console.log(`  No account data found for PDA of tag: ${entry.tag}. It might not be initialized yet.`);
                }
            } catch (pdaError) {
                console.error(`Error checking PDA for tag ${entry.tag}:`, pdaError);
            }
        }
    }

    displayUserIndex(localDecryptedIndex); // Display updated list (with any new mutuals)

    if (anIndexWasUpdated) {
        console.log("One or more crushes updated to mutual. Syncing with server...");
        updateStatusMessage("Mutual match found! Updating list on server...");
        await updateUserIndexOnApi(localDecryptedIndex); // Save the updated statuses to the server
    } else {
        updateStatusMessage("Crush list up to date.");
    }
}

function displayUserIndex(indexArray) {
    const placeholder = document.getElementById('userIndexContainerPlaceholder');
    let indexContainer = document.getElementById('userIndexContainer');

    if (!indexContainer && placeholder) {
        indexContainer = document.createElement('div');
        indexContainer.id = 'userIndexContainer';
        indexContainer.style.marginTop = '20px';
        placeholder.replaceWith(indexContainer); 
    }
    
    if(indexContainer) {
        indexContainer.innerHTML = '<h3>Your Secret Crushes:</h3>'; 

        const list = document.createElement('ul');
        list.style.listStyleType = "none";
        list.style.paddingLeft = "0";

        if (!indexArray || indexArray.length === 0) {
            list.innerHTML = '<li><p>No crushes sent yet. Find someone!</p></li>';
        } else {
            // Sort the array: mutual first, then by timestamp descending
            const sortedArray = [...indexArray].sort((a, b) => {
                if (a.status === 'mutual' && b.status !== 'mutual') return -1;
                if (a.status !== 'mutual' && b.status === 'mutual') return 1;
                return (b.ts || 0) - (a.ts || 0); // Sort by timestamp descending
            });

            sortedArray.forEach(entry => {
                const item = document.createElement('li');
                item.setAttribute('data-tag', entry.tag); 
                item.style.border = "1px solid #eee";
                item.style.padding = "10px";
                item.style.marginBottom = "8px";
                item.style.borderRadius = "5px";
                if (entry.status === "mutual") {
                    item.style.backgroundColor = '#e6ffe6'; 
                }
                
                const tagHexSnippet = entry.tag ? entry.tag.substring(0,16) : 'N/A';
                item.innerHTML = `
                    <strong>Target FID:</strong> ${entry.targetFid || 'N/A'} <br>
                    <strong>Target Username:</strong> @${entry.targetUsername || 'N/A'} <br>
                    <strong>Status:</strong> ${entry.status || 'N/A'} ${entry.status === "mutual" ? `&#10024; <span class="mutual-info">${entry.revealedInfo || 'It\'s a Match!'}</span>` : ""} <br>
                    <strong>Timestamp:</strong> ${entry.ts ? new Date(entry.ts).toLocaleString() : 'N/A'} <br>
                    <small>Tag: ${tagHexSnippet}...</small><br>
                    ${entry.txSignature ? `<small>Tx: <a href="https://explorer.solana.com/tx/${entry.txSignature}?cluster=mainnet" target="_blank" rel="noopener noreferrer">${entry.txSignature.substring(0,10)}...</a></small><br>` : '' }
                `;
                list.appendChild(item);
            });
        }
        indexContainer.appendChild(list);
    } else {
        console.error("Could not find or create userIndexContainer.");
    }
}

async function handleSendCrush() {
    if (!selectedTargetUser || !selectedTargetUser.primary_sol_address) {
        updateStatusMessage("No target user with a Solana address selected!", true);
        return;
    }
    if (!sessionKWallet || !sessionKIndex) { 
        updateStatusMessage("kWallet or kIndex not available. Please connect and sign first.", true);
        return;
    }
    // Ensure relayer public key is available
    if (!relayerPublicKeyString) {
        try {
            await fetchRelayerPublicKey(); // Attempt to fetch if not already available
            if (!relayerPublicKeyString) { // Check again after fetch attempt
                 updateStatusMessage("Relayer configuration not loaded. Cannot send crush.", true);
                 return;
            }
        } catch (error) {
            // Error is already logged by fetchRelayerPublicKey, and status message updated
            return; 
        }
    }
    
    updateStatusMessage("Preparing your secret crush...");
    let myFid;
    try {
        const frameContext = await frame.sdk.context;
        if (!frameContext || typeof frameContext.user.fid !== 'number') {
            throw new Error("Could not get user FID from frame context.");
        }
        myFid = frameContext.user.fid;
    } catch (contextError) {
        console.error("Error getting frame context:", contextError);
        updateStatusMessage("Error fetching your Farcaster details. Unable to send crush.", true);
        return;
    }

    const edPubTarget = selectedTargetUser.primary_sol_address;
    let edPubTargetBytes;
    try {
        edPubTargetBytes = bs58.decode(edPubTarget);
        if (edPubTargetBytes.length !== 32) {
            throw new Error(`Invalid public key length: ${edPubTargetBytes.length}. Expected 32.`);
        }
    } catch(e) {
        console.error("Invalid target Solana address (edPubTarget):", edPubTarget, e);
        updateStatusMessage("The target user\'s Solana address appears invalid.", true);
        return;
    }

    const searchResultsDiv = document.getElementById('searchResults');
    if(searchResultsDiv) searchResultsDiv.innerHTML = "<p>Processing your secret crush... Generating keys...</p>";
    else updateStatusMessage("Processing your secret crush... Generating keys...");
    
    try {
        updateStatusMessage("Deriving stealth key...");
        const { skPrime, pkPrime } = await deriveStealthKey(sessionKWallet, edPubTargetBytes);
        updateStatusMessage("Performing ECDH for shared secret...");
        const sharedSecret = await performECDH(skPrime, edPubTargetBytes);
        updateStatusMessage("Deriving symmetric key and tag...");
        const { K_AB, tag } = await deriveSymmetricKeyAndTag(sharedSecret);
        updateStatusMessage("Encrypting payload...");
        const cipherForChain = await encryptPayload(K_AB, myFid, selectedTargetUser.fid, "");
        updateStatusMessage("Building partial transaction...");
        const base64Tx = await buildPartialTransaction(skPrime, pkPrime, tag, cipherForChain, relayerPublicKeyString);
        updateStatusMessage("Sending transaction to relay...");
        const relayResponse = await fetch(`${API_ROOT}/api/relay`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', },
            body: JSON.stringify({ tx: base64Tx }),
        });

        if (!relayResponse.ok) {
            const errorData = await relayResponse.json().catch(() => ({ message: 'Relay request failed with no JSON response.'}));
            throw new Error(`Relay Error: ${errorData.message || relayResponse.statusText}`);
        }
        const relayResult = await relayResponse.json();
        const finalTxSignature = relayResult.signature;

        const waitingForConfirmationMessage = `Transaction sent! Signature: ${finalTxSignature.substring(0,10)}... Waiting for confirmation...`;
        if (searchResultsDiv) {
            searchResultsDiv.innerHTML = `<p>${waitingForConfirmationMessage}</p><p><small>This may take a few moments. Please wait.</small></p>`;
        } else {
            updateStatusMessage(waitingForConfirmationMessage); 
        }
        console.log(`  Relay successful! Transaction signature: ${finalTxSignature}`);

        // Client-side polling for transaction status
        const POLLING_INTERVAL = 3000; // 3 seconds
        const MAX_POLLING_ATTEMPTS = 20; // Poll for a maximum of 60 seconds (20 * 3s)
        let pollingAttempts = 0;

        let confirmationStatus = "pending_submission"; // Initial status after relay
        let confirmationErrorDetail = null;
        let uiMessage = waitingForConfirmationMessage;

        const pollTransactionStatus = async () => {
            pollingAttempts++;
            console.log(`Polling attempt ${pollingAttempts} for tx: ${finalTxSignature}`);

            try {
                const statusResponse = await fetch(`${API_ROOT}/api/transaction-status?signature=${finalTxSignature}`);
                if (!statusResponse.ok) {
                    const errData = await statusResponse.json().catch(() => ({}));
                    throw new Error(`Transaction status check failed: ${errData.error || statusResponse.statusText}`);
                }
                const statusResult = await statusResponse.json();
                console.log("Transaction status API response:", statusResult);

                if (statusResult.status === 'confirmed' || statusResult.status === 'finalized') {
                    updateStatusMessage("Transaction confirmed on-chain! Processing crush details...");
                    console.log(`Transaction ${finalTxSignature} successfully confirmed (${statusResult.status}).`);
                    confirmationStatus = "pending"; // Still "pending" for PDA check, but client-side confirmed.
                    uiMessage = `Crush sent and confirmed on Solana! Tx: <a href="https://explorer.solana.com/tx/${finalTxSignature}?cluster=mainnet" target="_blank" rel="noopener noreferrer">${finalTxSignature.substring(0,10)}...</a>`;
                    clearInterval(pollingIntervalId);
                    await finalizeCrushSubmission(true); 
                } else if (statusResult.status === 'failed') {
                    console.error(`Transaction ${finalTxSignature} failed:`, statusResult.error);
                    updateStatusMessage(`Transaction ${finalTxSignature.substring(0,10)}... FAILED on-chain.`, true);
                    confirmationStatus = "failed_on_chain";
                    confirmationErrorDetail = JSON.stringify(statusResult.error);
                    uiMessage = `Crush FAILED to process on Solana. Tx: <a href="https://explorer.solana.com/tx/${finalTxSignature}?cluster=mainnet" target="_blank" rel="noopener noreferrer">${finalTxSignature.substring(0,10)}...</a>. Error: ${confirmationErrorDetail}`;
                    clearInterval(pollingIntervalId);
                    await finalizeCrushSubmission(false); 
                } else if (pollingAttempts >= MAX_POLLING_ATTEMPTS) {
                    console.warn(`Transaction ${finalTxSignature} confirmation timed out after ${MAX_POLLING_ATTEMPTS} attempts.`);
                    updateStatusMessage(`Transaction ${finalTxSignature.substring(0,10)}... confirmation timed out. It might still succeed. Check explorer.`, true);
                    confirmationStatus = "pending_confirmation_timeout";
                    confirmationErrorDetail = "Confirmation polling timed out.";
                    uiMessage = `Crush sent (Tx: <a href="https://explorer.solana.com/tx/${finalTxSignature}?cluster=mainnet" target="_blank" rel="noopener noreferrer">${finalTxSignature.substring(0,10)}...</a>), but confirmation polling timed out. It may process on-chain shortly.`;
                    clearInterval(pollingIntervalId);
                    await finalizeCrushSubmission(false); 
                } else {
                    // Status is 'pending', 'processed', or 'notFound', so continue polling
                    updateStatusMessage(`Transaction ${finalTxSignature.substring(0,10)}... Status: ${statusResult.status || 'pending'}. Waiting... (${pollingAttempts}/${MAX_POLLING_ATTEMPTS})`);
                }
            } catch (err) {
                console.error(`Error during polling for tx ${finalTxSignature}:`, err);
                // Don't stop polling for transient network errors, unless max attempts reached
                if (pollingAttempts >= MAX_POLLING_ATTEMPTS) {
                    updateStatusMessage(`Error checking transaction status for ${finalTxSignature.substring(0,10)}... Max attempts reached.`, true);
                    confirmationStatus = "pending_polling_error";
                    if (err.message && err.message.includes("was not confirmed in 30.00 seconds")) {
                        confirmationErrorDetail = "Confirmation timed out (30s).";
                    } else {
                        confirmationErrorDetail = err.message;
                    }
                    uiMessage = `Crush sent (Tx: <a href="https://explorer.solana.com/tx/${finalTxSignature}?cluster=mainnet" target="_blank" rel="noopener noreferrer">${finalTxSignature.substring(0,10)}...</a>), but an error occurred while checking status.`;
                    clearInterval(pollingIntervalId);
                    await finalizeCrushSubmission(false); 
                }
            }
        };

        const finalizeCrushSubmission = async (isConfirmed) => {
            let currentIndexArray = [];
            try {
                const getResponse = await fetch(`${API_ROOT}/api/user/${sessionPublicKey}`);
                if (getResponse.ok) {
                    const getData = await getResponse.json();
                    if (getData.encryptedIndex) {
                        currentIndexArray = await decryptIndex(getData.encryptedIndex, sessionKIndex);
                    }
                } else if (getResponse.status !== 404) { 
                     console.warn("Error fetching user index before adding new crush, proceeding with empty list.");
                }
            } catch (fetchErr) {
                console.warn("Network error fetching index before adding new crush, proceeding with empty list:", fetchErr);
            }
    
            const newCrushEntry = {
                tag: bytesToHex(tag),
                cipherMine: Buffer.from(cipherForChain).toString('base64'), 
                status: confirmationStatus, 
                ts: Date.now(),
                targetFid: selectedTargetUser.fid,
                targetUsername: selectedTargetUser.username,
                K_AB_hex: bytesToHex(K_AB),
                txSignature: finalTxSignature, 
                confirmationError: confirmationErrorDetail 
            };
    
            const existingEntryIndex = currentIndexArray.findIndex(entry => entry.tag === newCrushEntry.tag);
            if (existingEntryIndex > -1) currentIndexArray[existingEntryIndex] = newCrushEntry;
            else currentIndexArray.push(newCrushEntry);
            
            const updateSuccess = await updateUserIndexOnApi(currentIndexArray);
    
            if(searchResultsDiv) {
                let finalUiColor = 'green';
                if (confirmationStatus.startsWith('pending_') || confirmationStatus === 'failed_on_chain') {
                    finalUiColor = 'orange';
                } 
                if (confirmationStatus === 'failed_on_chain') finalUiColor = 'red';

                searchResultsDiv.innerHTML = `
                    <div style="padding: 15px;">
                        <p style="color: ${finalUiColor}; font-weight: bold; font-size: 1.1em;">${uiMessage.includes("confirmed") || uiMessage.includes("finalized") ? `Crush Sent to ${selectedTargetUser.display_name}!` : (uiMessage.includes("FAILED") ? "Crush Failed" : "Crush Sent (Status Pending)")}</p>
                        <p style="font-size: 0.9em; margin-top: 10px;">${uiMessage}</p>
                        <button id="searchAgainAfterCrushBtn" style="margin-top: 15px;">Send Another Crush</button>
                    </div>
                `;
                document.getElementById('searchAgainAfterCrushBtn').addEventListener('click', () => {
                    document.getElementById('userSearchInput').value = '';
                    searchResultsDiv.innerHTML = ''; 
                    searchResultsDiv.classList.remove('populated');
                    selectedTargetUser = null; 
                });
            } else {
                 updateStatusMessage(uiMessage, confirmationStatus.includes('fail') || confirmationStatus.includes('error'));
            }
        };

        const pollingIntervalId = setInterval(pollTransactionStatus, POLLING_INTERVAL);
        pollTransactionStatus(); // Initial call

    } catch (error) {
        console.error("Error during crush sequence (crypto or relay):", error);
        updateStatusMessage(`Error: ${error.message}. Check console.`, true);
        if(searchResultsDiv) searchResultsDiv.innerHTML = `<p style="color: red; padding: 15px;">Error: ${error.message}.</p>`;
    }
}
