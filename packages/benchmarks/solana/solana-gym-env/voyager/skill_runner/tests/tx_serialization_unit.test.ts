import { describe, test, expect } from "bun:test";
import { Transaction, SystemProgram, PublicKey } from '@solana/web3.js';

describe("Transaction Serialization Unit Tests", () => {
    const mockEnv = {
        getWallet: () => ({
            balances: [2.5, 100.0, 0.0, 0.0, 0.0],
            publicKey: "11111111111111111111111111111111"
        }),
        getRecentBlockhash: () => "11111111111111111111111111111111"
    };

    test("can serialize simple transfer transaction", async () => {
        const wallet = mockEnv.getWallet();
        const tx = new Transaction();
        
        tx.add(SystemProgram.transfer({
            fromPubkey: new PublicKey(wallet.publicKey),
            toPubkey: SystemProgram.programId,
            lamports: 1000000
        }));
        
        tx.recentBlockhash = mockEnv.getRecentBlockhash();
        tx.feePayer = new PublicKey(wallet.publicKey);
        
        const serializedTx = tx.serialize({
            requireAllSignatures: false,
            verifySignatures: false
        }).toString('base64');
        
        expect(serializedTx).toBeTruthy();
        expect(typeof serializedTx).toBe('string');
        
        // Verify it's valid base64
        const decoded = Buffer.from(serializedTx, 'base64');
        expect(decoded.length).toBeGreaterThan(0);
    });

    test("can serialize transaction with multiple instructions", async () => {
        const wallet = mockEnv.getWallet();
        const tx = new Transaction();
        
        // Add multiple instructions
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
        
        tx.recentBlockhash = mockEnv.getRecentBlockhash();
        tx.feePayer = new PublicKey(wallet.publicKey);
        
        const serializedTx = tx.serialize({
            requireAllSignatures: false,
            verifySignatures: false
        }).toString('base64');
        
        expect(serializedTx).toBeTruthy();
        
        // Decode and check it's larger (has more instructions)
        const decoded = Buffer.from(serializedTx, 'base64');
        expect(decoded.length).toBeGreaterThan(100); // Multi-instruction tx should be larger
    });

    test("skill function returns correct format", async () => {
        const executeSkill = async (env: any): Promise<[number, string, string | null]> => {
            const wallet = env.getWallet();
            const tx = new Transaction();
            
            tx.add(SystemProgram.transfer({
                fromPubkey: new PublicKey(wallet.publicKey),
                toPubkey: SystemProgram.programId,
                lamports: 1
            }));
            
            tx.recentBlockhash = env.getRecentBlockhash();
            tx.feePayer = new PublicKey(wallet.publicKey);
            
            const serializedTx = tx.serialize({
                requireAllSignatures: false,
                verifySignatures: false
            }).toString('base64');
            
            return [1.0, "success", serializedTx];
        };
        
        const [reward, reason, txString] = await executeSkill(mockEnv);
        
        expect(reward).toBe(1.0);
        expect(reason).toBe("success");
        expect(txString).toBeTruthy();
        expect(typeof txString).toBe('string');
        
        // Verify it's valid base64
        expect(() => Buffer.from(txString!, 'base64')).not.toThrow();
    });

    test("can return null for observation-only skills", async () => {
        const executeSkill = async (env: any): Promise<[number, string, string | null]> => {
            const wallet = env.getWallet();
            // Just observe, don't create transaction
            return [0.5, "observed", null];
        };
        
        const [reward, reason, txString] = await executeSkill(mockEnv);
        
        expect(reward).toBe(0.5);
        expect(reason).toBe("observed");
        expect(txString).toBeNull();
    });
});