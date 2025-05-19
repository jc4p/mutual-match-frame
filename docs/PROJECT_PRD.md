**Project PRD — “Secret Mutual Crush” Farcaster Mini-App
(v 1.0, May 2025)**

---

## 1 · Purpose & Success Metrics

| Goal                                                                                             | KPI                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Let any Farcaster user discreetly record a one-sided crush and learn only when it becomes mutual | • ≥ 95 % encryption-integrity tests pass <br>• ≤ 300 ms median crush-send latency <br>• 100 % of matches visible **only** to the two wallets |
| Qualify for Farcaster Mini-App rewards (opens + confirmed on-chain tx)                           | • 1 on-chain transaction per crush per user hits `CrushVault` program ID                                                                     |
| Zero plaintext/user-link leakage on chain or backend                                             | • No wallet-FID link discoverable via on-chain data or server DB                                                                             |

---

## 2 · System Overview

```
┌──────── Front-End  (Frame client: React + TypeScript) ────────┐
│ • derives kWallet from wallet.signMessage                     │
│ • builds stealth key, tag, ciphertext                         │
│ • sends {tx:b64} → /relay   &  PUT encryptedIndex → /user     │
│ • listens to Crush PDA flips via Solana WebSocket RPC         │
└───────────────────────────────────────────────────────────────┘
               ▲                                       ▼
         HTTPS JSON                            sendRawTransaction
               │                                       │
┌──────── Cloudflare Worker  (Relay) ──────┐     ┌──────── Solana Mainnet ───────┐
│ • /relay  – inject feePayer, sign, push  │     │ CrushVault program (Anchor)   │
│ • /user/* – store AES-GCM index blobs    │     │ • submit_crush(cipher)        │
└───────────────────────────────────────────┘     │ • CrushPda:bump,filled,c1,c2 │
                                                 └───────────────────────────────┘
```

---

## 3 · User Flow (happy path)

1. **Open Mini-App** → wallet prompt appears once → user signs constant **“farcaster-crush-v1”**.
2. App displays list of FIDs the user follows.
3. User taps *“Crush”* on profile **B**.
4. Client:

   * builds deterministic stealth key `sk'`, shared key `K_AB`, `tag`, `cipher`.
   * updates encrypted index: `{tag, cipherMine}` → `PUT /user/<wallet>`.
   * POSTs **partial Tx** (signed only by `sk'`) to **/relay**.
5. Cloudflare relay injects fee-payer signature, broadcasts.
6. **CrushVault** program stores `cipher1` (or `cipher2`) and sets `filled`.
7. When **B** later sends a crush back, program flips `filled=2`.
8. Both clients’ WebSocket listeners decrypt, show confetti modal, open DM.

---

## 4 · Front-End Requirements

### 4.1  Tech stack

* React (same setup as other Frames), TypeScript, `@noble/*` crypto libs only.
* **NO** direct `@solana/web3.js` wallet methods besides constant message signing.

### 4.2  Key steps per crush

| Step                       | Function                                                                                            | Notes                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **sign constant**          | `walletProvider.signMessage`                                                                        | One per login                             |
| **stealth key derivation** | `seed = HMAC-SHA256(kWallet, edPubTarget)`<br>`sk' = seed`<br>`pk' = ed25519.getPublicKey(sk')`     | Deterministic, never stored               |
| **ECDH**                   | convert `edPubTarget → xPubT`,<br>`xPrivS = edToCurve(sk')`,<br>`shared = scalarMult(xPrivS,xPubT)` | X25519                                    |
| **Symmetric key & tag**    | `K = SHA256(shared‖"pair")`<br>`tag = SHA256("tag"‖K)`                                              | 32 B each                                 |
| **Encrypt payload**        | XChaCha20-Poly1305; nonce=24 B                                                                      | Payload = two FIDs + optional note        |
| **Partial Tx build**       | Fee-payer **blank**; instruction = `submit_crush(cipher)`                                           | Serialize + manual ed25519 sig with `sk'` |
| **POST /relay**            | `{tx:base64}`                                                                                       | Expect `{signature}` back                 |
| **Update index**           | Decrypt, push `{tag,cipherMine}`, encrypt with `kIndex = SHA256("HOT"‖kWallet)`                     | PUT /user                                 |

### 4.3  Index File Format (encrypted, AES-GCM)

