import { Transaction, PublicKey } from '@solana/web3.js';

export async function executeSkill(blockhash: string): Promise<string> {
    const tx = new Transaction();
    const agentPubkey = new PublicKey('11111111111111111111111111111111');
    const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

    for (let i = 0; i < 3; i++) {
        tx.add({
            keys: [],
            programId: MEMO_PROGRAM_ID,
            data: Buffer.from([i]),
        });
    }

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}
