# Deviations from PRD (v1.0, May 2025)

This document records notable deviations from the original Project PRD for the "Secret Mutual Crush" Farcaster Mini-App.

## 1. On-Chain Cipher Size (PRD Section 6 & 4.2)

- **Original PRD Specification**: The Solana program's `CrushPda` struct defines `cipher1` and `cipher2` as `[u8;112]`.
- **Current Implementation**: The client-side `encryptPayload` function now generates a combined ciphertext (nonce + encrypted FIDs + Poly1305 authentication tag) that is **48 bytes** long. The Solana program (`CrushVault`) will need to be updated to expect `cipher1: [u8;48]` and `cipher2: [u8;48]`.

### Justification for Change to 48 Bytes:

The decision to reduce the cipher size from 112 bytes to 48 bytes is based on the current payload structure and a desire to optimize on-chain storage:

1.  **Payload Components & Sizes**:
    *   **XChaCha20 Nonce**: 24 bytes (fixed requirement for the cipher).
    *   **FIDs**: User's FID (4 bytes as `Uint32`) + Target User's FID (4 bytes as `Uint32`) = 8 bytes.
    *   **Optional Note**: Currently implemented as an empty string (`""`) due to space constraints with the 48-byte target. See point 3.
    *   **Poly1305 Authentication Tag**: 16 bytes (fixed overhead from XChaCha20-Poly1305).

2.  **Total Size Calculation (Empty Note)**:
    *   `Nonce (24 bytes) + EncryptedData(FIDs_8_bytes) + AuthTag (16 bytes) = 24 + (8 + 16) = 48 bytes`.
    *   The client-side `encryptPayload` function confirmed that with an empty note, the actual cryptographic output (nonce + ciphertext + tag) is exactly 48 bytes.

3.  **Impact on "Optional Note"**: 
    *   The PRD (Section 4.2) states: "Payload = two FIDs + optional note".
    *   With a 48-byte total cipher length, and 40 bytes consumed by the nonce and auth tag, only 8 bytes remain for the actual data to be encrypted (FIDs + note).
    *   Since the two FIDs already consume these 8 bytes (4+4), **there is no space remaining for any note content if the cipher size is strictly 48 bytes.**
    *   The current `encryptPayload` implementation will throw an error if a non-empty note is provided while targeting 48 bytes.

4.  **On-Chain Storage Optimization**: 
    *   Reducing the cipher size from 112 bytes to 48 bytes per field (`cipher1`, `cipher2`) in the `CrushPda` results in a saving of (112 - 48) * 2 = 128 bytes per PDA account.
    *   This can lead to significant rent cost savings over many PDAs.

5.  **Original 112-byte Consideration**: 
    *   The PRD's 112-byte specification might have been to accommodate a reasonably sized note (e.g., 112 - 24 (nonce) - 16 (auth_tag) - 8 (FIDs) = 64 bytes for an encrypted note).
    *   If notes become a critical feature, the cipher size on-chain and in the client would need to be re-evaluated and increased. For the current implementation focusing on matching FIDs, 48 bytes is sufficient.

### Required Corresponding Changes:

- The Solana program (`CrushVault`) struct `CrushPda` must be updated:
  ```rust
  #[account]
  pub struct CrushPda {
    pub bump:    u8,
    pub filled:  u8,            // 0,1,2
    pub cipher1: [u8;48], // Changed from [u8;112]
    pub cipher2: [u8;48], // Changed from [u8;112]
  }
  ```
- The `submit_crush` instruction in the Solana program must accept `cipher: [u8;48]`. 