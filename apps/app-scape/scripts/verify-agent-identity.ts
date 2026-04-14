/**
 * Verify the self-generating agent identity helper:
 *   1. First call with no overrides + no file → generates + writes
 *   2. Second call with the same file path → reuses existing
 *   3. Call with override → overrides win
 *   4. Malformed file → regenerates gracefully
 *
 * Uses a tmpdir so it can run in parallel / repeatedly without
 * stomping on the real ~/.eliza/scape-agent-identity.json.
 */

import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadOrGenerateAgentIdentity } from "../src/services/agent-identity.js";

function assertTrue(label: string, ok: boolean): void {
    if (ok) {
        console.log(`  ✓ ${label}`);
    } else {
        console.log(`  ✗ ${label}`);
        process.exitCode = 1;
    }
}

function main(): void {
    console.log("[verify-agent-identity] starting");

    const testDir = join(tmpdir(), `scape-identity-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, "scape-agent-identity.json");

    try {
        // 1. Cold start — file does not exist, no overrides.
        console.log("\n[1] cold start generates + persists");
        assertTrue("file does NOT exist before call", !existsSync(filePath));
        const first = loadOrGenerateAgentIdentity({ filePath, log: () => {} });
        assertTrue(
            "displayName matches `agent-XXXXXX` shape",
            /^agent-[0-9a-f]{6}$/.test(first.displayName),
        );
        assertTrue(
            "displayName is exactly 12 chars (server display budget)",
            first.displayName.length === 12,
        );
        assertTrue(
            "password is ≥ 16 chars (well above 8-char minimum)",
            first.password.length >= 16,
        );
        assertTrue(
            `agentId has the scape- prefix (got "${first.agentId}")`,
            first.agentId.startsWith("scape-"),
        );
        assertTrue("file exists after call", existsSync(filePath));
        const persistedRaw = readFileSync(filePath, "utf-8");
        const persisted = JSON.parse(persistedRaw);
        assertTrue(
            "persisted file has the same displayName",
            persisted.displayName === first.displayName,
        );
        assertTrue(
            "persisted file has the same password",
            persisted.password === first.password,
        );

        // 2. Warm start — same file, no overrides → reuse
        console.log("\n[2] warm start reuses persisted identity");
        const second = loadOrGenerateAgentIdentity({ filePath, log: () => {} });
        assertTrue(
            "second call returns the same displayName",
            second.displayName === first.displayName,
        );
        assertTrue(
            "second call returns the same password",
            second.password === first.password,
        );
        assertTrue(
            "second call returns the same agentId",
            second.agentId === first.agentId,
        );
        assertTrue(
            "createdAt did NOT change on reuse",
            second.createdAt === first.createdAt,
        );

        // 3. Overrides beat both the file and generation
        console.log("\n[3] explicit overrides win");
        const overridden = loadOrGenerateAgentIdentity({
            filePath,
            overrides: {
                displayName: "operator-pin",
                password: "hunter2hunter2hunter2",
                agentId: "pinned-agent-id",
            },
            log: () => {},
        });
        assertTrue(
            "override displayName applied",
            overridden.displayName === "operator-pin",
        );
        assertTrue(
            "override password applied",
            overridden.password === "hunter2hunter2hunter2",
        );
        assertTrue(
            "override agentId applied",
            overridden.agentId === "pinned-agent-id",
        );
        // Overriding ALSO writes back — the file should now have the
        // pinned values so subsequent runs see them.
        const afterOverride = JSON.parse(readFileSync(filePath, "utf-8"));
        assertTrue(
            "override was persisted",
            afterOverride.displayName === "operator-pin" &&
                afterOverride.password === "hunter2hunter2hunter2",
        );

        // 4. Malformed file falls back to fresh generation
        console.log("\n[4] malformed file regenerates");
        writeFileSync(filePath, "not valid json at all");
        const regenerated = loadOrGenerateAgentIdentity({
            filePath,
            log: () => {},
        });
        assertTrue(
            "regenerated displayName matches agent-XXXXXX shape",
            /^agent-[0-9a-f]{6}$/.test(regenerated.displayName),
        );
        assertTrue(
            "regenerated password is populated",
            regenerated.password.length >= 16,
        );
        assertTrue(
            "file is valid JSON again",
            (() => {
                try {
                    JSON.parse(readFileSync(filePath, "utf-8"));
                    return true;
                } catch {
                    return false;
                }
            })(),
        );
    } finally {
        try {
            rmSync(testDir, { recursive: true, force: true });
        } catch {}
    }

    if (process.exitCode === 1) {
        console.log("\n[verify-agent-identity] FAILED");
    } else {
        console.log("\n[verify-agent-identity] PASSED");
    }
}

main();
