import { expect, test } from "bun:test";
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const runSkillCommand = "bun run ./runSkill.ts";

test("should return success for a passing skill", async () => {
    const { stdout } = await execAsync(`${runSkillCommand} tests/ts/pass.ts 10000`);
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
}, 15000);

test("should return failure for a failing skill", async () => {
    try {
        await execAsync(`${runSkillCommand} tests/ts/fail.ts 5000`);
    } catch (error: any) {
        const result = JSON.parse(error.stderr);
        expect(result.success).toBe(false);
        expect(result.reason).toBe("This skill is designed to fail.");
    }
});

test("should time out and return failure", async () => {
    try {
        await execAsync(`${runSkillCommand} tests/ts/timeout.ts 1000`);
    } catch (error: any) {
        const result = JSON.parse(error.stderr);
        expect(result.success).toBe(false);
        expect(result.reason).toBe("Skill execution timed out.");
    }
});
