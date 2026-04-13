import { Transaction, PublicKey } from '@solana/web3.js';

export async function executeSkill(blockhash: string): Promise<string> {
    const tx = new Transaction();
    const agentPubkey = new PublicKey('FmKZZfKGmtGBdkjC8nWhKV4gf3AXy9zqZxeXW2DTTgnH');
    const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

    for (let i = 60; i < 120; i++) {
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
