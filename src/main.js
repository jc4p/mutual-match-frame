import './style.css';
import * as frame from '@farcaster/frame-sdk';
import { sha256 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/x25519';
import { concatBytes, randomBytes } from '@noble/hashes/utils'; // For randomBytes (nonce) and concatBytes
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'; 
import { bytesToHex } from '@noble/hashes/utils';
import bs58 from 'bs58';

const API_ROOT = 'https://mutual-match-api.kasra.codes';

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
        document.addEventListener('DOMContentLoaded', initDebugConsole);
    } else {
        initDebugConsole();
    }

    const appDiv = document.getElementById('app');
    if (appDiv) {
        appDiv.innerHTML = `
            <div id="statusMessage"><p>App Initialized. Farcaster SDK loading...</p></div>
            <button id="connectWalletBtn">Connect Wallet & Sign</button>
            <div id="content">
                <p>Please wait for Farcaster SDK to be ready, then click the button.</p>
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
    const statusMessageDiv = document.getElementById('statusMessage');
    const contentDiv = document.getElementById('content');
    
    try {
        if (statusMessageDiv) statusMessageDiv.innerHTML = "<p>Farcaster SDK: Waiting for actions.ready()...</p>";
        await frame.sdk.actions.ready();
        if (statusMessageDiv) statusMessageDiv.innerHTML = "<p>Farcaster SDK Ready.</p>";
        if (contentDiv) contentDiv.innerHTML = "<p>Please click 'Connect Wallet & Sign' to begin.</p>";

    } catch (error) {
        console.error("Error during Farcaster SDK actions.ready():", error);
        if (statusMessageDiv) statusMessageDiv.innerHTML = "<p>Error initializing Farcaster SDK.</p>";
        if (contentDiv) contentDiv.innerHTML = "<p>An error occurred with Farcaster SDK. See debug console.</p>";
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

// We will also need the @noble/* crypto libraries mentioned in PRD 4.1.
// Please run:
// npm install @noble/hashes @noble/ed25519 @noble/curves
// You might need an additional library for XChaCha20-Poly1305.

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

// TODO: PRD 4.2: ECDH
// convert edPubTarget -> xPubT, xPrivS = edToCurve(sk'), shared = scalarMult(xPrivS,xPubT)
async function performECDH(skPrimeEd, edPubTargetBytes) {
  // Convert Ed25519 private key (skPrimeEd) to X25519 private key (scalar)
  const xPrivS = x25519.edwardsToMontgomeryPriv(skPrimeEd);
  
  // Convert Ed25519 public key (edPubTargetBytes) to X25519 public key
  // Noble's x25519.edwardsToMontgomeryPub expects a point, but edPubTargetBytes is a compressed point (32 bytes)
  // We first need to ensure edPubTargetBytes is a valid Ed25519 public key.
  // Then, x25519.getSharedSecret expects the other party's X25519 *public* key.
  // edwardsToMontgomeryPub will convert the Ed25519 public key to an X25519 public key.
  const xPubT = x25519.edwardsToMontgomeryPub(edPubTargetBytes);

  console.log("performECDH: xPrivS (scalar, hex, first 8B):", bytesToHex(xPrivS.slice(0,8)));
  console.log("performECDH: xPubT (X25519 pubkey, hex, first 8B):", bytesToHex(xPubT.slice(0,8)));

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
  // Payload: two FIDs (assuming they are numbers, convert to a fixed-size byte representation, e.g., 8 bytes each for u64)
  // For simplicity, let's assume FIDs fit in 4 bytes (Uint32) for now.
  // PRD doesn't specify FID byte representation, adjust if needed.
  const myFidBytes = new Uint8Array(new Uint32Array([myFid]).buffer); // 4 bytes
  const targetFidBytes = new Uint8Array(new Uint32Array([targetFid]).buffer); // 4 bytes
  const noteBytes = new TextEncoder().encode(note); // Variable length

  const payload = concatBytes(myFidBytes, targetFidBytes, noteBytes);
  const nonce = randomBytes(24); // XChaCha20-Poly1305 uses a 24-byte nonce

  const cipher = xchacha20poly1305(K_AB, nonce); // Initialize cipher with key and nonce
  const encryptedPayload = cipher.encrypt(payload); // Encrypt the data

  // The result includes the ciphertext and the Poly1305 tag.
  // For transmission, we need to send nonce + encryptedPayload (which includes the tag)
  // The PRD cipher field is 112 bytes: 24 (nonce) + payload (e.g. 4+4+X for FIDs+note) + 16 (Poly1305 tag).
  // If payload is myFid(4) + targetFid(4) = 8 bytes. Then 24 + 8 + 16 = 48 bytes.
  // This implies the "note" might be larger or there's padding, or the 112B is an upper limit.
  // Let's assume the 112B is the expected size of `cipher` to be stored on-chain.
  // This means `nonce + encryptedPayload` must be exactly 112 bytes.

  const combinedCiphertext = concatBytes(nonce, encryptedPayload);

  console.log("encryptPayload: myFidBytes (hex):", bytesToHex(myFidBytes));
  console.log("encryptPayload: targetFidBytes (hex):", bytesToHex(targetFidBytes));
  console.log("encryptPayload: noteBytes (hex):", bytesToHex(noteBytes));
  console.log("encryptPayload: payload (hex, first 16B):", bytesToHex(payload.slice(0,16)));
  console.log("encryptPayload: K_AB (hex, first 8B):", bytesToHex(K_AB.slice(0,8)));
  console.log("encryptPayload: nonce (hex):", bytesToHex(nonce));
  console.log("encryptPayload: encryptedPayload (incl. Poly1305 tag, hex, first 16B):", bytesToHex(encryptedPayload.slice(0,16)));
  console.log("encryptPayload: combinedCiphertext (nonce + encrypted, hex, first 16B):", bytesToHex(combinedCiphertext.slice(0,16)));
  console.log("encryptPayload: combinedCiphertext length:", combinedCiphertext.length);
  
  // PRD states cipher1/cipher2 on chain is [u8;112]
  if (combinedCiphertext.length > 112) {
    // This would happen if myFid(4) + targetFid(4) + noteBytes + Poly1305 tag (16) > (112 - 24 (nonce)) = 88 bytes.
    // So, myFid(4) + targetFid(4) + noteBytes must be <= 72 bytes.
    // If note is too long, we might need to truncate it or throw an error.
    console.error(`Encrypted payload (combinedCiphertext) is ${combinedCiphertext.length} bytes, exceeds 112 bytes limit. Note might be too long.`);
    throw new Error("Encrypted payload exceeds 112 byte limit. Try a shorter note.");
  }
  
  // If it's less than 112, we might need to pad it. The PRD implies a fixed size.
  // For now, let's return it and handle potential padding/truncation before on-chain submission.
  // Or, more robustly, ensure the note is constrained such that the total is exactly 112, or error if too large.
  // Let's assume for now, the note will be short enough. If not, we need a strategy.
  // If the combinedCiphertext is SHORTER than 112, we'll pad it.
  let finalCipherForChain = combinedCiphertext;
  if (combinedCiphertext.length < 112) {
    console.warn(`Combined ciphertext is ${combinedCiphertext.length} bytes, padding to 112 bytes for on-chain storage.`);
    finalCipherForChain = new Uint8Array(112);
    finalCipherForChain.set(combinedCiphertext); // Copies combinedCiphertext to the beginning of the 112-byte array
  } else if (combinedCiphertext.length > 112) {
     // This case should be caught by the check above, but as a safeguard:
    throw new Error("Encrypted payload exceeds 112 byte limit after padding considerations.");
  }


  return finalCipherForChain; 
}

// --- End Crypto Helper Functions ---

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
        const frameContext = await frame.sdk.context();
        if (!frameContext || typeof frameContext.fid !== 'number') {
            console.error("Could not get user FID from frame context:", frameContext);
            alert("Could not determine your Farcaster FID. Unable to send crush.");
            return;
        }
        myFid = frameContext.fid;
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
        statusDiv.innerHTML = `<p>Processing... Stealth key derived.</p>`; // Simplified UI message
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

        console.log("Step 5: Building partial transaction (simulated)...");
        statusDiv.innerHTML = `<p>Processing... Partial transaction prepared (simulated).</p>`;
        console.log(`  Would build transaction with:`);
        console.log(`    Instruction: submit_crush`);
        console.log(`    Cipher data (hex): ${bytesToHex(cipherForChain)}`);
        console.log(`    Signer (stealth public key, pkPrime): ${bs58.encode(pkPrime)}`);

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
