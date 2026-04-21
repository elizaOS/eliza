import { describe, test, expect, afterAll } from "bun:test";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

const runSkillPath = path.join(__dirname, "..", "runSkill.ts");
const testSkillsDir = path.join(__dirname, "test_skills");

// Ensure test skills directory exists
if (!fs.existsSync(testSkillsDir)) {
    fs.mkdirSync(testSkillsDir, { recursive: true });
}

describe("Single Transaction Enforcement", () => {
    test("single transaction skill should succeed", () => {
        // Create a skill that executes one transaction
        const singleTxSkill = `
export async function executeSkill(env: any): Promise<[number, string, string | null]> {
    const receipt = await env.simulateTransaction();
    return [1.0, "success", JSON.stringify(receipt)];
}
`;
        const skillPath = path.join(testSkillsDir, "single_tx.ts");
        fs.writeFileSync(skillPath, singleTxSkill);

        // Run the skill (need to run from parent directory)
        const result = execSync(`bun skill_runner/runSkill.ts ${skillPath} 5000`, {
            encoding: "utf-8",
            cwd: path.join(__dirname, "..", "..")
        }).trim();
        
        const output = JSON.parse(result);
        expect(output.reward).toBe(1.0);
        expect(output.done_reason).toBe("success");
        expect(output.tx_receipt_json_string).toBeTruthy();
    });

    test("multiple transaction skill should fail with clear error", () => {
        // Create a skill that attempts two transactions
        const multiTxSkill = `
export async function executeSkill(env: any): Promise<[number, string, string | null]> {
    const receipt1 = await env.simulateTransaction();
    const receipt2 = await env.simulateTransaction(); // This should fail
    return [1.0, "success", JSON.stringify(receipt2)];
}
`;
        const skillPath = path.join(testSkillsDir, "multi_tx.ts");
        fs.writeFileSync(skillPath, multiTxSkill);

        // Run the skill and expect it to fail
        try {
            execSync(`bun skill_runner/runSkill.ts ${skillPath} 5000`, {
                encoding: "utf-8",
                cwd: path.join(__dirname, "..", "..")
            });
            // If we get here, the test failed
            expect(true).toBe(false); // Force failure
        } catch (error: any) {
            const output = JSON.parse(error.stdout || "{}");
            expect(output.reward).toBe(0.0);
            expect(output.done_reason).toContain("error");
            expect(output.error).toContain("SINGLE_TRANSACTION_LIMIT");
            expect(output.error).toContain("create separate skills");
        }
    });

    test("no transaction skill should succeed", () => {
        // Create a skill that doesn't execute any transaction
        const noTxSkill = `
export async function executeSkill(env: any): Promise<[number, string, string | null]> {
    // Just observe, no transaction
    const wallet = env.getWallet();
    return [0.5, "observed", null];
}
`;
        const skillPath = path.join(testSkillsDir, "no_tx.ts");
        fs.writeFileSync(skillPath, noTxSkill);

        // Run the skill
        const result = execSync(`bun skill_runner/runSkill.ts ${skillPath} 5000`, {
            encoding: "utf-8",
            cwd: path.join(__dirname, "..", "..")
        }).trim();
        
        const output = JSON.parse(result);
        expect(output.reward).toBe(0.5);
        expect(output.done_reason).toBe("observed");
        expect(output.tx_receipt_json_string).toBeNull();
    });

    test("transaction counter should reset between skill executions", () => {
        // First execution should succeed
        const skillPath = path.join(testSkillsDir, "single_tx.ts");
        
        const result1 = execSync(`bun skill_runner/runSkill.ts ${skillPath} 5000`, {
            encoding: "utf-8",
            cwd: path.join(__dirname, "..", "..")
        }).trim();
        const output1 = JSON.parse(result1);
        expect(output1.reward).toBe(1.0);

        // Second execution should also succeed (counter reset)
        const result2 = execSync(`bun skill_runner/runSkill.ts ${skillPath} 5000`, {
            encoding: "utf-8",
            cwd: path.join(__dirname, "..", "..")
        }).trim();
        const output2 = JSON.parse(result2);
        expect(output2.reward).toBe(1.0);
    });

    test("error message should provide helpful guidance", () => {
        const skillPath = path.join(testSkillsDir, "multi_tx.ts");
        
        try {
            execSync(`bun skill_runner/runSkill.ts ${skillPath} 5000`, {
                encoding: "utf-8",
                cwd: path.join(__dirname, "..", "..")
            });
        } catch (error: any) {
            const output = JSON.parse(error.stdout || "{}");
            const errorMsg = output.error;
            
            // Check that error message contains helpful guidance
            expect(errorMsg).toContain("Skills can only execute ONE transaction");
            expect(errorMsg).toContain("create separate skills and chain them");
            expect(errorMsg).toContain("This transaction attempt was blocked");
        }
    });
});

// Clean up test files after tests
afterAll(() => {
    if (fs.existsSync(testSkillsDir)) {
        fs.rmSync(testSkillsDir, { recursive: true });
    }
});