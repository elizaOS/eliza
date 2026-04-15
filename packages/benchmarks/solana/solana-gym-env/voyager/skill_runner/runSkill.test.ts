import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const fixtureRoot = __dirname;
const tmpDir = path.join(fixtureRoot, ".tmp");

function getLastJsonLine(output: string) {
    const lines = output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const jsonLine = lines.at(-1);

    if (!jsonLine) {
        throw new Error("Skill runner did not emit JSON output.");
    }

    return JSON.parse(jsonLine);
}

async function runSkill(filePath: string, timeoutMs: number, extraArgs: string[] = []) {
    const { stdout } = await execFileAsync(
        "bun",
        ["run", "./runSkill.ts", filePath, String(timeoutMs), ...extraArgs],
        { cwd: fixtureRoot },
    );

    return getLastJsonLine(stdout);
}

async function runSkillExpectFailure(
    filePath: string,
    timeoutMs: number,
    extraArgs: string[] = [],
) {
    try {
        await runSkill(filePath, timeoutMs, extraArgs);
        throw new Error("Expected skill execution to fail.");
    } catch (error: any) {
        if (typeof error?.stdout === "string" && error.stdout.trim().length > 0) {
            return getLastJsonLine(error.stdout);
        }

        throw error;
    }
}

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("runs env-style skills and returns tuple metadata", async () => {
    const result = await runSkill(path.join(fixtureRoot, "test_simple.ts"), 5_000);

    expect(result.success).toBe(true);
    expect(result.reward).toBe(1);
    expect(result.done_reason).toBe("success");
    expect(result.tx_receipt_json_string).toBeTruthy();
    expect(result.serialized_tx).toBe(result.tx_receipt_json_string);
});

test("runs legacy blockhash-style skills and returns serialized transactions", async () => {
    const result = await runSkill(path.join(fixtureRoot, "_test_skill.ts"), 5_000, [
        "11111111111111111111111111111111",
        "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
    ]);

    expect(result.success).toBe(true);
    expect(result.serialized_tx).toBeTruthy();
    expect(() => Buffer.from(result.serialized_tx, "base64")).not.toThrow();
});

test("returns a structured error when executeSkill is missing", async () => {
    const result = await runSkillExpectFailure(path.join(fixtureRoot, "_test_wrong.ts"), 5_000);

    expect(result.success).toBe(false);
    expect(result.done_reason).toBe("error");
    expect(result.error).toContain("executeSkill function not found");
});

test("returns a structured timeout error", async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const timeoutFixture = path.join(tmpDir, "timeout.ts");
    fs.writeFileSync(
        timeoutFixture,
        `
export async function executeSkill(): Promise<[number, string, string | null]> {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return [1, "late", null];
}
`.trimStart(),
    );

    const result = await runSkillExpectFailure(timeoutFixture, 25);

    expect(result.success).toBe(false);
    expect(result.done_reason).toBe("error");
    expect(result.error).toContain("timed out");
});
