import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { writeFileSync } from 'fs';

// const execAsync = promisify(exec);

// Define the expected return type from executeSkill in TS skills
type SkillExecutionResult = string;

// Track transaction count for single transaction enforcement
let transactionCount = 0;

// A mock environment for the skill to interact with.
// In a real scenario, this would be a more complex object
// that mirrors the Python SurfpoolEnv's capabilities.
// For now, it simulates a transaction receipt.
const surfpoolEnv = {
    // This is a simplified mock. In a real scenario, this would
    // interact with a Solana test validator or similar.
    // For the purpose of testing skills and returning a receipt,
    // we'll simulate a transaction.
    simulateTransaction: async (success: boolean = true, protocol: string | null = null) => {
        transactionCount++;
        if (transactionCount > 1) {
            throw new Error(
                "SINGLE_TRANSACTION_LIMIT: Skills can only execute ONE transaction. " +
                "To perform multiple operations, create separate skills and chain them. " +
                "This transaction attempt was blocked."
            );
        }

        // Generate a dummy transaction receipt.
        // In a real scenario, this would come from a Solana RPC call.
        const txReceipt = {
            transaction: {
                message: {
                    accountKeys: protocol ? [protocol] : [], // Use protocol as a dummy program ID
                    instructions: protocol ? [{ programIdIndex: 0 }] : [],
                },
            },
            meta: {
                err: success ? null : { "InstructionError": [0, { "Custom": 1 }] }, // Simulate success or failure
                logMessages: ["Simulated transaction log"],
            },
        };
        return JSON.stringify(txReceipt);
    },
    // Mock wallet balances: [SOL, USDC, ...]
    wallet_balances: [2.5, 100.0, 0.0, 0.0, 0.0],
    // Add getWallet method for compatibility
    getWallet: () => ({
        balances: [2.5, 100.0, 0.0, 0.0, 0.0],
        publicKey: "11111111111111111111111111111111" // System program ID, will be overridden
    }),
    // Add getRecentBlockhash for transaction building
    // This will be updated with the real blockhash if provided
    getRecentBlockhash: () => "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
    // Add other methods as needed to mirror SurfpoolEnv
    read: () => "some data",
    write: (data: string) => console.log(`Skill wrote: ${data}`),
};

async function runSkill(): Promise<void> {
    const [, , encodedCode, encodedPrograms, agentPubkey, timeoutMsStr] = process.argv;

    if (!encodedCode || !encodedPrograms || !agentPubkey || !timeoutMsStr) {
        console.error('Usage: bun runCode.ts <b64Code> <b64Programs> <agentPubkey> <timeoutMs>');
        process.exit(1);
    }

    const timeoutMs = parseInt(timeoutMsStr, 10);
    const code = Buffer.from(encodedCode, 'base64').toString('utf-8');
    const programs = Buffer.from(encodedPrograms, 'base64').toString('utf-8');
    
    // Debug logging
    console.error(`DEBUG: Code length: ${code.length}, first 100 chars: ${code.substring(0, 100).replace(/\n/g, '\\n')}`);
    console.error(`DEBUG: Programs length: ${programs.length}, first 100 chars: ${programs.substring(0, 100).replace(/\n/g, '\\n')}`);
    
    const combinedCodePath = path.resolve("code.ts");
    // Check for duplicate function names
    const functionNames = new Set<string>();
    const functionPattern = /async\s+function\s+(\w+)\s*\(/g;
    
    // Check in programs
    let match;
    while ((match = functionPattern.exec(programs)) !== null) {
        functionNames.add(match[1]);
    }
    
    // Check in code and detect duplicates
    functionPattern.lastIndex = 0; // Reset regex
    while ((match = functionPattern.exec(code)) !== null) {
        if (functionNames.has(match[1])) {
            console.log(JSON.stringify({
                serialized_tx: null,
                error: `Duplicate function declaration: ${match[1]}. This function already exists in the skill library.`,
                trace: `Function '${match[1]}' is defined multiple times. Please use a different name or remove the duplicate.`
            }));
            process.exit(1);
        }
        functionNames.add(match[1]);
    }
    
    const combinedCode =
        "import { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, Keypair } from '@solana/web3.js';\n" +
        "import * as web3 from '@solana/web3.js';\n" +
        "import * as anchor from '@coral-xyz/anchor';\n" +
        `const AGENT_WALLET_ADDRESS = "${agentPubkey}";\n` +
        "export async function main() {\n" + programs + "\n" + code + "\n}";
    writeFileSync(combinedCodePath, combinedCode);

    transactionCount = 0;

    try {
        const skillModule = await import(combinedCodePath);

        if (typeof skillModule.main !== 'function') {
            throw new Error('main function not found in the provided module.');
        }

        const serialized_tx: SkillExecutionResult = await Promise.race([
            skillModule.main(),
            new Promise<SkillExecutionResult>((_, reject) =>
                setTimeout(() => reject(new Error('Skill execution timed out.')), timeoutMs)
            ),
        ]);
        if (!serialized_tx) {
            throw new Error('Code evaluation did not return a serialized transaction.');
        }

        console.log(JSON.stringify({
            serialized_tx
        }));
        process.exit(0);
    } catch (error) {
        const reason = error instanceof Error ? error.message : 'An unknown error occurred.';
        // For skill execution errors, return a proper error format
        console.log(JSON.stringify({
            serialized_tx: null,
            error: reason,
            trace: error instanceof Error && error.stack ? error.stack : (error?.toString?.() ?? String(error))
        }));
        process.exit(1);
    }
}

runSkill();
