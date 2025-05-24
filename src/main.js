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
const CRUSH_PROGRAM_ID = new PublicKey('EGYUNdDL63nN7NTZbE6P7qZdbaxSyvuXyyU4iVba5jDT'); // Updated Program ID

const IS_PRODUCTION = true;

// Alias noble functions to avoid name clashes if any, and for consistency
const bytesToHex = nobleBytesToHex;
const hexToBytes = nobleHexToBytes;

console.log("Encrypted Mutual Match App Initializing...");

// --- Debug Console Start ---
let debugConsoleVisible = false; // Ensure console starts hidden (minimized)
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
let sessionPublicKey = null; // This will be set after successful signing
let sessionAppPublicKeyHex = null; // Hex string of the app-specific public key derived from kWallet
let selectedTargetUser = null; // To store { fid, username, display_name, pfp_url, primary_sol_address }
let relayerPublicKeyString = null; // Variable to store relayer's public key

// --- NEW: Store multiple key versions for migration support ---
let sessionKeyVersions = []; // Array of {kWallet, kIndex, appPublicKeyHex, version, createdAt}
let currentKeyVersion = 'v2'; // Update this when wallet provider changes
// --- End NEW ---

// --- New global variables for provider and connected public key ---
let solanaProviderInstance = null;
let userPublicKeyString = null; // Stores public key from wallet connection, before signing
// --- End new global variables ---

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
    if (!query || query.length < 1) { // MODIFIED: Changed from 2 to 1
        resultsDiv.innerHTML = '<p><small>Enter at least 1 character to search.</small></p>'; // MODIFIED: Updated message
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
                item.addEventListener('click', async () => { // Make listener async
                    const primarySolAddress = item.dataset.primarysoladdress;
                    const displayName = item.dataset.displayname;
                    const username = item.dataset.username;

                    if (!primarySolAddress) {
                        resultsDiv.innerHTML = `
                            <p>Selected: <strong>${displayName}</strong> (@${username})</p>
                            <p style="color: red;">This user does not have a verified primary Solana address. Cannot proceed.</p>
                            <p><button id="searchAgainBtn">Search Again</button></p>
                        `;
                        resultsDiv.classList.add('populated');
                        document.getElementById('searchAgainBtn').addEventListener('click', () => {
                             document.getElementById('userSearchInput').value = '';
                             resultsDiv.innerHTML = '';
                             resultsDiv.classList.remove('populated');
                        });
                        selectedTargetUser = null;
                        return;
                    }

                    // Temporarily show loading while fetching app key
                    resultsDiv.innerHTML = `<p>Checking compatibility for <strong>${displayName}</strong> (@${username})...</p>`;
                    resultsDiv.classList.add('populated');
                    document.getElementById('userSearchInput').value = ''; // Clear search input

                    try {
                        console.log(`Fetching app key for target user: ${primarySolAddress} (@${username})`);
                        
                        // --- NEW: Try to fetch all app keys for the target user ---
                        let targetUserAppPublicKeyHex = null;
                        let targetUserAppPublicKeyBytes = null;
                        let targetUserAllAppKeys = [];
                        
                        // First try to get all keys
                        const allKeysResponse = await fetch(`${API_ROOT}/api/user/${primarySolAddress}/all-app-pubkeys`);
                        if (allKeysResponse.ok) {
                            const allKeysData = await allKeysResponse.json();
                            if (allKeysData.appPublicKeys && allKeysData.appPublicKeys.length > 0) {
                                targetUserAllAppKeys = allKeysData.appPublicKeys;
                                // Use the most recent key as primary
                                const latestKey = allKeysData.appPublicKeys[allKeysData.appPublicKeys.length - 1];
                                targetUserAppPublicKeyHex = latestKey.publicKeyHex;
                                targetUserAppPublicKeyBytes = hexToBytes(targetUserAppPublicKeyHex);
                                console.log(`Fetched ${targetUserAllAppKeys.length} app keys for @${username}`);
                            }
                        } else {
                            // Fallback to single key endpoint
                            const appKeyResponse = await fetch(`${API_ROOT}/api/user/${primarySolAddress}/app-pubkey`);
                            
                            if (!appKeyResponse.ok) {
                                if (appKeyResponse.status === 404) {
                                    resultsDiv.innerHTML = `
                                        <p>Selected: <strong>${displayName}</strong> (@${username})</p>
                                        <p style="color: orange;">${displayName} needs to open this app and sign-in at least once. Gently nudge them to!</p>
                                        <p><button id="searchAgainBtn">Search Again</button></p>
                                    `;
                                    document.getElementById('searchAgainBtn').addEventListener('click', () => {
                                        document.getElementById('userSearchInput').value = '';
                                        resultsDiv.innerHTML = '';
                                        resultsDiv.classList.remove('populated');
                                    });
                                    selectedTargetUser = null; // Clear selection
                                    return;
                                } else {
                                    const errData = await appKeyResponse.json().catch(() => ({}));
                                    throw new Error(`API Error (${appKeyResponse.status}): ${errData.error || appKeyResponse.statusText}`);
                                }
                            }

                            const appKeyData = await appKeyResponse.json();
                            targetUserAppPublicKeyHex = appKeyData.appPublicKeyHex;
                            if (targetUserAppPublicKeyHex) {
                                targetUserAllAppKeys = [{
                                    publicKeyHex: targetUserAppPublicKeyHex,
                                    version: 'unknown'
                                }];
                            }
                        }
                        // --- End NEW ---

                        if (!targetUserAppPublicKeyHex) {
                            resultsDiv.innerHTML = `
                                <p>Selected: <strong>${displayName}</strong> (@${username})</p>
                                <p style="color: orange;">Could not retrieve app key for ${displayName}, even though the API responded. They may need to re-initialize the app. Try asking them to sign in again.</p>
                                <p><button id="searchAgainBtn">Search Again</button></p>
                            `;
                             document.getElementById('searchAgainBtn').addEventListener('click', () => {
                                document.getElementById('userSearchInput').value = '';
                                resultsDiv.innerHTML = '';
                                resultsDiv.classList.remove('populated');
                            });
                            selectedTargetUser = null; // Clear selection
                            return;
                        }

                        targetUserAppPublicKeyBytes = hexToBytes(targetUserAppPublicKeyHex);
                        if (targetUserAppPublicKeyBytes.length !== 32) {
                            throw new Error("Fetched target app public key is not 32 bytes.");
                        }
                        console.log(`Successfully fetched app public key for @${username}: ${targetUserAppPublicKeyHex.substring(0,8)}...`);

                        // All checks passed, store selected user and their app key
                        selectedTargetUser = {
                            fid: parseInt(item.dataset.fid),
                            username: username,
                            display_name: displayName,
                            pfp_url: item.dataset.pfpurl,
                            primary_sol_address: primarySolAddress,
                            appPublicKeyHex: targetUserAppPublicKeyHex, // Store fetched key
                            appPublicKeyBytes: targetUserAppPublicKeyBytes, // Store fetched key bytes
                            allAppKeys: targetUserAllAppKeys // NEW: Store all keys for potential future use
                        };
                        console.log("Selected target user (with app key):", selectedTargetUser);
                        resultsDiv.innerHTML = `
                            <p>Selected: <strong>${selectedTargetUser.display_name}</strong> (@${selectedTargetUser.username})</p>
                            <p style="color: green;">Compatibility check passed! Ready to send crush.</p>
                            <button id="sendCrushBtn">Send Secret Crush</button>
                        `;
                        resultsDiv.classList.add('populated'); 
                        document.getElementById('sendCrushBtn').addEventListener('click', handleSendCrush);

                    } catch (error) {
                        console.error("Error during target user selection or app key fetch:", error);
                        resultsDiv.innerHTML = `
                            <p>Selected: <strong>${displayName}</strong> (@${username})</p>
                            <p style="color: red;">Error checking compatibility: ${error.message}</p>
                            <p><button id="searchAgainBtn">Search Again</button></p>
                        `;
                        document.getElementById('searchAgainBtn').addEventListener('click', () => {
                            document.getElementById('userSearchInput').value = '';
                            resultsDiv.innerHTML = '';
                            resultsDiv.classList.remove('populated');
                        });
                        selectedTargetUser = null;
                    }
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
// THIS FUNCTION WILL BE REPLACED/REFACTORED
// async function connectAndSign() { ... }

// --- New function to handle signing and subsequent setup ---
async function performSignatureAndSetup(provider, publicKeyStrToSignWith) {
    console.log("--- performSignatureAndSetup called ---");
    const getStartedButton = document.getElementById('getStartedBtn'); // Ensure button is accessible
    const contentDiv = document.getElementById('content');

    try {
        updateStatusMessage(`Signing message with ${publicKeyStrToSignWith.slice(0,4)}...${publicKeyStrToSignWith.slice(-4)}`);
        if(getStartedButton) {
            getStartedButton.disabled = true;
            getStartedButton.textContent = 'Awaiting Signature...';
        }

        const messageString = "This is a message to confirm you are logging into encrypted mutual match using your Warplet!";
        console.log(`Attempting to sign message: "${messageString}" with provider:`, provider);
        const signedMessageResult = await provider.signMessage(messageString);
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
                 throw new Error('Signature decoding failed.');
            }
        } else {
            console.error("Unexpected signature format from signMessage. Expected an object with a string 'signature' property. Received:", signedMessageResult);
            updateStatusMessage('Error: Unexpected signature format.', true);
            throw new Error('Unexpected signature format from wallet.');
        }

        if (!signature || signature.length === 0) {
             console.error("Signature is null or empty after processing.");
             updateStatusMessage('Error: Signature processing failed.', true);
             throw new Error('Signature processing resulted in empty signature.');
        }

        sessionKWallet = sha256(signature);
        sessionPublicKey = publicKeyStrToSignWith; // Set the session's main public key

        const hotPrefix = utf8ToBytes("HOT");
        sessionKIndex = sha256(concatBytes(hotPrefix, sessionKWallet));

        // Derive and store app-specific public key
        const appSpecificPublicKeyBytes = ed25519.getPublicKey(sessionKWallet);
        sessionAppPublicKeyHex = bytesToHex(appSpecificPublicKeyBytes);
        console.log('App-specific Public Key (hex):', sessionAppPublicKeyHex);

        // Store session data in localStorage
        try {
            // --- NEW: Before storing new keys, backup current ones if they're different ---
            const existingKWalletHex = localStorage.getItem('sessionKWalletHex');
            if (existingKWalletHex && existingKWalletHex !== bytesToHex(sessionKWallet)) {
                // Keys are changing! Backup the old ones
                console.log("Detected key change, backing up previous session...");
                localStorage.setItem('sessionKWalletHex.backup', existingKWalletHex);
                localStorage.setItem('sessionPublicKeyString.backup', localStorage.getItem('sessionPublicKeyString') || '');
                localStorage.setItem('backupCreatedAt', new Date().toISOString());
            }
            // --- End NEW ---
            
            // Store current key
            localStorage.setItem('sessionKWalletHex', bytesToHex(sessionKWallet));
            localStorage.setItem('sessionPublicKeyString', sessionPublicKey);
            
            // --- NEW: Store multiple key versions ---
            const currentKeyData = {
                kWalletHex: bytesToHex(sessionKWallet),
                kIndexHex: bytesToHex(sessionKIndex),
                appPublicKeyHex: sessionAppPublicKeyHex,
                version: currentKeyVersion,
                createdAt: new Date().toISOString()
            };
            
            // Load existing key versions
            const existingKeyVersionsStr = localStorage.getItem('sessionKeyVersions');
            let existingKeyVersions = [];
            if (existingKeyVersionsStr) {
                try {
                    existingKeyVersions = JSON.parse(existingKeyVersionsStr);
                } catch (e) {
                    console.error("Error parsing existing key versions:", e);
                    existingKeyVersions = [];
                }
            }
            
            // Check if this key already exists
            const keyExists = existingKeyVersions.some(k => k.appPublicKeyHex === sessionAppPublicKeyHex);
            if (!keyExists) {
                existingKeyVersions.push(currentKeyData);
                // Keep only the last 5 keys to avoid unbounded growth
                if (existingKeyVersions.length > 5) {
                    existingKeyVersions = existingKeyVersions.slice(-5);
                }
                localStorage.setItem('sessionKeyVersions', JSON.stringify(existingKeyVersions));
            }
            
            // Update in-memory array
            sessionKeyVersions = existingKeyVersions.map(k => ({
                kWallet: hexToBytes(k.kWalletHex),
                kIndex: hexToBytes(k.kIndexHex),
                appPublicKeyHex: k.appPublicKeyHex,
                version: k.version,
                createdAt: k.createdAt
            }));
            // --- End NEW ---
            
            console.log("Session keys stored in localStorage.");
        } catch (e) {
            console.error("Error saving session keys to localStorage:", e);
            // Proceed without localStorage if it fails, but log the error
        }

        console.log('Raw signature (first 16 bytes hex): ', bytesToHex(signature.slice(0,16)));
        console.log('kWallet (hex, first 8 bytes):', bytesToHex(sessionKWallet.slice(0,8)));
        console.log('kIndex (hex, first 8 bytes):', bytesToHex(sessionKIndex.slice(0,8)));
        
        updateStatusMessage(`Signed in! Wallet: ${sessionPublicKey.slice(0,4)}...${sessionPublicKey.slice(-4)}`);
        
        // Initial layout: Mutual Matches at top, then Submit, then Other Crushes
        if(contentDiv) contentDiv.innerHTML = `
            <div id="mutualMatchesContainerPlaceholder"></div> 
            <hr style="margin: 20px 0; border-color: #eee;">
            <p>Submit New Crush:</p>
            <input type="text" id="userSearchInput" class="user-search-input" placeholder="Search by username...">
            <div id="searchResults" class="search-results-container"></div>
            <hr style="margin: 20px 0; border-color: #eee;">
            <div id="userIndexContainerPlaceholder"></div> 
        `;
        document.getElementById('userSearchInput').addEventListener('input', (e) => {
            debouncedSearchUsers(e.target.value);
        });
        
        if(getStartedButton) getStartedButton.style.display = 'none'; // Hide after successful sign-in and setup

        await loadAndDisplayUserIndex();
        await fetchRelayerPublicKey(); // Fetch relayer key after successful sign-in
        
        // After successful sign-in and key derivation, update the server with the app public key
        // This might also be a good place to initially fetch/create the user record if it doesn't exist.
        // We'll use a combined function to update index and app key.
        console.log("Attempting to register app public key with server...");
        const initialIndexData = await getDecryptedUserIndexFromServer(); // Get current index, or empty array
        await updateUserIndexAndAppKeyOnApi(initialIndexData, sessionAppPublicKeyHex, currentKeyVersion); // Pass version

        return { kWallet: sessionKWallet, publicKey: sessionPublicKey, kIndex: sessionKIndex, appPublicKeyHex: sessionAppPublicKeyHex };

    } catch (error) {
        console.error("Error in performSignatureAndSetup process:", error);
        updateStatusMessage(`Error during sign-in: ${error.message}.`, true);
        
        // Reset session state
        sessionKWallet = null;
        sessionPublicKey = null;
        sessionKIndex = null;
        userPublicKeyString = null; // Clear connected public key as well
        sessionAppPublicKeyHex = null; // Clear app public key hex

        if(contentDiv) contentDiv.innerHTML = `<p>Sign-in process failed. See console for details. <button id="getStartedBtn">Try Again</button></p>`;
        
        const newGetStartedButton = document.getElementById('getStartedBtn');
        if (newGetStartedButton) { // If button was re-added to contentDiv
            newGetStartedButton.textContent = 'Authenticate';
            newGetStartedButton.disabled = false;
            newGetStartedButton.addEventListener('click', handleGetStartedClick); // Re-attach main handler
        } else if (getStartedButton) { // If original button is still there (e.g. contentDiv not replaced)
             getStartedButton.disabled = false;
             getStartedButton.textContent = 'Connect Wallet & Sign In';
        }
        return null;
    }
}
// --- End new function ---

function initializeApp() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            if (!IS_PRODUCTION) {
                initDebugConsole();
            }
            initHowItWorksModal(); // Initialize modal controls
            populateHowItWorksModal(); // Populate modal content
        });
    } else {
        if (!IS_PRODUCTION) {
            initDebugConsole();
        }
        initHowItWorksModal();
        populateHowItWorksModal();
    }

    const appDiv = document.getElementById('app');
    if (appDiv) {
        // Step A: Initial Welcome Screen
        appDiv.innerHTML = `
            <div id="statusMessage"><p>Ready.</p></div>
            <div id="content">
                <h3>Private, secret, fully encrypted onchain crushes.</h3>
                <p>Tell the Solana chain (securely!) who you like. If they like you back you'll both be notified!</p>
                <p>For a match to work, the person you're interested in must also have signed into this app at least once.</p>
                <button id="getStartedBtn" disabled>Loading SDK...</button>
            </div>
        `;

        // Step B: Triggering Wallet Connection
        const getStartedButton = document.getElementById('getStartedBtn');
        if (getStartedButton) {
            getStartedButton.addEventListener('click', handleGetStartedClick);
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
        <p><strong>Important:</strong> For a mutual match to be detected, <strong>both you and the person you're interested in must have signed into Mutual Match at least once.</strong> This allows the app to generate the necessary secure keys for both of you.</p>

        <h3>How It Works</h3>
        <ul>
            <li>✍️ <strong>Sign In & Key Generation:</strong> When you first sign in with your wallet, the app generates a unique, app-specific private and public key pair. Your app-specific public key is registered with our server, associated with your main wallet address. This key is different from your main wallet key and is only used for Mutual Match.</li>
            <li>🎯 <strong>Select Your Crush:</strong> You search for and select a Farcaster user.</li>
            <li>🔑 <strong>Symmetric Secret:</strong> If your selected crush has also signed into Mutual Match at least once (meaning their app-specific public key is registered), your app and their app can independently derive a secret shared cryptographic key. This key is identical for both of you for this specific pairing.</li>
            <li>🤫 <strong>Express a Crush:</strong> Your app uses this shared secret to generate a unique "tag" (like a secret mailbox address) and an encryption key. Your 'crush' message (which includes your Farcaster ID and their Farcaster ID) is then encrypted.</li>
            <li>🔒 <strong>Encryption Magic:</strong> Your choice is encrypted using this symmetric key. Only someone who can generate the same key (i.e., your mutual crush, if they also use the app and crush on you) can decrypt it. The server cannot read it.</li>
            <li>🔗 <strong>Onchain (but private!):</strong> An encrypted piece of data, along with the unique tag, is sent to the Solana blockchain. This data doesn't directly reveal who you are or who you crushed on to the public.</li>
            <li>🎉 <strong>Mutual Match:</strong> If the person you crushed on also crushes on you using this app, their app will generate the *exact same tag* and *exact same encryption key*. They'll post their encrypted crush to the same on-chain "mailbox." The system then detects two messages in this shared spot, and both your apps can decrypt the other's message. Both of you will be notified of the mutual match! Otherwise, your crush remains a secret.</li>
        </ul>

        <h3>Security & Privacy</h3>
        <ul>
            <li>🛡️ <strong>App-Specific Keys:</strong> Your main wallet's private key is never used directly for crush mechanics, only for the initial sign-in to generate your app-specific keys.</li>
            <li>🗝️ <strong>Server Stores App Public Key:</strong> Our server stores your app-specific *public* key to enable others to initiate a crush sequence with you. Your app-specific *private* key (derived from your wallet signature) never leaves your device/browser session.</li>
            <li>🔐 <strong>End-to-End Encryption for Matches:</strong> Only you and a mutual crush can decrypt the exchanged Farcaster IDs.</li>
            <li>🚫 <strong>Not <em>Technically</em> Zero-Knowledge:</strong> While we use strong encryption and privacy techniques, this system isn't strictly 'zero-knowledge' in the formal cryptographic sense. However, it's designed to be highly private and secure for its purpose.</li>
        </ul>

        <h3>Benefits</h3>
        <ul>
            <li>Discreet way to find mutual connections.</li>
            <li>Strong, symmetric encryption protects your choices if there's a match.</li>
            <li>Anonymous onchain interactions for crush submissions.</li>
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

async function handleGetStartedClick() {
    const getStartedButton = document.getElementById('getStartedBtn'); // Ensure we have the button

    if (!solanaProviderInstance) {
        updateStatusMessage("Solana Provider not initialized. Cannot connect.", true);
        console.error("handleGetStartedClick: solanaProviderInstance is null.");
        if(getStartedButton) {
            getStartedButton.disabled = false; // Allow retry if it was a UI glitch
            getStartedButton.textContent = 'Provider Error - Retry';
        }
        return;
    }

    if(getStartedButton) {
        getStartedButton.disabled = true;
        getStartedButton.textContent = 'Connecting Wallet...';
    }
    updateStatusMessage("Awaiting wallet connection approval...");

    try {
        const connectionResponse = await solanaProviderInstance.request({ method: 'connect' });
        const pkString = connectionResponse?.publicKey;

        if (!pkString || typeof pkString !== 'string') {
            console.error("Could not get public key as a string from Solana provider. Received:", pkString);
            updateStatusMessage('Error: Could not get public key string.', true);
            throw new Error("Wallet connection did not return a valid public key string.");
        }
        
        userPublicKeyString = pkString; // Store globally upon successful connection
        console.log("Wallet connected successfully. Public Key:", userPublicKeyString);
        updateStatusMessage(`Wallet connected: ${userPublicKeyString.slice(0,4)}...${userPublicKeyString.slice(-4)}. Now, proceed to sign message.`);

        // Now call the signing part
        await performSignatureAndSetup(solanaProviderInstance, userPublicKeyString);

    } catch (connectError) {
        console.error("Error connecting to Solana wallet:", connectError);
        updateStatusMessage(`Error connecting wallet: ${connectError.message}. Please try again.`, true);
        if(getStartedButton) {
            getStartedButton.disabled = false;
            getStartedButton.textContent = 'Authenticate';
        }
        userPublicKeyString = null; // Clear on error
        const contentDiv = document.getElementById('content');
        if(contentDiv && !document.getElementById('getStartedBtn')) { // If button was removed by performSignatureAndSetup error path
            contentDiv.innerHTML = `<p>Wallet connection failed. <button id="getStartedBtn">Try Again</button></p>`;
            const newButton = document.getElementById('getStartedBtn');
            if (newButton) {
                newButton.addEventListener('click', handleGetStartedClick);
            }
        }
    }
}

function handleSignOut() {
    console.log("Signing out and clearing session data from localStorage...");
    try {
        localStorage.removeItem('sessionKWalletHex');
        localStorage.removeItem('sessionPublicKeyString');
        localStorage.removeItem('sessionKeyVersions'); // NEW: Remove key versions too
        // Optionally, clear other session-related variables if they are not reset by page load
        sessionKWallet = null;
        sessionPublicKey = null;
        sessionKIndex = null;
        sessionAppPublicKeyHex = null;
        userPublicKeyString = null;
        selectedTargetUser = null;
        sessionKeyVersions = []; // NEW: Clear key versions
        // No need to clear solanaProviderInstance if it's managed by the SDK and might be reused.
    } catch (e) {
        console.error("Error clearing localStorage during sign out:", e);
    }
    updateStatusMessage("Signed out successfully.");
    // Reload the page to reset the UI and state to initial
    window.location.reload();
}

document.addEventListener('DOMContentLoaded', async () => {
    initializeApp(); // Call initializeApp after DOM is loaded

    const statusMessageDiv = document.getElementById('statusMessage');
    const contentDiv = document.getElementById('content');
    const getStartedButton = document.getElementById('getStartedBtn'); // Fetch button after DOM is ready
    
    try {
        if (statusMessageDiv) statusMessageDiv.innerHTML = "<p>Farcaster SDK: Waiting for actions.ready()...</p>";
        await frame.sdk.actions.ready();
        if (statusMessageDiv) statusMessageDiv.innerHTML = "<p>Farcaster SDK Ready. Initializing Solana Provider...</p>";

        solanaProviderInstance = await frame.sdk.experimental.getSolanaProvider();

        // Check for stored session data BEFORE enabling the Authenticate button
        const storedKWalletHex = localStorage.getItem('sessionKWalletHex');
        const storedPublicKeyString = localStorage.getItem('sessionPublicKeyString');

        if (storedKWalletHex && storedPublicKeyString && solanaProviderInstance) {
            console.log("Found stored session data. Attempting to restore session...");
            updateStatusMessage("Restoring previous session...");
            try {
                sessionKWallet = hexToBytes(storedKWalletHex);
                sessionPublicKey = storedPublicKeyString;
                userPublicKeyString = storedPublicKeyString; // Also set this for consistency if provider uses it

                const hotPrefix = utf8ToBytes("HOT");
                sessionKIndex = sha256(concatBytes(hotPrefix, sessionKWallet));
                const appSpecificPublicKeyBytes = ed25519.getPublicKey(sessionKWallet);
                sessionAppPublicKeyHex = bytesToHex(appSpecificPublicKeyBytes);

                // --- NEW: Load all key versions from localStorage ---
                const storedKeyVersionsStr = localStorage.getItem('sessionKeyVersions');
                if (storedKeyVersionsStr) {
                    try {
                        const storedKeyVersions = JSON.parse(storedKeyVersionsStr);
                        sessionKeyVersions = storedKeyVersions.map(k => ({
                            kWallet: hexToBytes(k.kWalletHex),
                            kIndex: hexToBytes(k.kIndexHex),
                            appPublicKeyHex: k.appPublicKeyHex,
                            version: k.version,
                            createdAt: k.createdAt
                        }));
                        console.log(`Loaded ${sessionKeyVersions.length} key versions from localStorage`);
                    } catch (e) {
                        console.error("Error loading key versions from localStorage:", e);
                        sessionKeyVersions = [];
                    }
                }
                
                // --- NEW: Also try to recover from backup if available ---
                const backupKWalletHex = localStorage.getItem('sessionKWalletHex.backup');
                if (backupKWalletHex) {
                    try {
                        const backupKWallet = hexToBytes(backupKWalletHex);
                        const backupKIndex = sha256(concatBytes(utf8ToBytes("HOT"), backupKWallet));
                        const backupAppPublicKeyHex = bytesToHex(ed25519.getPublicKey(backupKWallet));
                        
                        // Add to sessionKeyVersions if not already there
                        const backupExists = sessionKeyVersions.some(k => k.appPublicKeyHex === backupAppPublicKeyHex);
                        if (!backupExists) {
                            sessionKeyVersions.unshift({ // Add at beginning since it's older
                                kWallet: backupKWallet,
                                kIndex: backupKIndex,
                                appPublicKeyHex: backupAppPublicKeyHex,
                                version: 'v1-backup',
                                createdAt: localStorage.getItem('backupCreatedAt') || new Date(Date.now() - 86400000).toISOString()
                            });
                            console.log("Loaded backup session key");
                        }
                    } catch (e) {
                        console.error("Error loading backup session:", e);
                    }
                }
                // --- End NEW ---

                console.log('Restored kWallet (hex, first 8 bytes):', bytesToHex(sessionKWallet.slice(0,8)));
                console.log('Restored sessionPublicKey:', sessionPublicKey);
                console.log('Restored App-specific Public Key (hex):', sessionAppPublicKeyHex);
                updateStatusMessage(`Session restored for ${sessionPublicKey.slice(0,4)}...${sessionPublicKey.slice(-4)}`);
                
                // UI updates similar to successful performSignatureAndSetup
                if(contentDiv) contentDiv.innerHTML = `
                    <div id="mutualMatchesContainerPlaceholder"></div> 
                    <hr style="margin: 20px 0; border-color: #eee;">
                    <p>Submit New Crush:</p>
                    <input type="text" id="userSearchInput" class="user-search-input" placeholder="Search by username...">
                    <div id="searchResults" class="search-results-container"></div>
                    <hr style="margin: 20px 0; border-color: #eee;">
                    <div id="userIndexContainerPlaceholder"></div> 
                    <button id="signOutBtn" style="margin-top: 20px; background-color: #f44336; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer;">Sign Out</button>
                `;
                document.getElementById('userSearchInput').addEventListener('input', (e) => {
                    debouncedSearchUsers(e.target.value);
                });
                const signOutButton = document.getElementById('signOutBtn');
                if (signOutButton) {
                    signOutButton.addEventListener('click', handleSignOut);
                }
        
                if(getStartedButton) getStartedButton.style.display = 'none';

                await loadAndDisplayUserIndex();
                await fetchRelayerPublicKey();
                // No need to call updateUserIndexAndAppKeyOnApi here unless we confirm it's necessary for re-sync

            } catch (restoreError) {
                console.error("Error restoring session from localStorage:", restoreError);
                localStorage.removeItem('sessionKWalletHex'); // Clear corrupted/invalid data
                localStorage.removeItem('sessionPublicKeyString');
                updateStatusMessage("Error restoring session. Please authenticate.", true);
                // Fall through to enable Authenticate button
                 if (getStartedButton) {
                    getStartedButton.disabled = false;
                    getStartedButton.textContent = 'Authenticate';
                }
            }
        } else if (solanaProviderInstance) {
            if (statusMessageDiv) statusMessageDiv.innerHTML = "<p>Solana Provider available. Click 'Authenticate'.</p>";
            if (getStartedButton) {
                getStartedButton.disabled = false;
                getStartedButton.textContent = 'Authenticate';
            }
        } else {
            console.error("Failed to get Solana Provider from Farcaster SDK.");
            if (statusMessageDiv) statusMessageDiv.innerHTML = "<p>Error: Solana Wallet Provider not available from SDK.</p>";
            if (getStartedButton) {
                getStartedButton.disabled = true;
                getStartedButton.textContent = 'Solana Provider Error';
            }
        }
    } catch (error) {
        console.error("Error during Farcaster SDK actions.ready() or Solana Provider init:", error);
        const currentStatus = document.getElementById('statusMessage'); // Re-fetch
        const currentContent = document.getElementById('content'); // Re-fetch
        const getStartedButtonOnError = document.getElementById('getStartedBtn'); // Re-fetch

        if (currentStatus) currentStatus.innerHTML = "<p>Error initializing Farcaster SDK or Solana Provider.</p>";
        if (currentContent) currentContent.innerHTML = "<p>An error occurred. See debug console.</p>";
        if (getStartedButtonOnError) {
            getStartedButtonOnError.disabled = true;
            getStartedButtonOnError.textContent = 'SDK/Provider Init Error';
        }
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
  console.log("deriveStealthKey (Directional for Tx Signing): kWallet (hex, first 8B):", bytesToHex(kWallet.slice(0,8)));
  console.log("deriveStealthKey (Directional for Tx Signing): edPubTargetBytes (hex, first 8B):", bytesToHex(edPubTargetBytes.slice(0,8)));

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

// PRD 4.2: ECDH - MODIFIED FOR SYMMETRIC SHARED SECRET
// This function will now compute a shared secret between two APP-SPECIFIC keys.
// myAppSkBytes: The current user's app-specific private key (sessionKWallet).
// theirAppPkEdBytes: The target user's app-specific public key (fetched from server).
async function generateSymmetricSharedSecret(myAppSkBytes, theirAppPkEdBytes) {
  console.log("generateSymmetricSharedSecret: myAppSkBytes (hex, first 8B):", bytesToHex(myAppSkBytes.slice(0,8)));
  console.log("generateSymmetricSharedSecret: theirAppPkEdBytes (hex, first 8B):", bytesToHex(theirAppPkEdBytes.slice(0,8)));
  
  // Convert Ed25519 private key (myAppSkBytes) to X25519 private key (scalar)
  const myAppX25519Sk = edwardsToMontgomeryPriv(myAppSkBytes);
  
  // Convert Ed25519 public key (theirAppPkEdBytes) to X25519 public key
  const theirAppX25519Pk = edwardsToMontgomeryPub(theirAppPkEdBytes);

  console.log("generateSymmetricSharedSecret: myAppX25519Sk (scalar, hex, first 8B):", bytesToHex(myAppX25519Sk.slice(0,8)));
  console.log("generateSymmetricSharedSecret: theirAppX25519Pk (X25519 pubkey, hex, first 8B):", bytesToHex(theirAppX25519Pk.slice(0,8)));

  const sharedSecret = await x25519.getSharedSecret(myAppX25519Sk, theirAppX25519Pk); 
  
  console.log("generateSymmetricSharedSecret: sharedSecret (hex, first 8B):", bytesToHex(sharedSecret.slice(0,8)));
  if (sharedSecret.length !== 32) {
    console.error(`generateSymmetricSharedSecret: sharedSecret length is ${sharedSecret.length}, expected 32.`);
    throw new Error("Symmetric ECDH shared secret is not 32 bytes.");
  }
  return sharedSecret;
}

// TODO: PRD 4.2: Symmetric key & tag - MODIFIED FOR SYMMETRIC DERIVATION
// K = SHA256(sharedSecret || "pair")
// tag = SHA256("tag" || K_AB)
// This function will now derive keys from the SYMMETRIC shared secret.
async function deriveSymmetricKeysFromSharedSecret(symmetricSharedSecret) {
  console.log("deriveSymmetricKeysFromSharedSecret: symmetricSharedSecret (hex, first 8B):", bytesToHex(symmetricSharedSecret.slice(0,8)));
  
  // Use distinct, versioned suffixes for key and tag to avoid collisions if logic changes
  const encryptionKeySuffix = utf8ToBytes("mutual_match_v3_key");
  const K_common = sha256(concatBytes(symmetricSharedSecret, encryptionKeySuffix));

  const tagSuffix = utf8ToBytes("mutual_match_v3_tag");
  // To ensure tag symmetry regardless of who initiates:
  // Sort the two app public keys involved (lexicographically by hex string) and include them in tag derivation.
  // This makes the tag independent of "my app PK" vs "their app PK" order.
  // However, the shared secret itself IS symmetric if derived correctly (ECDH(sk_A, pk_B) == ECDH(sk_B, pk_A)).
  // So, just using the shared secret + suffix for the tag should be sufficient for symmetry.
  const tag_common = sha256(concatBytes(symmetricSharedSecret, tagSuffix));
  
  console.log("deriveSymmetricKeysFromSharedSecret: K_common (hex, first 8B):", bytesToHex(K_common.slice(0,8)));
  console.log("deriveSymmetricKeysFromSharedSecret: tag_common (hex, first 8B):", bytesToHex(tag_common.slice(0,8)));

  if (K_common.length !== 32) throw new Error("Symmetric encryption key K_common is not 32 bytes.");
  if (tag_common.length !== 32) throw new Error("Symmetric tag_common is not 32 bytes.");
  
  return { symmetricEncryptionKey: K_common, symmetricTag: tag_common };
}

// TODO: PRD 4.2: Encrypt payload
// XChaCha20-Poly1305; nonce=24 B. Payload = two FIDs + optional note
// K_common is the symmetric encryption key
async function encryptPayload(K_common, myFid, targetFid, note = "") {
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
  const cipher = xchacha20poly1305(K_common, nonce); // Use K_common
  const encryptedPayload = cipher.encrypt(payload);
  const combinedCiphertext = concatBytes(nonce, encryptedPayload);

  console.log("encryptPayload: myFidBytes (hex):", bytesToHex(myFidBytes));
  console.log("encryptPayload: targetFidBytes (hex):", bytesToHex(targetFidBytes));
  // console.log("encryptPayload: noteBytes (hex):", bytesToHex(noteBytes)); // Note is empty
  console.log("encryptPayload: payload (FIDs only, hex):", bytesToHex(payload));
  console.log("encryptPayload: K_common (hex, first 8B):", bytesToHex(K_common.slice(0,8)));
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
// skPrime, pkPrime: from directional deriveStealthKey (for signing the TX)
// symmetricTag: from deriveSymmetricKeysFromSharedSecret (for PDA derivation)
// cipherForChain: encrypted payload using K_common
async function buildPartialTransaction(skPrime, pkPrime, symmetricTag, cipherForChain, relayerB58PublicKey) {
    console.log("buildPartialTransaction: pkPrime (signer, bs58):", bs58.encode(pkPrime));
    console.log("buildPartialTransaction: symmetricTag (for PDA, hex):", bytesToHex(symmetricTag));
    console.log("buildPartialTransaction: cipherForChain (hex):", bytesToHex(cipherForChain.slice(0,16)) + "...");
    console.log("buildPartialTransaction: Relayer PubKey for feePayer:", relayerB58PublicKey);

    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

    // Fetch a fresh blockhash just before building the transaction
    console.log("buildPartialTransaction: Fetching fresh blockhash...");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    console.log(`  buildPartialTransaction: Fresh blockhash: ${blockhash}, LastValidBlockHeight: ${lastValidBlockHeight}`);

    // 1. Derive the PDA for the crush account using the SYMMETRIC tag
    const pdaSeeds = [
        Buffer.from("crush"), 
        Buffer.from(symmetricTag) // Use symmetricTag here                    
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
    // The _tag argument to the instruction itself should be the symmetricTag
    const tagArgBuffer = Buffer.from(symmetricTag); // Use symmetricTag here
    const cipherArgBuffer = Buffer.from(cipherForChain);
    const instructionData = Buffer.concat([Buffer.from(sighash), tagArgBuffer, cipherArgBuffer]);

    console.log(`  Instruction data sighash (hex): ${bytesToHex(sighash)}`);
    console.log(`  Instruction data symmetricTag arg (hex): ${bytesToHex(tagArgBuffer)}`);
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
    
    // Try with current kIndex first
    const aes = gcm(kIndex, nonce);
    try {
        const plaintext = await aes.decrypt(ciphertext);
        return JSON.parse(bytesToUtf8(plaintext));
    } catch (e) {
        console.log("Failed to decrypt index with current kIndex, trying historical keys...");
        
        // Try with historical kIndex values
        for (const keyVersion of sessionKeyVersions) {
            if (bytesToHex(keyVersion.kIndex) === bytesToHex(kIndex)) {
                continue; // Skip current key, we already tried it
            }
            
            try {
                const historicalAes = gcm(keyVersion.kIndex, nonce);
                const plaintext = await historicalAes.decrypt(ciphertext);
                const decryptedData = JSON.parse(bytesToUtf8(plaintext));
                
                console.log(`Successfully decrypted index with historical key version ${keyVersion.version}. Migrating to current key...`);
                
                // Re-encrypt with current kIndex and save
                await updateUserIndexOnApi(decryptedData);
                
                return decryptedData;
            } catch (historicalError) {
                // This historical key didn't work, try next
            }
        }
        
        console.error("Failed to decrypt index with any available keys:", e);
        throw new Error("Failed to decrypt index. It might be corrupted or you may need to recover your old session keys.");
    }
}

// New helper function to fetch the decrypted user index from the server
async function getDecryptedUserIndexFromServer() {
    if (!sessionKIndex || !sessionPublicKey) {
        console.warn("Cannot load user index: kIndex or publicKey not available.");
        return []; // Return empty array if session not ready
    }
    try {
        const response = await fetch(`${API_ROOT}/api/user/${sessionPublicKey}`); // Uses main session public key
        if (response.ok) {
            const data = await response.json();
            if (data.encryptedIndex) {
                return await decryptIndex(data.encryptedIndex, sessionKIndex);
            }
        } else if (response.status === 404) {
            console.log("No index found for user (404 from server). New user or empty index.");
        } else {
            const errorData = await response.json().catch(() => ({}));
            console.error("Error fetching user index:", response.status, errorData);
            // Fallthrough to return empty array on error
        }
    } catch (error) {
        console.error("Network or parsing error fetching user index:", error);
        // Fallthrough to return empty array on error
    }
    return []; // Default to empty array if no index or error
}

// Modified function to update index AND app public key
async function updateUserIndexAndAppKeyOnApi(indexArrayToSave, appPublicKeyHexToSend, version = null) {
    if (!sessionKIndex || !sessionPublicKey) {
        console.error("kIndex or sessionPublicKey not available for updating user data.");
        updateStatusMessage("Login session error, cannot sync data.", true);
        return false;
    }
    updateStatusMessage("Syncing your data with server...");

    try {
        let encryptedIndexToSend = null;
        if (indexArrayToSave) { // Only encrypt if there's an index to save
            console.log("Encrypting index for server...");
            encryptedIndexToSend = await encryptIndex(indexArrayToSave, sessionKIndex);
        }

        const payload = {};
        if (encryptedIndexToSend !== null) {
            payload.encryptedIndex = encryptedIndexToSend;
        }
        if (appPublicKeyHexToSend !== null) { // Allow sending just app key, or just index, or both
            payload.appPublicKeyHex = appPublicKeyHexToSend;
            if (version !== null) {
                payload.appKeyVersion = version; // NEW: Include version if provided
            }
        }

        if (Object.keys(payload).length === 0) {
            console.log("No data to update on server (neither index nor app public key provided).");
            return true; // Nothing to do, so consider it a success.
        }

        console.log(`PUTting updated data for ${sessionPublicKey}...`, payload);
        const putResponse = await fetch(`${API_ROOT}/api/user/${sessionPublicKey}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!putResponse.ok) {
            const errorData = await putResponse.json().catch(() => ({}));
            console.error("Error updating user data on server:", putResponse.status, errorData);
            throw new Error(`Failed to update user data: ${errorData.error || putResponse.statusText}`);
        }

        const putResult = await putResponse.json();
        console.log("Successfully updated user data on server:", putResult);
        updateStatusMessage("Your data synced with server!");
        
        // If an index was part of the update, display it
        if (indexArrayToSave) {
            displayUserIndex(indexArrayToSave);
        }
        return true;

    } catch (error) {
        console.error("Error in updateUserIndexAndAppKeyOnApi:", error);
        updateStatusMessage(`Failed to sync data: ${error.message}`, true);
        return false;
    }
}

// Keep old updateUserIndexOnApi for calls that ONLY update the index (like after a crush status change)
// but it should now call the new combined function, passing null for appPublicKeyHex
async function updateUserIndexOnApi(updatedIndexArray) {
    return await updateUserIndexAndAppKeyOnApi(updatedIndexArray, null, null); // Pass null for appPublicKeyHex and version
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
    let userAppKeyFromServer = null; // To store our own app key if fetched

    try {
        const response = await fetch(`${API_ROOT}/api/user/${sessionPublicKey}`); // Fetches {encryptedIndex, appPublicKeyHex}
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
            if (data.appPublicKeyHex) { // Store our own app public key if server provides it
                sessionAppPublicKeyHex = data.appPublicKeyHex; // Update global session var
                userAppKeyFromServer = data.appPublicKeyHex;
                console.log("Own app public key loaded from server:", userAppKeyFromServer);
            } else if (!sessionAppPublicKeyHex) { // If not set globally and not from server
                 console.warn("Own app public key not found on server and not set locally. Mutual match decryption might fail for new crushes until app key is synced.");
            }
        } else if (response.status === 404) {
            console.log("No user data found on server before adding new crush. Will create new index.");
        } else {
            console.warn("Error fetching user index before adding new crush, proceeding with empty list.");
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
        // Ensure entry has a valid symmetricTag and symmetricKeyHex for checks
        if (!entry.symmetricTag || !entry.symmetricKeyHex) {
            console.warn(`Entry ${idx} is missing symmetricTag or symmetricKeyHex. FID: ${entry.targetFid}. This entry might be from an old version.`);
        }
    });
    console.log("--- End Full Decrypted User Index ---");

    // Now, check status of pending crushes
    let anIndexWasUpdated = false;
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

    for (let i = 0; i < localDecryptedIndex.length; i++) {
        const entry = localDecryptedIndex[i];
        if (entry.status === "pending") {
            // CRITICAL: Use entry.symmetricTag for PDA derivation
            if (!entry.symmetricTag) {
                console.warn(`Skipping check for entry to FID ${entry.targetFid} because symmetricTag is missing (old entry format?).`);
                continue;
            }
            
            // --- NEW: Check all possible tags, not just the primary one ---
            const tagsToCheck = [entry.symmetricTag];
            
            // Add all stored possible tags if available
            if (entry.allPossibleTags && Array.isArray(entry.allPossibleTags)) {
                tagsToCheck.push(...entry.allPossibleTags.filter(t => t !== entry.symmetricTag));
            }
            
            // If we don't have allPossibleTags stored, generate them now
            if (!entry.allPossibleTags && entry.targetUserSolAddress) {
                console.log(`Generating possible tags for existing entry to ${entry.targetUsername}...`);
                try {
                    // Fetch target's all keys
                    const targetAllKeysResponse = await fetch(`${API_ROOT}/api/user/${entry.targetUserSolAddress}/all-app-pubkeys`);
                    if (targetAllKeysResponse.ok) {
                        const targetAllKeysData = await targetAllKeysResponse.json();
                        if (targetAllKeysData.appPublicKeys && targetAllKeysData.appPublicKeys.length > 0) {
                            // Include our historical keys
                            const ourKeyVersions = [
                                {
                                    kWallet: sessionKWallet,
                                    appPublicKeyHex: sessionAppPublicKeyHex,
                                    version: 'current'
                                },
                                ...sessionKeyVersions
                            ];
                            
                            // Generate all possible tags
                            for (const ourKey of ourKeyVersions) {
                                for (const theirKey of targetAllKeysData.appPublicKeys) {
                                    try {
                                        const theirKeyBytes = hexToBytes(theirKey.publicKeyHex);
                                        const altSharedSecret = await generateSymmetricSharedSecret(ourKey.kWallet, theirKeyBytes);
                                        const { symmetricTag: altTag } = await deriveSymmetricKeysFromSharedSecret(altSharedSecret);
                                        const altTagHex = bytesToHex(altTag);
                                        
                                        if (!tagsToCheck.includes(altTagHex)) {
                                            tagsToCheck.push(altTagHex);
                                        }
                                    } catch (e) {
                                        // Skip this combination
                                    }
                                }
                            }
                            
                            // Update the entry with all possible tags for future checks
                            localDecryptedIndex[i].allPossibleTags = tagsToCheck;
                            anIndexWasUpdated = true;
                        }
                    }
                } catch (e) {
                    console.warn(`Failed to generate alternative tags for ${entry.targetUsername}:`, e);
                }
            }
            
            console.log(`Checking ${tagsToCheck.length} possible tags for pending crush to ${entry.targetUsername}`);
            
            let foundMutual = false;
            let mutualTag = null;
            let pdaData = null;
            
            // Check each possible tag
            for (const tagHex of tagsToCheck) {
                try {
                    const tagBytes = hexToBytes(tagHex);
                    const pdaSeeds = [Buffer.from("crush"), Buffer.from(tagBytes)];
                    const [pdaPublicKey, _] = PublicKey.findProgramAddressSync(pdaSeeds, CRUSH_PROGRAM_ID);
                    
                    console.log(`  Checking PDA for tag ${tagHex.substring(0,16)}...: ${pdaPublicKey.toBase58()}`);
                    const accountInfo = await connection.getAccountInfo(pdaPublicKey);
                    
                    if (accountInfo && accountInfo.data) {
                        // Skip 8-byte discriminator for Anchor accounts
                        const pdaDataCheck = CRUSH_PDA_LAYOUT.decode(accountInfo.data.slice(8));
                        
                        if (pdaDataCheck.filled === 2) {
                            console.log(`  Found mutual match at tag ${tagHex.substring(0,16)}...!`);
                            foundMutual = true;
                            mutualTag = tagHex;
                            pdaData = pdaDataCheck;
                            break;
                        }
                    }
                } catch (e) {
                    // This tag doesn't exist or error checking, continue to next
                }
            }
            // --- End NEW ---
            
            if (foundMutual && pdaData) {
                console.log(`Processing mutual match found at tag ${mutualTag.substring(0,16)}...`);
                
                // Try to decrypt with various keys
                // First, we need to identify which encryption key to use
                let encryptionKeyToUse = null;
                let K_common_bytes = null;
                
                if (entry.symmetricKeyHex) {
                    K_common_bytes = hexToBytes(entry.symmetricKeyHex);
                    encryptionKeyToUse = 'original';
                }
                
                // If the mutual was found on a different tag, we might need a different key
                if (mutualTag !== entry.symmetricTag && entry.allPossibleTags) {
                    console.log(`Mutual found on alternative tag, may need different encryption key...`);
                    // We'd need to regenerate the encryption key for this specific tag
                    // This is complex - for now, try with the original key first
                }
                
                if (K_common_bytes) {
                    const pdaCipher1_onchain_b64 = Buffer.from(pdaData.cipher1).toString('base64');
                    const pdaCipher2_onchain_b64 = Buffer.from(pdaData.cipher2).toString('base64');
                    let otherCipherBytes_raw;

                    if (entry.cipherMine === pdaCipher1_onchain_b64) {
                        otherCipherBytes_raw = pdaData.cipher2;
                        console.log(`  User's cipher matches PDA.cipher1. Other party's is PDA.cipher2.`);
                    } else if (entry.cipherMine === pdaCipher2_onchain_b64) {
                        otherCipherBytes_raw = pdaData.cipher1;
                        console.log(`  User's cipher matches PDA.cipher2. Other party's is PDA.cipher1.`);
                    } else {
                        console.warn(`  User's cipher does not match either PDA cipher. Checking if we submitted to different tag...`);
                        // The cipher might be on the original tag, not this alternative tag
                        // Mark as mutual but with special status
                        localDecryptedIndex[i].status = "mutual_different_tag";
                        localDecryptedIndex[i].revealedInfo = "Mutual (Found on different tag)";
                        localDecryptedIndex[i].actualMutualTag = mutualTag;
                        anIndexWasUpdated = true;
                        continue;
                    }

                    if (otherCipherBytes_raw && otherCipherBytes_raw.length === 48) {
                        // Ensure Uint8Array type for crypto operations
                        const otherCipherForDecryption = Uint8Array.from(otherCipherBytes_raw);
                        const nonce = otherCipherForDecryption.slice(0, 24);
                        const encryptedDataWithAuthTag = otherCipherForDecryption.slice(24);
                        
                        // --- Try decrypting with multiple keys (existing logic) ---
                        let decryptionSuccessful = false;
                        let decryptedPayload = null;
                        let usedKeyVersion = 'current';
                        
                        // First try with current key
                        try {
                            const cryptoInstance = xchacha20poly1305(K_common_bytes, nonce);
                            decryptedPayload = cryptoInstance.decrypt(encryptedDataWithAuthTag);
                            decryptionSuccessful = true;
                            console.log(`  Successfully decrypted with current key`);
                        } catch (currentKeyError) {
                            console.log(`  Failed to decrypt with current key, trying historical keys...`);
                            
                            // Try with all stored key versions
                            for (const keyVersion of sessionKeyVersions) {
                                if (keyVersion.appPublicKeyHex === sessionAppPublicKeyHex) {
                                    continue; // Skip current key, we already tried it
                                }
                                
                                try {
                                    // Fetch target user's historical keys
                                    const targetAllKeysResponse = await fetch(`${API_ROOT}/api/user/${entry.targetUserSolAddress || selectedTargetUser?.primary_sol_address}/all-app-pubkeys`);
                                    if (!targetAllKeysResponse.ok) continue;
                                    
                                    const targetAllKeysData = await targetAllKeysResponse.json();
                                    if (!targetAllKeysData.appPublicKeys) continue;
                                    
                                    // Try each combination of our historical keys with their historical keys
                                    for (const targetKey of targetAllKeysData.appPublicKeys) {
                                        try {
                                            const targetKeyBytes = hexToBytes(targetKey.publicKeyHex);
                                            const historicalSharedSecret = await generateSymmetricSharedSecret(keyVersion.kWallet, targetKeyBytes);
                                            const { symmetricEncryptionKey: historicalK } = await deriveSymmetricKeysFromSharedSecret(historicalSharedSecret);
                                            
                                            const historicalCrypto = xchacha20poly1305(historicalK, nonce);
                                            decryptedPayload = historicalCrypto.decrypt(encryptedDataWithAuthTag);
                                            decryptionSuccessful = true;
                                            usedKeyVersion = `${keyVersion.version}+${targetKey.version}`;
                                            console.log(`  Successfully decrypted with historical keys: our ${keyVersion.version} + their ${targetKey.version}`);
                                            break;
                                        } catch (e) {
                                            // This combination didn't work, try next
                                        }
                                    }
                                    if (decryptionSuccessful) break;
                                } catch (fetchError) {
                                    console.warn(`  Could not fetch historical keys for target user: ${fetchError.message}`);
                                }
                            }
                        }
                        // --- End decryption attempts ---
                        
                        if (decryptionSuccessful && decryptedPayload) {
                            console.log(`  MUTUAL MATCH FOUND & DECRYPTED! (Key version: ${usedKeyVersion})`);
                            localDecryptedIndex[i].status = "mutual"; // Set status to full mutual
                            localDecryptedIndex[i].actualMutualTag = mutualTag; // Store which tag it was found on
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
                        } else {
                            console.error(`  Failed to decrypt other party's cipher with any available keys`);
                            localDecryptedIndex[i].status = "mutual_decryption_failed"; // Special status
                            localDecryptedIndex[i].revealedInfo = "Mutual (Decryption Error - Try Re-authenticating)";
                            localDecryptedIndex[i].actualMutualTag = mutualTag;
                            anIndexWasUpdated = true; 
                        }
                    }
                } else {
                    console.warn(`  symmetricKeyHex missing, cannot decrypt mutual payload.`);
                    localDecryptedIndex[i].status = "mutual_key_missing"; // Special status
                    localDecryptedIndex[i].revealedInfo = "Mutual (Key Missing)";
                    localDecryptedIndex[i].actualMutualTag = mutualTag;
                    anIndexWasUpdated = true; 
                }

                const itemElement = document.querySelector(`[data-tag='${entry.symmetricTag}']`);
                if(itemElement) itemElement.style.backgroundColor = 'lightgreen'; 

            } else {
                console.log(`  No mutual match found across ${tagsToCheck.length} possible tags`);
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
    const mutualMatchesPlaceholder = document.getElementById('mutualMatchesContainerPlaceholder');
    let mutualMatchesContainer = document.getElementById('mutualMatchesContainer');
    
    const otherCrushesPlaceholder = document.getElementById('userIndexContainerPlaceholder');
    let otherCrushesContainer = document.getElementById('userIndexContainer'); // Re-using ID for consistency, represents non-mutuals now

    // Separate entries
    const mutualEntries = [];
    const otherEntries = [];
    if (indexArray && indexArray.length > 0) {
        indexArray.forEach(entry => {
            if (entry.status === "mutual") {
                mutualEntries.push(entry);
            } else {
                otherEntries.push(entry);
            }
        });
    }

    // --- Render Mutual Matches --- 
    if (!mutualMatchesContainer) {
        mutualMatchesContainer = document.createElement('div');
        mutualMatchesContainer.id = 'mutualMatchesContainer';
        mutualMatchesContainer.style.marginBottom = '20px';
        if (mutualMatchesPlaceholder) {
            mutualMatchesPlaceholder.replaceWith(mutualMatchesContainer);
        } else {
            // Fallback if placeholder is missing (e.g. dynamic content changes)
            const contentArea = document.getElementById('content');
            if (contentArea) contentArea.prepend(mutualMatchesContainer); 
            else document.body.prepend(mutualMatchesContainer); 
        }
    }
    mutualMatchesContainer.innerHTML = '<h3>Mutual Matches! 🎉</h3>';
    if (mutualEntries.length === 0) {
        mutualMatchesContainer.innerHTML += '<p><small>No mutual matches found yet. Keep trying!</small></p>';
    } else {
        const mutualList = document.createElement('ul');
        mutualList.style.listStyleType = "none";
        mutualList.style.paddingLeft = "0";
        mutualEntries.sort((a, b) => (b.ts || 0) - (a.ts || 0)); // Sort by timestamp desc

        mutualEntries.forEach(entry => {
            const item = document.createElement('li');
            item.setAttribute('data-tag', entry.symmetricTag || entry.tag);
            item.style.border = "1px solid #5cb85c"; // Green border
            item.style.backgroundColor = '#e6ffe6'; // Light green background
            item.style.padding = "10px";
            item.style.marginBottom = "8px";
            item.style.borderRadius = "5px";

            let mutualCtaHtml = '';
            if (entry.targetFid) { // FID should exist for a mutual match entry
                mutualCtaHtml = `<button class="view-profile-btn" data-fid="${entry.targetFid}">View Profile</button><br/>`; // Changed button text
            }
            
            // Updated display for mutual matches
            let mutualStatusDisplay;
            if (entry.targetUsername) {
                mutualStatusDisplay = `✨ Mutual with @${entry.targetUsername}`;
            } else if (entry.targetFid) {
                mutualStatusDisplay = `✨ Mutual with User FID: ${entry.targetFid}`;
            } else {
                mutualStatusDisplay = `✨ It's a Match!`; // Fallback
            }

            let pfpHtml = '';
            if (entry.targetPfpUrl) {
                pfpHtml = `<img src="${entry.targetPfpUrl}" alt="@${entry.targetUsername || 'User'}" style="width: 30px; height: 30px; border-radius: 50%; margin-right: 8px; vertical-align: middle;">`;
            }

            item.innerHTML = `
                <div style="display: flex; align-items: center; margin-bottom: 5px;">
                    ${pfpHtml}
                    <span class="mutual-info" style="font-weight: bold; flex-grow: 1;">${mutualStatusDisplay}</span>
                </div>
                ${mutualCtaHtml}
                ${entry.txSignature ? `<small>Tx: <a href="https://solscan.io/tx/${entry.txSignature}?cluster=mainnet" target="_blank" rel="noopener noreferrer">${entry.txSignature.substring(0,10)}...</a></small><br>` : '' }
            `;
            mutualList.appendChild(item);
        });
        mutualMatchesContainer.appendChild(mutualList);
    }

    // Add event listener for view profile buttons AFTER mutualMatchesContainer is populated
    if (mutualMatchesContainer && mutualEntries.length > 0) {
        mutualMatchesContainer.addEventListener('click', async (event) => {
            if (event.target.classList.contains('view-profile-btn')) {
                const fidString = event.target.dataset.fid;
                if (fidString) {
                    try {
                        const fid = parseInt(fidString, 10);
                        if (isNaN(fid)) {
                            console.error("Invalid FID for view profile button:", fidString);
                            return;
                        }
                        console.log(`Calling viewProfile for FID: ${fid}`);
                        await frame.sdk.actions.viewProfile({ fid });
                    } catch (e) {
                        console.error("Error parsing FID or calling viewProfile:", e);
                    }
                }
            }
        });
    }

    // --- Render Other Crushes (Pending, Failed, etc.) --- 
    if (!otherCrushesContainer) {
        otherCrushesContainer = document.createElement('div');
        otherCrushesContainer.id = 'userIndexContainer'; // Keep ID for potential CSS or other references
        otherCrushesContainer.style.marginTop = '20px';
        if (otherCrushesPlaceholder) {
            otherCrushesPlaceholder.replaceWith(otherCrushesContainer);
        } else {
            const contentArea = document.getElementById('content');
            if (contentArea) contentArea.appendChild(otherCrushesContainer); // Append if no placeholder
            else document.body.appendChild(otherCrushesContainer);
        }
    }
    otherCrushesContainer.innerHTML = '<h3>Your Other Crushes:</h3>';
    if (otherEntries.length === 0) {
        otherCrushesContainer.innerHTML += '<p><small>No other pending or past crushes to show.</small></p>';
    } else {
        const otherList = document.createElement('ul');
        otherList.style.listStyleType = "none";
        otherList.style.paddingLeft = "0";
        // Sort non-mutual by timestamp descending
        otherEntries.sort((a, b) => (b.ts || 0) - (a.ts || 0)); 

        otherEntries.forEach(entry => {
            const item = document.createElement('li');
            item.setAttribute('data-tag', entry.symmetricTag || entry.tag);
            item.style.border = "1px solid #eee";
            item.style.padding = "10px";
            item.style.marginBottom = "8px";
            item.style.borderRadius = "5px";
            // Optional: Style differently based on status (e.g. pending, failed)
            if (entry.status && entry.status.includes('fail')) {
                item.style.backgroundColor = '#fdd'; // Light red for failed
                item.style.borderColor = '#d9534f';
            } else if (entry.status === 'pending') {
                 item.style.backgroundColor = '#fffde7'; // Light yellow for pending
            }

            const tagHexSnippet = entry.symmetricTag ? entry.symmetricTag.substring(0,16) : (entry.tag ? entry.tag.substring(0,16) : 'N/A');
            item.innerHTML = `
                <strong>Target FID:</strong> ${entry.targetFid || 'N/A'} <br>
                <strong>Target Username:</strong> @${entry.targetUsername || 'N/A'} <br>
                <strong>Status:</strong> ${entry.status || 'N/A'} <br>
                <strong>Timestamp:</strong> ${entry.ts ? new Date(entry.ts).toLocaleString() : 'N/A'} <br>
                <small>Tag: ${tagHexSnippet}...</small><br>
                ${entry.txSignature ? `<small>Tx: <a href="https://solscan.io/tx/${entry.txSignature}?cluster=mainnet" target="_blank" rel="noopener noreferrer">${entry.txSignature.substring(0,10)}...</a></small><br>` : '' }
                ${entry.confirmationError ? `<small style="color:red;">Error: ${entry.confirmationError}</small><br>` : ''}
            `;
            otherList.appendChild(item);
        });
        otherCrushesContainer.appendChild(otherList);
    }
}

async function handleSendCrush() {
    if (!selectedTargetUser || !selectedTargetUser.primary_sol_address) {
        updateStatusMessage("No target user with a Solana address selected!", true);
        return;
    }
    // Ensure appPublicKeyHex is present from the selection step
    if (!selectedTargetUser.appPublicKeyHex || !selectedTargetUser.appPublicKeyBytes) {
        updateStatusMessage("Target user's app key not available. Please re-select the user.", true);
        console.error("handleSendCrush: selectedTargetUser is missing appPublicKeyHex or appPublicKeyBytes. This should have been caught at selection.");
        return;
    }
    if (!sessionKWallet || !sessionKIndex || !sessionAppPublicKeyHex) { 
        updateStatusMessage("User session keys (kWallet, kIndex, or AppPublicKeyHex) not available. Please connect and sign first.", true);
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

    const edPubTargetMainSolKeyString = selectedTargetUser.primary_sol_address;
    let edPubTargetMainSolKeyBytes;
    try {
        edPubTargetMainSolKeyBytes = bs58.decode(edPubTargetMainSolKeyString);
        if (edPubTargetMainSolKeyBytes.length !== 32) {
            throw new Error(`Invalid main target public key length: ${edPubTargetMainSolKeyBytes.length}. Expected 32.`);
        }
    } catch(e) {
        console.error("Invalid target user's main Solana address:", edPubTargetMainSolKeyString, e);
        updateStatusMessage("The target user's Solana address appears invalid.", true);
        return;
    }
    
    // --- Target user's APP-SPECIFIC public key is now pre-fetched and stored in selectedTargetUser ---
    const targetUserAppPublicKeyHex = selectedTargetUser.appPublicKeyHex;
    const targetUserAppPublicKeyBytes = selectedTargetUser.appPublicKeyBytes;
    // --- End Target user's APP-SPECIFIC public key ---

    const searchResultsDiv = document.getElementById('searchResults');
    if(searchResultsDiv) searchResultsDiv.innerHTML = "<p>Processing your secret crush... Generating keys...</p>";
    else updateStatusMessage("Processing your secret crush... Generating keys...");
    
    try {
        // 1. Derive DIRECTIONAL stealth key (skPrime, pkPrime) for SIGNING the transaction
        // This uses our kWallet and the TARGET's MAIN Solana public key.
        updateStatusMessage("Deriving transaction signing key...");
        const { skPrime, pkPrime } = await deriveStealthKey(sessionKWallet, edPubTargetMainSolKeyBytes);

        // 2. Generate SYMMETRIC shared secret using MY app private key (sessionKWallet) and TARGET's APP public key
        updateStatusMessage("Generating symmetric shared secret...");
        const symmetricSharedSecret = await generateSymmetricSharedSecret(sessionKWallet, targetUserAppPublicKeyBytes);
        
        // 3. Derive SYMMETRIC encryption key (K_common) and SYMMETRIC tag (tag_common) from the shared secret
        updateStatusMessage("Deriving symmetric encryption key and tag...");
        const { symmetricEncryptionKey, symmetricTag } = await deriveSymmetricKeysFromSharedSecret(symmetricSharedSecret);
        
        // --- NEW: Also generate tags for ALL possible key combinations ---
        const allPossibleTags = [];
        allPossibleTags.push({ 
            tag: symmetricTag, 
            tagHex: bytesToHex(symmetricTag),
            keyVersion: `current+latest`,
            encryptionKey: symmetricEncryptionKey
        });
        
        // Try with all our historical keys against all their keys
        if (selectedTargetUser.allAppKeys && selectedTargetUser.allAppKeys.length > 1) {
            console.log(`Target user has ${selectedTargetUser.allAppKeys.length} app keys, generating tags for all combinations...`);
            
            // Include current session key in the list if not already there
            const ourKeyVersions = [
                {
                    kWallet: sessionKWallet,
                    appPublicKeyHex: sessionAppPublicKeyHex,
                    version: 'current'
                },
                ...sessionKeyVersions
            ];
            
            // Generate tags for all combinations
            for (const ourKey of ourKeyVersions) {
                for (const theirKey of selectedTargetUser.allAppKeys) {
                    try {
                        const theirKeyBytes = hexToBytes(theirKey.publicKeyHex);
                        const altSharedSecret = await generateSymmetricSharedSecret(ourKey.kWallet, theirKeyBytes);
                        const { symmetricEncryptionKey: altKey, symmetricTag: altTag } = await deriveSymmetricKeysFromSharedSecret(altSharedSecret);
                        const altTagHex = bytesToHex(altTag);
                        
                        // Don't add duplicates
                        if (!allPossibleTags.some(t => t.tagHex === altTagHex)) {
                            allPossibleTags.push({
                                tag: altTag,
                                tagHex: altTagHex,
                                keyVersion: `${ourKey.version}+${theirKey.version}`,
                                encryptionKey: altKey
                            });
                        }
                    } catch (e) {
                        console.warn(`Failed to generate tag for key combination ${ourKey.version}+${theirKey.version}:`, e);
                    }
                }
            }
        }
        
        console.log(`Generated ${allPossibleTags.length} possible tags for crush matching`);
        // --- End NEW ---

        // 4. Encrypt payload using K_common (symmetricEncryptionKey)
        updateStatusMessage("Encrypting payload...");
        const cipherForChain = await encryptPayload(symmetricEncryptionKey, myFid, selectedTargetUser.fid, "");
        
        // 5. Build partial transaction using:
        //    - skPrime, pkPrime (for signing the TX)
        //    - symmetricTag (for PDA derivation and as instruction argument)
        //    - cipherForChain
        updateStatusMessage("Building partial transaction...");
        const base64Tx = await buildPartialTransaction(skPrime, pkPrime, symmetricTag, cipherForChain, relayerPublicKeyString);
        
        updateStatusMessage("Sending transaction to relay...");
        const relayResponse = await fetch(`${API_ROOT}/api/relay`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', },
            body: JSON.stringify({ tx: base64Tx }),
        });

        if (!relayResponse.ok) {
            const errorData = await relayResponse.json().catch(() => ({ message: 'Relay request failed with no JSON response.'}));
            
            // --- Check for AlreadyMutual error (existing code) ---
            if (errorData.error && errorData.simulationLogs) {
                const isAlreadyMutual = errorData.simulationLogs.some(log => 
                    log.includes('AlreadyMutual') || 
                    log.includes('This crush has already been reciprocated and is mutual')
                );
                
                if (isAlreadyMutual) {
                    console.log("Detected AlreadyMutual error - this is actually a recovered mutual match!");
                    updateStatusMessage("Great news! This is already a mutual match! Updating your list...");
                    
                    // Create a mutual match entry
                    let currentIndexArray = await getDecryptedUserIndexFromServer();
                    
                    const recoveredMutualEntry = {
                        symmetricTag: bytesToHex(symmetricTag),
                        cipherMine: Buffer.from(cipherForChain).toString('base64'),
                        status: "mutual", // Mark as mutual
                        ts: Date.now(),
                        targetFid: selectedTargetUser.fid,
                        targetUsername: selectedTargetUser.username,
                        targetPfpUrl: selectedTargetUser.pfp_url,
                        targetUserSolAddress: selectedTargetUser.primary_sol_address,
                        symmetricKeyHex: bytesToHex(symmetricEncryptionKey),
                        txSignature: null, // No successful tx since it was already there
                        confirmationError: null,
                        targetUserAppPublicKeyHex: targetUserAppPublicKeyHex,
                        revealedInfo: `Mutual with FID ${selectedTargetUser.fid}`,
                        recoveredFromError: true, // Flag to indicate this was recovered
                        allPossibleTags: allPossibleTags.map(t => t.tagHex) // NEW: Store all possible tags
                    };
                    
                    // Check if this entry already exists (by symmetricTag)
                    const existingEntryIndex = currentIndexArray.findIndex(entry => entry.symmetricTag === recoveredMutualEntry.symmetricTag);
                    if (existingEntryIndex > -1) {
                        // Update existing entry to mutual
                        currentIndexArray[existingEntryIndex] = { ...currentIndexArray[existingEntryIndex], ...recoveredMutualEntry };
                    } else {
                        // Add new entry
                        currentIndexArray.push(recoveredMutualEntry);
                    }
                    
                    // Save updated index
                    await updateUserIndexAndAppKeyOnApi(currentIndexArray, sessionAppPublicKeyHex, currentKeyVersion);
                    
                    // Update UI
                    if (searchResultsDiv) {
                        searchResultsDiv.innerHTML = `
                            <div style="padding: 15px; background-color: #e6ffe6; border: 2px solid #5cb85c; border-radius: 5px;">
                                <p style="color: #5cb85c; font-weight: bold; font-size: 1.2em;">🎉 Recovered Mutual Match!</p>
                                <p style="margin: 10px 0;"><strong>${selectedTargetUser.display_name}</strong> (@${selectedTargetUser.username}) had already crushed on you!</p>
                                <p style="font-size: 0.9em; color: #666;">This mutual match was recovered from the blockchain.</p>
                                <button id="viewRecoveredProfileBtn" class="view-profile-btn" data-fid="${selectedTargetUser.fid}" style="margin-top: 10px; margin-right: 10px;">View Profile</button>
                                <button id="searchAgainAfterRecoveryBtn" style="margin-top: 10px;">Send Another Crush</button>
                            </div>
                        `;
                        
                        document.getElementById('viewRecoveredProfileBtn')?.addEventListener('click', async () => {
                            try {
                                await frame.sdk.actions.viewProfile({ fid: selectedTargetUser.fid });
                            } catch (e) {
                                console.error("Error viewing profile:", e);
                            }
                        });
                        
                        document.getElementById('searchAgainAfterRecoveryBtn')?.addEventListener('click', () => {
                            document.getElementById('userSearchInput').value = '';
                            searchResultsDiv.innerHTML = '';
                            searchResultsDiv.classList.remove('populated');
                            selectedTargetUser = null;
                        });
                    }
                    
                    // Reload the display to show the new mutual match
                    await loadAndDisplayUserIndex();
                    
                    return; // Exit early - we've handled this case
                }
            }
            // --- End AlreadyMutual check ---
            
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
                    uiMessage = `Crush sent and confirmed on Solana! Tx: <a href="https://solscan.io/tx/${finalTxSignature}?cluster=mainnet" target="_blank" rel="noopener noreferrer">${finalTxSignature.substring(0,10)}...</a>`;
                    clearInterval(pollingIntervalId);
                    await finalizeCrushSubmission(true); 
                } else if (statusResult.status === 'failed') {
                    console.error(`Transaction ${finalTxSignature} failed:`, statusResult.error);
                    updateStatusMessage(`Transaction ${finalTxSignature.substring(0,10)}... FAILED on-chain.`, true);
                    confirmationStatus = "failed_on_chain";
                    confirmationErrorDetail = JSON.stringify(statusResult.error);
                    uiMessage = `Crush FAILED to process on Solana. Tx: <a href="https://solscan.io/tx/${finalTxSignature}?cluster=mainnet" target="_blank" rel="noopener noreferrer">${finalTxSignature.substring(0,10)}...</a>. Error: ${confirmationErrorDetail}`;
                    clearInterval(pollingIntervalId);
                    await finalizeCrushSubmission(false); 
                } else if (pollingAttempts >= MAX_POLLING_ATTEMPTS) {
                    console.warn(`Transaction ${finalTxSignature} confirmation timed out after ${MAX_POLLING_ATTEMPTS} attempts.`);
                    updateStatusMessage(`Transaction ${finalTxSignature.substring(0,10)}... confirmation timed out. It might still succeed. Check explorer.`, true);
                    confirmationStatus = "pending_confirmation_timeout";
                    confirmationErrorDetail = "Confirmation polling timed out.";
                    uiMessage = `Crush sent (Tx: <a href="https://solscan.io/tx/${finalTxSignature}?cluster=mainnet" target="_blank" rel="noopener noreferrer">${finalTxSignature.substring(0,10)}...</a>), but confirmation polling timed out. It may process on-chain shortly.`;
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
                    uiMessage = `Crush sent (Tx: <a href="https://solscan.io/tx/${finalTxSignature}?cluster=mainnet" target="_blank" rel="noopener noreferrer">${finalTxSignature.substring(0,10)}...</a>), but an error occurred while checking status.`;
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
                } else if (getResponse.status === 404) { 
                     console.log("No user data found on server before adding new crush. Will create new index.");
                } else {
                     console.warn("Error fetching user index before adding new crush, proceeding with empty list.");
                }
            } catch (fetchErr) {
                console.warn("Network error fetching index before adding new crush, proceeding with empty list:", fetchErr);
            }
    
            const newCrushEntry = {
                symmetricTag: bytesToHex(symmetricTag),          // Changed from 'tag'
                cipherMine: Buffer.from(cipherForChain).toString('base64'), 
                status: confirmationStatus, 
                ts: Date.now(),
                targetFid: selectedTargetUser.fid,
                targetUsername: selectedTargetUser.username,
                targetPfpUrl: selectedTargetUser.pfp_url, // Store PFP URL
                targetUserSolAddress: selectedTargetUser.primary_sol_address, // NEW: Store target's SOL address for key lookups
                symmetricKeyHex: bytesToHex(symmetricEncryptionKey), // Changed from K_AB_hex and stores K_common
                txSignature: finalTxSignature, 
                confirmationError: confirmationErrorDetail,
                // Include target's app public key for potential future reference/debugging, if needed
                targetUserAppPublicKeyHex: targetUserAppPublicKeyHex,
                allPossibleTags: allPossibleTags.map(t => t.tagHex) // NEW: Store all possible tags for future matching
            };
    
            const existingEntryIndex = currentIndexArray.findIndex(entry => entry.symmetricTag === newCrushEntry.symmetricTag);
            if (existingEntryIndex > -1) currentIndexArray[existingEntryIndex] = newCrushEntry;
            else currentIndexArray.push(newCrushEntry);
            
            // Use the combined function to update index (and ensure app key is still there or updated if changed)
            const updateSuccess = await updateUserIndexAndAppKeyOnApi(currentIndexArray, sessionAppPublicKeyHex, currentKeyVersion);
    
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

// New helper function to recover from old sessions
async function tryRecoverOldSession() {
    const oldKWalletHex = localStorage.getItem('sessionKWalletHex.v1'); // Assuming we version these
    if (oldKWalletHex) {
        try {
            const oldKWallet = hexToBytes(oldKWalletHex);
            const hotPrefix = utf8ToBytes("HOT");
            const oldKIndex = sha256(concatBytes(hotPrefix, oldKWallet));
            const oldAppPublicKeyBytes = ed25519.getPublicKey(oldKWallet);
            const oldAppPublicKeyHex = bytesToHex(oldAppPublicKeyBytes);
            
            // Add to sessionKeyVersions if not already there
            const exists = sessionKeyVersions.some(k => k.appPublicKeyHex === oldAppPublicKeyHex);
            if (!exists) {
                sessionKeyVersions.push({
                    kWallet: oldKWallet,
                    kIndex: oldKIndex,
                    appPublicKeyHex: oldAppPublicKeyHex,
                    version: 'v1',
                    createdAt: new Date(Date.now() - 86400000).toISOString() // Assume 1 day old
                });
                console.log("Recovered old session key from localStorage");
            }
        } catch (e) {
            console.error("Error recovering old session:", e);
        }
    }
}
