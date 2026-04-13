import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Transaction, SystemProgram, PublicKey } from '@solana/web3.js';
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

const testSkillsDir = path.join(__dirname, "test_skills_tx");

// Ensure test skills directory exists
if (!fs.existsSync(testSkillsDir)) {
    fs.mkdirSync(testSkillsDir, { recursive: true });
}

describe("Base64 Transaction Serialization", () => {
    test("skill should return base64 serialized transaction", () => {
        // Create a skill that builds and serializes a transaction
        const txSkill = `
import { Transaction, SystemProgram, PublicKey } from '@solana/web3.js';

export async function executeSkill(env: any): Promise<[number, string, string | null]> {
    const wallet = env.getWallet();
    const tx = new Transaction();
    
    // Add a transfer instruction
    tx.add(SystemProgram.transfer({
        fromPubkey: new PublicKey(wallet.publicKey),
        toPubkey: SystemProgram.programId,
        lamports: 1000000
    }));
    
    // Set required transaction fields
    tx.recentBlockhash = env.getRecentBlockhash();
    tx.feePayer = new PublicKey(wallet.publicKey);
    
    // Serialize to base64
    const serializedTx = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false
    }).toString('base64');
    
    return [1.0, "transfer_created", serializedTx];
}
`;
        const skillPath = path.join(testSkillsDir, "tx_skill.ts");
        fs.writeFileSync(skillPath, txSkill);

        // Run the skill
        const result = execSync(`bun skill_runner/runSkill.ts ${skillPath} 5000`, {
            encoding: "utf-8",
            cwd: path.join(__dirname, "..", "..")
        }).trim();
        
        const output = JSON.parse(result);
        expect(output.reward).toBe(1.0);
        expect(output.done_reason).toBe("transfer_created");
        expect(output.tx_receipt_json_string).toBeTruthy();
        
        // Verify it's a base64 string
        expect(() => Buffer.from(output.tx_receipt_json_string, 'base64')).not.toThrow();
    });

    test("skill can build complex transaction with multiple instructions", () => {
        const complexSkill = `
import { Transaction, SystemProgram, PublicKey } from '@solana/web3.js';

export async function executeSkill(env: any): Promise<[number, string, string | null]> {
    const wallet = env.getWallet();
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
    
    // Set required transaction fields
    tx.recentBlockhash = env.getRecentBlockhash();
    tx.feePayer = new PublicKey(wallet.publicKey);
    
    // Serialize to base64
    const serializedTx = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false
    }).toString('base64');
    
    return [1.0, "multi_instruction_tx", serializedTx];
}
`;
        const skillPath = path.join(testSkillsDir, "complex_tx_skill.ts");
        fs.writeFileSync(skillPath, complexSkill);

        // Run the skill
        const result = execSync(`bun skill_runner/runSkill.ts ${skillPath} 5000`, {
            encoding: "utf-8",
            cwd: path.join(__dirname, "..", "..")
        }).trim();
        
        const output = JSON.parse(result);
        expect(output.reward).toBe(1.0);
        expect(output.done_reason).toBe("multi_instruction_tx");
        expect(output.tx_receipt_json_string).toBeTruthy();
        
        // Decode and verify it's a valid transaction
        const txBuffer = Buffer.from(output.tx_receipt_json_string, 'base64');
        expect(txBuffer.length).toBeGreaterThan(0);
    });

    test("skill returns null when no transaction is needed", () => {
        const observeSkill = `
export async function executeSkill(env: any): Promise<[number, string, string | null]> {
    const wallet = env.getWallet();
    // Just observe, no transaction
    return [0.5, "observed_balances", null];
}
`;
        const skillPath = path.join(testSkillsDir, "observe_skill.ts");
        fs.writeFileSync(skillPath, observeSkill);

        // Run the skill
        const result = execSync(`bun skill_runner/runSkill.ts ${skillPath} 5000`, {
            encoding: "utf-8",
            cwd: path.join(__dirname, "..", "..")
        }).trim();
        
        const output = JSON.parse(result);
        expect(output.reward).toBe(0.5);
        expect(output.done_reason).toBe("observed_balances");
        expect(output.tx_receipt_json_string).toBeNull();
    });
});

// Clean up test files after tests
afterAll(() => {
    if (fs.existsSync(testSkillsDir)) {
        fs.rmSync(testSkillsDir, { recursive: true });
    }
});