```jsonc
[
  { "tag":"<hex32>", "cipher":"<b64 112B>", "status":"pending"|"mutual", "ts":1700000000 }
]
```

### 4.4  Restoration logic

On load:

* derive `kWallet`,`kIndex`; GET `/user/<wallet>`; decrypt list.
* For each entry, compute PDA, fetch once, attach `onAccountChange`.

### 4.5  UX states

* **Loading / no wallet**
* **No crushes yet** – display follow list.
* **Crush sent** – card shows “waiting…”.
* **Mutual** – confetti animation, DM deep-link.

---

## 5 · Cloudflare Worker Requirements

### 5.1  Secrets / env

```
RELAYER_KEY         base58 64B
RELAYER_PUBKEY      base58 32B
ALCHEMY_RPC         https://solana-mainnet.g.alchemy.com/v2/KEY
CRUSH_PROGRAM_ID    <deployed address>
KV_BINDING          (for rate-limit)
```

### 5.2  Routes

| Route            | Verb | Body / Response                | Behaviour                                                                                                                                                           |
| ---------------- | ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/relay`         | POST | `{ tx:string }`                | • size & programID check<br>• `tx.feePayer = RELAYER_PUBKEY`<br>• partialSign with relayer key<br>• `sendRawTransaction` to `ALCHEMY_RPC`<br>• return `{signature}` |
| `/user/<wallet>` | GET  | —→ `{encryptedIndex}` \| `404` | Stream KV object                                                                                                                                                    |
| `/user/<wallet>` | PUT  | `{ encryptedIndex }`           | Replace KV object; require HTTP `Authorization: Wallet <sig>` header = ed25519 sig of body hash with wallet key                                                     |
| `/health`        | GET  | “OK”                           | uptime check                                                                                                                                                        |

*Store no plaintext, only the AES-GCM blob.*

### 5.3  Rate-limiting

KV counter `rl:<ip>` → max 300 POSTs/min; return 429.

---

## 6 · Solana Program (Anchor)

```rust
#[account]
pub struct CrushPda {
  pub bump:    u8,
  pub filled:  u8,            // 0,1,2
  pub cipher1: [u8;112],
  pub cipher2: [u8;112],
}

// seeds = [b"crush", tag]
pub fn submit_crush(ctx: Context<SubmitCrush>, cipher: [u8;112]) -> Result<()> {
    let c = &mut ctx.accounts.crush;
    require!(c.filled < 2, ErrorCode::AlreadyMutual);
    if c.filled == 0 { c.cipher1 = cipher; } else { c.cipher2 = cipher; }
    c.filled += 1;
    Ok(())
}
```

*No initiator, no events, total account size = 242 B.*

---

## 7 · Security & Privacy Guarantees

| Risk                        | Mitigation                                                 |
| --------------------------- | ---------------------------------------------------------- |
| Wallet-FID linkage on-chain | Only stealth keys appear in tx; fee-payer is relayer       |
| Backend learns crush pairs  | Index encrypted with `kIndex`; server cannot decrypt       |
| Spam / DOS                  | Worker rate-limit; 0.002 SOL rent per PDA discourages junk |
| Replay attack               | Blockhash freshness (< 90 s) enforced in Worker            |

---

## 8 · Acceptance Tests

1. **Unit**

   * Derivation of `tag`, `K` identical for A & B.
   * Decryption fails for third-party key.
2. **Integration (local-validator)**

   * A submits → PDA filled=1.
   * B submits → PDA filled=2, clients decrypt mutual note.
3. **Privacy audit**

   * Chain explorer cannot map PDA to FID.
   * Server DB shows only ciphertext.
4. **Regression**

   * 10 000 crushes generate ≤ 10 000 PDAs, no overflow.
   * Average relay latency ≤ 150 ms.
5. **Farcaster metrics**

   * One confirmed transaction recorded per crush action.

---

## 9 · Timeline & Deliverables

| Week | Milestone                                                |
| ---- | -------------------------------------------------------- |
| 1    | Anchor program + local tests merged                      |
| 2    | Cloudflare Worker relay ready on devnet                  |
| 3    | Front-end crush-send + index encrypt/decrypt; devnet E2E |
| 4    | UI polish, web-socket listeners, acceptance test suite   |
| 5    | Mainnet deploy, Farcaster Frame review, launch           |

---

**Hand this PRD to your engineers; each section maps 1-to-1 onto tasks for FE, BE, and on-chain teams.**

