import { Transaction, SystemProgram, PublicKey } from '@solana/web3.js';

/**
 * Test fixture: Basic skill that creates a base64-encoded transfer transaction
 * Used to verify that skills can properly build and serialize Solana transactions
 */
export async function executeSkill(env: any): Promise<[number, string, string | null]> {
    const wallet = env.getWallet();
    const tx = new Transaction();
    
    // Add a simple transfer instruction (1 lamport to system program)
    tx.add(SystemProgram.transfer({
        fromPubkey: new PublicKey(wallet.publicKey),
        toPubkey: SystemProgram.programId,
        lamports: 1
    }));
    
    // Set required transaction fields
    tx.recentBlockhash = env.getRecentBlockhash();
    tx.feePayer = new PublicKey(wallet.publicKey);
    
    // Serialize the complete unsigned transaction to base64
    const serializedTx = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false
    }).toString('base64');
    
    return [1.0, "created_transfer_tx", serializedTx];
}