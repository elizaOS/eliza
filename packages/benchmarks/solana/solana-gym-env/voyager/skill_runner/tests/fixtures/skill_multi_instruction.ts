import { Transaction, SystemProgram, PublicKey } from '@solana/web3.js';

/**
 * Test fixture: Skill that creates a transaction with multiple instructions
 * Verifies that complex transactions can be built and serialized
 */
export async function executeSkill(env: any): Promise<[number, string, string | null]> {
    const wallet = env.getWallet();
    const tx = new Transaction();
    
    // Add multiple transfer instructions to test transaction batching
    tx.add(SystemProgram.transfer({
        fromPubkey: new PublicKey(wallet.publicKey),
        toPubkey: SystemProgram.programId,
        lamports: 1000000
    }));
    
    tx.add(SystemProgram.transfer({
        fromPubkey: new PublicKey(wallet.publicKey),
        toPubkey: new PublicKey("11111111111111111111111111111112"),
        lamports: 2000000
    }));
    
    // Set required transaction fields
    tx.recentBlockhash = env.getRecentBlockhash();
    tx.feePayer = new PublicKey(wallet.publicKey);
    
    // Serialize to base64
    const serializedTx = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false
    }).toString('base64');
    
    return [1.0, "multi_instruction_success", serializedTx];
}