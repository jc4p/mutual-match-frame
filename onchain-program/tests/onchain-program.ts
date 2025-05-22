import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import { OnchainProgram } from "../target/types/onchain_program";
import { expect } from 'chai';

describe("onchain-program", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.onchainProgram as Program<OnchainProgram>;

  // Helper to generate a random 32-byte array for the tag
  const generateRandomTag = () => {
    return new Uint8Array(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)));
  };

  // Helper to generate a random 48-byte array for the cipher
  const generateRandomCipher = () => {
    return new Uint8Array(Array.from({ length: 48 }, () => Math.floor(Math.random() * 256)));
  };

  it("Submits a crush and initializes PDA", async () => {
    const signer = provider.wallet.publicKey; // Use the default provider wallet as signer
    const tag = generateRandomTag();
    const cipher = generateRandomCipher();

    const [crushPda, _bump] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from(anchor.utils.bytes.utf8.encode("crush")),
        Buffer.from(tag),
      ],
      program.programId
    );

    console.log("Generated Tag:", Buffer.from(tag).toString('hex'));
    console.log("Generated Cipher:", Buffer.from(cipher).toString('hex'));
    console.log("Expected PDA address:", crushPda.toBase58());

    // First submission
    const tx1 = await program.methods
      .submitCrush(Array.from(tag), Array.from(cipher)) // Pass tag and cipher
      .accounts({
        // crushPda: crushPda, // Not needed if init_if_needed takes care of it implicitly based on seeds
        // signer: signer, // Signer is implicitly the provider.wallet
        // systemProgram: web3.SystemProgram.programId, // Also usually implicit
      })
      .rpc();
    console.log("Your transaction signature 1", tx1);

    let pdaAccountInfo = await program.account.crushPda.fetch(crushPda);
    expect(pdaAccountInfo.filled).to.equal(1);
    expect(pdaAccountInfo.bump).to.not.equal(0); // Bump should be set
    expect(Buffer.from(pdaAccountInfo.cipher1).equals(Buffer.from(cipher))).to.be.true;

    // Second submission (simulating another user or a second crush to the same PDA by error, though tag should differ)
    // For this test, we'll use a different cipher but the same tag to hit the same PDA
    const cipher2 = generateRandomCipher();
    console.log("Generated Cipher 2:", Buffer.from(cipher2).toString('hex'));

    const tx2 = await program.methods
      .submitCrush(Array.from(tag), Array.from(cipher2)) // Pass the same tag and new cipher
      .accounts({})
      .rpc();
    console.log("Your transaction signature 2", tx2);

    pdaAccountInfo = await program.account.crushPda.fetch(crushPda);
    expect(pdaAccountInfo.filled).to.equal(2);
    expect(Buffer.from(pdaAccountInfo.cipher2).equals(Buffer.from(cipher2))).to.be.true;

    // Attempt a third submission (should fail)
    try {
      await program.methods
        .submitCrush(Array.from(tag), Array.from(cipher))
        .accounts({})
        .rpc();
      expect.fail("Third submission should have failed as PDA is already filled.");
    } catch (error) {
      // console.error("Expected error on third submission:", error);
      expect(error.message).to.include("This crush has already been reciprocated and is mutual.");
    }

  });

  it("Submits crushes to two different PDAs using unique tags", async () => {
    // PDA 1 Setup
    const tag1 = generateRandomTag();
    const cipher1 = generateRandomCipher();
    const [crushPda1, _bump1] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from(anchor.utils.bytes.utf8.encode("crush")), Buffer.from(tag1)],
      program.programId
    );

    console.log("PDA 1 - Tag:", Buffer.from(tag1).toString('hex'));
    console.log("PDA 1 - Cipher:", Buffer.from(cipher1).toString('hex'));
    console.log("PDA 1 - Address:", crushPda1.toBase58());

    // Submit to PDA 1
    await program.methods
      .submitCrush(Array.from(tag1), Array.from(cipher1))
      .accounts({})
      .rpc();

    let pda1AccountInfo = await program.account.crushPda.fetch(crushPda1);
    expect(pda1AccountInfo.filled).to.equal(1);
    expect(Buffer.from(pda1AccountInfo.cipher1).equals(Buffer.from(cipher1))).to.be.true;

    // PDA 2 Setup
    const tag2 = generateRandomTag(); // Ensure this tag is different for a new PDA
    const cipher2 = generateRandomCipher();
    const [crushPda2, _bump2] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from(anchor.utils.bytes.utf8.encode("crush")), Buffer.from(tag2)],
      program.programId
    );

    console.log("PDA 2 - Tag:", Buffer.from(tag2).toString('hex'));
    console.log("PDA 2 - Cipher:", Buffer.from(cipher2).toString('hex'));
    console.log("PDA 2 - Address:", crushPda2.toBase58());

    // Submit to PDA 2
    await program.methods
      .submitCrush(Array.from(tag2), Array.from(cipher2))
      .accounts({})
      .rpc();

    let pda2AccountInfo = await program.account.crushPda.fetch(crushPda2);
    expect(pda2AccountInfo.filled).to.equal(1);
    expect(Buffer.from(pda2AccountInfo.cipher1).equals(Buffer.from(cipher2))).to.be.true; // Cipher1 for PDA2

    // Verify PDA 1 is unchanged
    pda1AccountInfo = await program.account.crushPda.fetch(crushPda1); // Re-fetch
    expect(pda1AccountInfo.filled).to.equal(1);
    expect(Buffer.from(pda1AccountInfo.cipher1).equals(Buffer.from(cipher1))).to.be.true;

    // Submit a second crush to PDA 2
    const cipher3 = generateRandomCipher();
    console.log("PDA 2 - Cipher 3:", Buffer.from(cipher3).toString('hex'));
    await program.methods
      .submitCrush(Array.from(tag2), Array.from(cipher3))
      .accounts({})
      .rpc();

    pda2AccountInfo = await program.account.crushPda.fetch(crushPda2); // Re-fetch PDA2
    expect(pda2AccountInfo.filled).to.equal(2);
    expect(Buffer.from(pda2AccountInfo.cipher1).equals(Buffer.from(cipher2))).to.be.true; // Original cipher1 for PDA2
    expect(Buffer.from(pda2AccountInfo.cipher2).equals(Buffer.from(cipher3))).to.be.true; // New cipher2 for PDA2

     // Verify PDA 1 is STILL unchanged
    pda1AccountInfo = await program.account.crushPda.fetch(crushPda1); // Re-fetch
    expect(pda1AccountInfo.filled).to.equal(1);
    expect(Buffer.from(pda1AccountInfo.cipher1).equals(Buffer.from(cipher1))).to.be.true;

  });

  it("Fails to fetch a PDA that has not been initialized", async () => {
    const nonExistentTag = generateRandomTag();
    const [nonExistentPda, _bump] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from(anchor.utils.bytes.utf8.encode("crush")), Buffer.from(nonExistentTag)],
      program.programId
    );

    console.log("Attempting to fetch PDA for non-existent tag:", Buffer.from(nonExistentTag).toString('hex'));
    console.log("Address for non-existent PDA:", nonExistentPda.toBase58());

    try {
      await program.account.crushPda.fetch(nonExistentPda);
      expect.fail("Fetching a non-existent PDA should have failed.");
    } catch (error) {
      // A more specific error check could be done here if Anchor/Solana provides a distinct error code
      // For now, we check if the error indicates the account is not found.
      // The exact error message might vary based on Anchor version and cluster.
      // Example: "Account does not exist or has no data <PDA_ADDRESS>"
      // Or for localnet if it simply fails to deserialize because it's all zeros:
      console.log("Caught expected error when fetching non-existent PDA:", error.message);
      expect(error.message.includes("Account does not exist") || 
             error.message.includes("Failed to deserialize account") ||
             error.message.includes("Account not found")).to.be.true;
    }
  });

});
