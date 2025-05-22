# Mutual Match Farcaster Mini-App

## Project Goal

Mutual Match is a Farcaster mini-app designed to allow any Farcaster user to discreetly record a one-sided "crush" on another Farcaster user. The core privacy principle is that a user only learns if their crush is mutual if the other person has also independently expressed a crush on them using this app. 

The key success metrics, as outlined in the project's PRD ([docs/PROJECT_PRD.md](docs/PROJECT_PRD.md)), include:

*   **High Encryption Integrity**: Ensuring that crush data remains confidential.
*   **Low Latency**: Fast processing for sending crushes.
*   **Exclusive Visibility**: Mutual matches should only be visible to the two individuals involved.
*   **Onchain Transactions**: Each crush action results in a confirmed onchain transaction to the designated Solana program.
*   **Zero Plaintext Leakage**: No user-linkable information (Wallet-FID) should be discoverable onchain or in the backend database.

## Monorepo Structure

This project is organized as a monorepo and contains the following main components:

*   **`api/`**: This directory houses the backend API, built as a Cloudflare Worker. It is responsible for:
    *   Relaying Solana transactions (injecting a fee-payer).
    *   Storing encrypted user indexes (lists of sent crushes).
*   **`onchain-program/`**: This directory contains the Solana smart contract (Anchor program) that handles the onchain logic for storing and matching crushes. The program ID is `EGYUNdDL63nN7NTZbE6P7qZdbaxSyvuXyyU4iVba5jDT`.
*   **Vite Front-End (Root Directory)**: The rest of the files in the root directory (including `src/`, `index.html`, etc.) constitute the client-side application. This is a Vite-based single-page application that users interact with within the Farcaster frame environment. It handles:
    *   User authentication (wallet signature).
    *   Cryptographic key derivation.
    *   Payload encryption.
    *   Building and sending partial transactions for crushes.
    *   Managing and displaying the user's list of crushes and mutual matches.

## Development

(Placeholder for development setup and run instructions - e.g., how to run the Vite front-end, deploy the Worker, and build/deploy the Anchor program.)

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details. 