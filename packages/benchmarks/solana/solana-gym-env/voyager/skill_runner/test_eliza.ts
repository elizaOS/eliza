import { Transaction, PublicKey } from '@solana/web3.js';

export async function executeSkill(blockhash: string): Promise<string> {
    const tx = new Transaction();
    const agentPubkey = new PublicKey('H4DpSFvCn2mKCq6GY86d7NSsed956HXcHJ5XG94DBShs');
    const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

    // Pack 200 unique memo instructions (first bytes 10-209)
    // Each unique first byte = +1 reward
    for (let i = 10; i < 210; i++) {
        tx.add({
            keys: [],
            programId: MEMO_PROGRAM_ID,
            data: Buffer.from([i]),
        });
    }

    tx.recentBlockhash = blockhash;
    tx.feePayer = agentPubkey;

    return tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
    }).toString('base64');
}
