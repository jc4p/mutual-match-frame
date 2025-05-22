import './style.css';
import * as frame from '@farcaster/frame-sdk';
import { sha256 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import { ed25519, x25519, edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import { concatBytes, randomBytes } from '@noble/hashes/utils'; // For randomBytes (nonce) and concatBytes
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'; 
import { bytesToHex } from '@noble/hashes/utils';
import bs58 from 'bs58';
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
// Using SystemProgram.programId as a valid placeholder for CRUSH_PROGRAM_ID until actual is available
const CRUSH_PROGRAM_ID = SystemProgram.programId; 
// const CRUSH_PROGRAM_ID = new PublicKey('YOUR_CRUSH_PROGRAM_ID_HERE'); // Replace with your actual Program ID

console.log("Encrypted Mutual Match App Initializing...");

// --- Debug Console Start ---
let debugConsoleVisible = false;
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

// Placeholder for wallet interaction and signing
async function connectAndSign() {
    console.log("--- connectAndSign called ---");

    const contentDiv = document.getElementById('content');
    const statusMessageDiv = document.getElementById('statusMessage');

    if (!contentDiv || !statusMessageDiv) {
        console.error("UI elements (content/statusMessage) not found");
        return null;
    }
    statusMessageDiv.innerHTML = "<p>Attempting to get Solana Provider...</p>";

    let solanaProvider = null;
    try {
        solanaProvider = await frame.sdk.experimental.getSolanaProvider();

        if (!solanaProvider) {
            console.error("await frame.sdk.experimental.getSolanaProvider() returned null or undefined.");
            statusMessageDiv.innerHTML = '<p>Error: Solana Wallet Provider not available.</p>';
            contentDiv.innerHTML = '<p>Please ensure your Farcaster client is set up correctly. Check debug console.</p>';
            return null;
        }
        
        statusMessageDiv.innerHTML = "<p>Solana Provider found! Connecting to wallet...</p>";

        let publicKeyString; 
        try {
            console.log("Attempting solanaProvider connect...");
            statusMessageDiv.innerHTML = "<p>Awaiting wallet connection approval...</p>";
            const connectionResponse = await solanaProvider.request({ method: 'connect' });
            console.log("solanaProvider connect response:", connectionResponse);
            publicKeyString = connectionResponse?.publicKey
            console.log('publicKeyString:', publicKeyString);
        } catch (connectError) {
            console.error("Error connecting to Solana wallet via provider connect:", connectError);
            statusMessageDiv.innerHTML = `<p>Error connecting to wallet.</p>`;
            contentDiv.innerHTML = `<p>${connectError.message}. You might need to approve the connection.</p>`;
            return null;
        }

        if (!publicKeyString || typeof publicKeyString !== 'string') {
            console.error("Could not get publicKey as a string from Solana provider. Received:", publicKeyString);
            statusMessageDiv.innerHTML = '<p>Error: Could not get public key string.</p>';
            contentDiv.innerHTML = '<p>Wallet might not be connected/approved or provider returned unexpected format. Check debug console.</p>';
            return null;
        }
        
        console.log("Successfully obtained publicKey string:", publicKeyString);
        statusMessageDiv.innerHTML = `<p>Wallet connected: ${publicKeyString.slice(0,4)}...${publicKeyString.slice(-4)}. Signing message...</p>`;

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
                 statusMessageDiv.innerHTML = '<p>Error: Could not decode signature.</p>';
                 contentDiv.innerHTML = '<p>The signature format from the wallet was undecodable or incorrect length.</p>';
                 return null;
            }
        } else {
            console.error("Unexpected signature format from signMessage. Expected an object with a string 'signature' property. Received:", signedMessageResult);
            statusMessageDiv.innerHTML = '<p>Error: Unexpected signature format.</p>';
            contentDiv.innerHTML = '<p>Received an unexpected signature format from the wallet for the message signature.</p>';
            return null;
        }

        if (!signature || signature.length === 0) {
             console.error("Signature is null or empty after processing.");
             statusMessageDiv.innerHTML = '<p>Error: Signature processing failed.</p>';
             return null;
        }

        const kWallet = sha256(signature);
        sessionKWallet = kWallet;
        sessionPublicKey = publicKeyString; 

        console.log('Raw signature (first 16 bytes hex):', bytesToHex(signature.slice(0,16)));
        console.log('kWallet (hex, first 8 bytes):', bytesToHex(kWallet.slice(0,8)));
        
        statusMessageDiv.innerHTML = `<p>Successfully signed message and derived kWallet!</p>`;
        
        contentDiv.innerHTML = `
            <p>Welcome! Search for a user to send a secret crush.</p>
            <input type="text" id="userSearchInput" class="user-search-input" placeholder="Search Farcaster users by name or FID...">
            <div id="searchResults" class="search-results-container"></div>
        `;
        document.getElementById('userSearchInput').addEventListener('input', (e) => {
            debouncedSearchUsers(e.target.value);
        });
        
        const connectButton = document.getElementById('connectWalletBtn');
        if(connectButton) connectButton.style.display = 'none';

        return { kWallet, publicKey: publicKeyString }; // Return string publicKey

    } catch (error) {
        console.error("Error in connectAndSign process:", error);
        statusMessageDiv.innerHTML = `<p>Error: ${error.message}.</p>`;
        contentDiv.innerHTML = `<p>See debug console for more details. Ensure your Farcaster wallet is set up and active.</p>`;
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
                <h1>Welcome to Secret Mutual Crush!</h1>
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
        <p>Secret Mutual Crush allows Farcaster users to discreetly signal interest in someone. If the interest is mutual, both users are notified. Otherwise, your secret is safe!</p>

        <h3>How It Works (Summary)</h3>
        <ul>
            <li>✍️ <strong>Sign In:</strong> You sign a message with your wallet – this keeps your main Farcaster account details separate and generates a special key for this app.</li>
            <li>🤫 <strong>Express a Crush:</strong> You pick someone you follow. The app uses clever cryptography to prepare your 'crush' message.</li>
            <li>🔒 <strong>Encryption Magic:</strong> Your choice is encrypted using keys that only you and your potential crush can generate if you <em>both</em> express interest. The server or anyone else can't read it.</li>
            <li>🔗 <strong>OnChain (but private!):</strong> An encrypted piece of data is sent to the Solana blockchain. This data doesn't reveal who you are or who you crushed on.</li>
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
async function buildPartialTransaction(skPrime, pkPrime, tag, cipherForChain) {
    console.log("buildPartialTransaction: pkPrime (signer, bs58):", bs58.encode(pkPrime));
    console.log("buildPartialTransaction: tag (for PDA, hex):", bytesToHex(tag));
    console.log("buildPartialTransaction: cipherForChain (hex):", bytesToHex(cipherForChain.slice(0,16)) + "...");

    const connection = new Connection(SOLANA_RPC_URL);

    // 1. Derive the PDA for the crush account
    // PRD: seeds = [b"crush", tag]
    const pdaSeeds = [
        Buffer.from("crush"), // b"crush"
        tag                     // The 32-byte tag derived earlier
    ];
    const [crushPda, crushPdaBump] = await PublicKey.findProgramAddressSync(pdaSeeds, CRUSH_PROGRAM_ID);
    console.log(`  Crush PDA: ${crushPda.toBase58()}, Bump: ${crushPdaBump}`);

    // 2. Create the instruction
    // We need to know the exact structure of `submit_crush`'s accounts.
    // Assuming: 0: crush_pda (writable), 1: signer (pkPrime, signer)
    //           (Possibly SystemProgram if PDA needs init, but PRD suggests program handles init based on `filled` state)
    const keys = [
        { pubkey: crushPda, isSigner: false, isWritable: true },
        { pubkey: new PublicKey(pkPrime), isSigner: true, isWritable: false },
        // { pubkey: SystemProgram.programId, isSigner: false, isWritable: false } // If needed
    ];

    // The `data` for the instruction is just the cipher (112 bytes).
    // Anchor typically prepends an 8-byte discriminator for the instruction name.
    // We need to know this discriminator for `submit_crush`.
    // For now, assuming a utility on the backend or a known constant.
    // Let's represent the data as just the cipher for now, and assume the discriminator handling is either 
    // not needed for manual construction this way OR will be prefixed by a helper / known constant.
    // If using Anchor client, it handles this. Manually, we need it.
    // Placeholder: const SUBMIT_CRUSH_DISCRIMINATOR = Buffer.from([...]); 
    // const instructionData = Buffer.concat([SUBMIT_CRUSH_DISCRIMINATOR, Buffer.from(cipherForChain)]);
    // For now, directly passing cipher. This will likely FAIL without the discriminator if calling an Anchor program.
    // This part *critically* depends on how you call your Solana program method without the Anchor client.
    // Typically, you hash 'global:submit_crush' or 'instruction:submit_crush' to get the 8-byte discriminator.
    // For example: sha256('global:submit_crush').slice(0, 8)
    // Let's simulate getting this discriminator for now.
    const instructionName = "submit_crush";
    const sighash = sha256(`global:${instructionName}`).slice(0, 8); // Common Anchor sighash
    const instructionData = Buffer.concat([Buffer.from(sighash), Buffer.from(cipherForChain)]);
    console.log(`  Instruction data sighash (hex): ${bytesToHex(sighash)}`);


    const instruction = new TransactionInstruction({
        keys: keys,
        programId: CRUSH_PROGRAM_ID,
        data: Buffer.from(instructionData),
    });

    // 3. Create the transaction
    const { blockhash } = await connection.getLatestBlockhash();
    console.log(`  Recent blockhash: ${blockhash}`);

    const transaction = new Transaction();
    transaction.add(instruction);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = new PublicKey(pkPrime); // Stealth key is payer initially, relay will change

    // 4. Sign with skPrime (MANUALLY using noble)
    // We need to serialize the transaction message, sign its hash, then add the signature.
    const messageToSign = transaction.compileMessage(); // Compiles the message to be signed
    
    // Noble ed25519.sign expects the hash of the message if it's too long, or the message itself.
    // Solana transactions are typically signed over the sha256 hash of the message bytes.
    // However, noble ed25519.sign can take the message directly.
    // Let's confirm noble's behavior: it hashes the message if it's > 64 bytes.
    // Transaction messages are usually larger, so it will hash internally.
    const signature = ed25519.sign(messageToSign.serialize(), skPrime);
    console.log(`  Signature with skPrime (hex, first 16B): ${bytesToHex(signature.slice(0,16))}...`);

    // Add the signature to the transaction
    // The addSignature method takes the public key and the signature
    transaction.addSignature(new PublicKey(pkPrime), Buffer.from(signature));

    // 5. Serialize the partially signed transaction (relay expects this)
    // The transaction is now signed by pkPrime. The feePayer (also pkPrime for now) signature is present.
    // The relay will add its own signature as the *actual* feePayer.
    const serializedTransaction = transaction.serialize({
        requireAllSignatures: false, // IMPORTANT: pkPrime is the only signer we add here
        verifySignatures: false // We just signed it, verification can be done by relay/chain
    });
    const base64Transaction = Buffer.from(serializedTransaction).toString('base64');
    console.log(`  Serialized Tx for relay (base64, first 32 chars): ${base64Transaction.substring(0,32)}...`);

    return base64Transaction;
}

// --- End Solana Transaction Helper ---

async function handleSendCrush() {
    if (!selectedTargetUser || !selectedTargetUser.primary_sol_address) {
        alert("No target user with a Solana address selected!");
        return;
    }
    if (!sessionKWallet) {
        alert("kWallet not available. Please connect and sign first.");
        return;
    }
    // sessionPublicKey is also available if needed for other purposes, but not directly for this crypto flow.

    let myFid;
    try {
        const frameContext = await frame.sdk.context;
        if (!frameContext || typeof frameContext.user.fid !== 'number') {
            console.error("Could not get user FID from frame context:", frameContext);
            alert("Could not determine your Farcaster FID. Unable to send crush.");
            return;
        }
        myFid = frameContext.user.fid;
        console.log("User FID from frame context:", myFid);
    } catch (contextError) {
        console.error("Error getting frame context:", contextError);
        alert("Error fetching your Farcaster details. Unable to send crush.");
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
        alert("The target user\\'s Solana address appears invalid. Cannot proceed.");
        return;
    }

    console.log("Initiating crush sequence with:");
    console.log("kWallet (first 8B hex):", bytesToHex(sessionKWallet.slice(0,8)));
    console.log("edPubTarget (bs58):", edPubTarget);
    console.log("edPubTarget (bytes, first 8B hex):", bytesToHex(edPubTargetBytes.slice(0,8)));
    console.log("My FID:", myFid);
    console.log("Target FID:", selectedTargetUser.fid);

    const statusDiv = document.getElementById('searchResults'); 
    const resultsDiv = statusDiv; // for clarity in event listener later
    statusDiv.innerHTML = "<p>Processing your secret crush... Generating keys...</p>";
    statusDiv.classList.add('populated');

    try {
        console.log("Step 1: Deriving stealth key...");
        const { skPrime, pkPrime } = await deriveStealthKey(sessionKWallet, edPubTargetBytes);
        statusDiv.innerHTML = `<p>Processing... Stealth key derived.</p>`;
        console.log(`  skPrime (hex): ${bytesToHex(skPrime)}, pkPrime (hex): ${bytesToHex(pkPrime)}`);

        console.log("Step 2: Performing ECDH...");
        const sharedSecret = await performECDH(skPrime, edPubTargetBytes);
        statusDiv.innerHTML = `<p>Processing... Shared secret calculated.</p>`;
        console.log(`  Shared Secret (hex): ${bytesToHex(sharedSecret)}`);

        console.log("Step 3: Deriving symmetric key and tag...");
        const { K_AB, tag } = await deriveSymmetricKeyAndTag(sharedSecret);
        statusDiv.innerHTML = `<p>Processing... Symmetric key and tag generated.</p>`;
        console.log(`  K_AB (hex): ${bytesToHex(K_AB)}, Tag (hex): ${bytesToHex(tag)}`);

        console.log("Step 4: Encrypting payload...");
        const note = "";
        const cipherForChain = await encryptPayload(K_AB, myFid, selectedTargetUser.fid, note);
        statusDiv.innerHTML = `<p>Processing... Payload encrypted.</p>`;
        console.log(`  Cipher for chain (hex, length ${cipherForChain.length}): ${bytesToHex(cipherForChain)}`);

        // Step 5: Partial Tx build
        console.log("Step 5: Building partial transaction...");
        const base64Tx = await buildPartialTransaction(skPrime, pkPrime, tag, cipherForChain);
        statusDiv.innerHTML = `<p>Processing... Partial transaction built.</p>`;
        console.log(`  Base64 Encoded Tx for Relay: ${base64Tx.substring(0,64)}...`);

        console.log("Step 6: Posting to relay (simulated)...");
        statusDiv.innerHTML = `<p>Crush transaction ready for relay (simulated).</p>`;
        console.log(`  Would POST to /relay with the serialized transaction.`);

        setTimeout(() => {
            statusDiv.innerHTML = `
                <div style="padding: 15px;">
                    <p style="color: green; font-weight: bold; font-size: 1.1em;">Simulated Crush Sent to ${selectedTargetUser.display_name}!</p>
                    <p style="font-size: 0.9em; margin-top: 10px;">The cryptographic operations are complete. Check the debug console for detailed key information. The next steps involve building a real Solana transaction and sending it to the relay service.</p>
                    <details style="margin-top: 15px; font-size: 0.8em; background: #f9f9f9; border: 1px solid #eee; padding: 8px; border-radius: 4px;">
                        <summary>Debug: Derived Values (Click to expand)</summary>
                        <ul style="list-style-type: disc; padding-left: 20px; word-break: break-all;">
                            <li>Your FID: ${myFid}</li>
                            <li>Target FID: ${selectedTargetUser.fid}</li>
                            <li>Target Username: @${selectedTargetUser.username}</li>
                            <li>kWallet (first 8B): ${bytesToHex(sessionKWallet.slice(0,8))}...</li>
                            <li>edPubTarget (Solana Addr): ${edPubTarget}</li>
                            <li>Stealth sk\' (private key, first 8B): ${bytesToHex(skPrime.slice(0,8))}...</li>
                            <li>Stealth pk\' (public key, bs58): ${bs58.encode(pkPrime)}</li>
                            <li>Shared Secret (first 8B): ${bytesToHex(sharedSecret.slice(0,8))}...</li>
                            <li>Symmetric Key K_AB (first 8B): ${bytesToHex(K_AB.slice(0,8))}...</li>
                            <li>Tag for Indexing (first 8B): ${bytesToHex(tag.slice(0,8))}...</li>
                            <li>Cipher for Chain (112B, first 8B): ${bytesToHex(cipherForChain.slice(0,8))}...</li>
                        </ul>
                    </details>
                    <button id="searchAgainAfterCrushBtn" style="margin-top: 15px;">Send Another Crush</button>
                </div>
            `;
            document.getElementById('searchAgainAfterCrushBtn').addEventListener('click', () => {
                document.getElementById('userSearchInput').value = '';
                if(resultsDiv) {
                    resultsDiv.innerHTML = ''; 
                    resultsDiv.classList.remove('populated');
                }
                selectedTargetUser = null; 
            });
        }, 500);

    } catch (cryptoError) {
        console.error("Error during crush sequence cryptography:", cryptoError);
        statusDiv.innerHTML = `<p style="color: red; padding: 15px;">Crypto Error: ${cryptoError.message}. Check console for details.</p>`;
        statusDiv.classList.add('populated');
    }
}
