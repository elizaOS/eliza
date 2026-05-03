import { Transaction, SystemProgram, PublicKey, Keypair } from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID, MINT_SIZE, createInitializeMint2Instruction,
    ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';

export async function executeSkill(blockhash: string): Promise<string> {
    const tx = new Transaction();
    const agentPubkey = new PublicKey('CeR8n6jcoN2icKRG1we2TJB9YNApjw7PPyFYKNUjer5K');
    const connection = new (await import('@solana/web3.js')).Connection('http://localhost:8899');

    // Create a mint first
    const mintKp = Keypair.generate();
    const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

    tx.add(SystemProgram.createAccount({
        fromPubkey: agentPubkey, newAccountPubkey: mintKp.publicKey,
        lamports: mintRent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    }));
    tx.add(createInitializeMint2Instruction(
        mintKp.publicKey, 6, agentPubkey, null, TOKEN_PROGRAM_ID
    ));

    // Disc 0: Create ATA
    const ata = getAssociatedTokenAddressSync(mintKp.publicKey, agentPubkey);
    tx.add(createAssociatedTokenAccountInstruction(
        agentPubkey, ata, agentPubkey, mintKp.publicKey, TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
    ));

    // Disc 1: CreateIdempotent (for a second mint)
    const mintKp2 = Keypair.generate();
    tx.add(SystemProgram.createAccount({
        fromPubkey: agentPubkey, newAccountPubkey: mintKp2.publicKey,
        lamports: mintRent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    }));
    tx.add(createInitializeMint2Instruction(
        mintKp2.publicKey, 6, agentPubkey, null, TOKEN_PROGRAM_ID
    ));
    const ata2 = getAssociatedTokenAddressSync(mintKp2.publicKey, agentPubkey);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
        agentPubkey, ata2, agentPubkey, mintKp2.publicKey, TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
    ));

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;
    tx.partialSign(mintKp, mintKp2);

    return tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
    }).toString('base64');
}
