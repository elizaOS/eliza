// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    beginPersistenceFlow,
    continuePersistenceFlow,
    shouldStartPersistenceFlow,
    validatePassphrase,
    type PersistenceResult,
    type PersistenceRunner,
} from "../../../src/runtime/flows/persistence-flow.ts";
import { clearFlow, getFlowState } from "../../../src/runtime/flows/state.ts";

let tempDir = "";
const originalStateDir = process.env.USBELIZA_STATE_DIR;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "usbeliza-persist-flow-"));
    process.env.USBELIZA_STATE_DIR = tempDir;
});

afterEach(() => {
    clearFlow();
    if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
    if (originalStateDir !== undefined) {
        process.env.USBELIZA_STATE_DIR = originalStateDir;
    } else {
        delete process.env.USBELIZA_STATE_DIR;
    }
});

/** Build a fake runner that returns the given result without spawning anything. */
function fakeRunner(result: PersistenceResult): PersistenceRunner & {
    /** Passphrase received by the last run() call. */
    received: { passphrase: string } | null;
} {
    const r: PersistenceRunner & { received: { passphrase: string } | null } = {
        received: null,
        async run(passphrase) {
            r.received = { passphrase };
            return result;
        },
    };
    return r;
}

describe("shouldStartPersistenceFlow", () => {
    test("triggers on the standard phrases", () => {
        expect(shouldStartPersistenceFlow("set up persistence")).toBe(true);
        expect(shouldStartPersistenceFlow("encrypt my stuff")).toBe(true);
        expect(shouldStartPersistenceFlow("enable luks")).toBe(true);
        expect(shouldStartPersistenceFlow("turn on persistence please")).toBe(true);
        expect(shouldStartPersistenceFlow("I want persistent storage")).toBe(true);
    });

    test("ignores unrelated chat", () => {
        expect(shouldStartPersistenceFlow("what's the weather")).toBe(false);
        expect(shouldStartPersistenceFlow("build me a calendar")).toBe(false);
        expect(shouldStartPersistenceFlow("")).toBe(false);
    });
});

describe("validatePassphrase", () => {
    test("accepts 8+ char unique passphrases", () => {
        expect(validatePassphrase("hunter2is8")).toBeNull();
        expect(validatePassphrase("correct-horse-battery-staple")).toBeNull();
    });

    test("rejects passphrases shorter than 8 chars", () => {
        expect(validatePassphrase("short")?.tooShort).toBe(true);
        expect(validatePassphrase("1234567")?.tooShort).toBe(true);
        expect(validatePassphrase("")?.tooShort).toBe(true);
    });

    test("rejects dictionary-blocked weak passphrases", () => {
        expect(validatePassphrase("password")?.tooWeak).toBe(true);
        expect(validatePassphrase("12345678")?.tooWeak).toBe(true);
        expect(validatePassphrase("PASSWORD")?.tooWeak).toBe(true);
        expect(validatePassphrase("letmein!")?.tooWeak).toBe(true);
    });
});

describe("persistence flow — entry", () => {
    test("beginPersistenceFlow sets awaiting-confirm + warm explanation", async () => {
        const out = await beginPersistenceFlow();
        expect(out.done).toBe(false);
        expect(out.reply.toLowerCase()).toContain("encrypted partition");
        expect(out.reply.toLowerCase()).toContain("ready");
        const flow = getFlowState();
        expect(flow?.flowId).toBe("persistence-setup");
        expect(flow?.step).toBe("awaiting-confirm");
    });

    test("explanation reply has no markdown bullets", async () => {
        const out = await beginPersistenceFlow();
        const bulletLines = out.reply
            .split("\n")
            .filter((l) => l.trim().startsWith("- ") || l.trim().startsWith("* "));
        expect(bulletLines).toHaveLength(0);
    });
});

describe("persistence flow — awaiting-confirm", () => {
    test("'yes' advances to awaiting-passphrase", async () => {
        await beginPersistenceFlow();
        const out = await continuePersistenceFlow("yes", getFlowState()!);
        expect(out.done).toBe(false);
        expect(out.reply.toLowerCase()).toContain("passphrase");
        expect(getFlowState()?.step).toBe("awaiting-passphrase");
    });

    test("'ok' / 'sure' / 'ready' also advance", async () => {
        await beginPersistenceFlow();
        let out = await continuePersistenceFlow("sure", getFlowState()!);
        expect(getFlowState()?.step).toBe("awaiting-passphrase");
        clearFlow();
        await beginPersistenceFlow();
        out = await continuePersistenceFlow("ready", getFlowState()!);
        expect(out.done).toBe(false);
        expect(getFlowState()?.step).toBe("awaiting-passphrase");
    });

    test("'no' clears the flow with a friendly acknowledgement", async () => {
        await beginPersistenceFlow();
        const out = await continuePersistenceFlow("no", getFlowState()!);
        expect(out.done).toBe(true);
        expect(getFlowState()).toBeNull();
        expect(out.reply.toLowerCase()).toContain("no encryption");
    });

    test("ambiguous answer stays in awaiting-confirm + re-asks", async () => {
        await beginPersistenceFlow();
        const out = await continuePersistenceFlow("maybe", getFlowState()!);
        expect(out.done).toBe(false);
        expect(getFlowState()?.step).toBe("awaiting-confirm");
        expect(out.reply.toLowerCase()).toContain("yes or no");
    });
});

describe("persistence flow — awaiting-passphrase", () => {
    async function setupAtPassphraseStep() {
        await beginPersistenceFlow();
        await continuePersistenceFlow("yes", getFlowState()!);
    }

    test("short passphrase → 'pretty short' nudge, stays in step", async () => {
        await setupAtPassphraseStep();
        const out = await continuePersistenceFlow("short", getFlowState()!);
        expect(out.done).toBe(false);
        expect(out.reply.toLowerCase()).toContain("pretty short");
        expect(getFlowState()?.step).toBe("awaiting-passphrase");
    });

    test("weak/dictionary passphrase → 'common-password' nudge", async () => {
        await setupAtPassphraseStep();
        const out = await continuePersistenceFlow("password", getFlowState()!);
        expect(out.done).toBe(false);
        expect(out.reply.toLowerCase()).toContain("common-password");
    });

    test("strong passphrase advances to awaiting-passphrase-confirm + reports length", async () => {
        await setupAtPassphraseStep();
        const out = await continuePersistenceFlow("hunter2is8chars", getFlowState()!);
        expect(out.done).toBe(false);
        expect(out.reply).toContain("15 characters");
        expect(out.reply.toLowerCase()).toContain("type it once more");
        expect(getFlowState()?.step).toBe("awaiting-passphrase-confirm");
        // The passphrase is persisted in flow.data so the confirm step
        // can compare. Tests check that fact so we'd catch a regression
        // that broke the confirm comparison.
        expect(getFlowState()?.data.passphrase).toBe("hunter2is8chars");
    });
});

describe("persistence flow — awaiting-passphrase-confirm", () => {
    async function setupAtConfirmStep(passphrase = "hunter2is8chars") {
        await beginPersistenceFlow();
        await continuePersistenceFlow("yes", getFlowState()!);
        await continuePersistenceFlow(passphrase, getFlowState()!);
    }

    test("match → runs LUKS setup, reports success, clears flow", async () => {
        await setupAtConfirmStep();
        const runner = fakeRunner({ kind: "success" });
        const out = await continuePersistenceFlow(
            "hunter2is8chars",
            getFlowState()!,
            runner,
        );
        expect(out.done).toBe(true);
        expect(runner.received?.passphrase).toBe("hunter2is8chars");
        expect(out.reply.toLowerCase()).toContain("done");
        expect(out.reply.toLowerCase()).toContain("persist");
        expect(out.reply.toLowerCase()).toContain("passphrase prompt");
        expect(getFlowState()).toBeNull();
    });

    test("mismatch → restart at awaiting-passphrase, stays in flow", async () => {
        await setupAtConfirmStep();
        const runner = fakeRunner({ kind: "success" });
        const out = await continuePersistenceFlow("typotypotypoo", getFlowState()!, runner);
        expect(out.done).toBe(false);
        expect(out.reply.toLowerCase()).toContain("don't match");
        expect(getFlowState()?.step).toBe("awaiting-passphrase");
        // The runner should NOT have been invoked on a mismatch.
        expect(runner.received).toBeNull();
    });

    test("runner failure surfaces the message, clears flow", async () => {
        await setupAtConfirmStep();
        const runner = fakeRunner({
            kind: "failed",
            message: "cryptsetup exited 5",
        });
        const out = await continuePersistenceFlow(
            "hunter2is8chars",
            getFlowState()!,
            runner,
        );
        expect(out.done).toBe(true);
        expect(out.reply.toLowerCase()).toContain("didn't complete");
        expect(out.reply).toContain("cryptsetup exited 5");
        expect(getFlowState()).toBeNull();
    });

    test("'already-set-up' result gives the reformat hint", async () => {
        await setupAtConfirmStep();
        const runner = fakeRunner({ kind: "already-set-up" });
        const out = await continuePersistenceFlow(
            "hunter2is8chars",
            getFlowState()!,
            runner,
        );
        expect(out.done).toBe(true);
        expect(out.reply.toLowerCase()).toContain("already");
        expect(out.reply.toLowerCase()).toContain("reformat");
        expect(getFlowState()).toBeNull();
    });

    test("'write-protected' result mentions the physical switch", async () => {
        await setupAtConfirmStep();
        const runner = fakeRunner({ kind: "write-protected" });
        const out = await continuePersistenceFlow(
            "hunter2is8chars",
            getFlowState()!,
            runner,
        );
        expect(out.done).toBe(true);
        expect(out.reply.toLowerCase()).toContain("write-protected");
        expect(out.reply.toLowerCase()).toContain("switch");
        expect(getFlowState()).toBeNull();
    });

    test("runner that throws is caught, flow ends gracefully", async () => {
        await setupAtConfirmStep();
        const runner: PersistenceRunner = {
            async run() {
                throw new Error("boom");
            },
        };
        const out = await continuePersistenceFlow(
            "hunter2is8chars",
            getFlowState()!,
            runner,
        );
        expect(out.done).toBe(true);
        expect(out.reply).toContain("boom");
        expect(getFlowState()).toBeNull();
    });
});

describe("persistence flow — chat reply hygiene", () => {
    test("every reply across the happy path is ≤4 sentences, no bullets", async () => {
        const runner = fakeRunner({ kind: "success" });
        const replies: string[] = [];
        replies.push((await beginPersistenceFlow()).reply);
        replies.push((await continuePersistenceFlow("yes", getFlowState()!)).reply);
        replies.push((await continuePersistenceFlow("hunter2is8chars", getFlowState()!)).reply);
        replies.push(
            (await continuePersistenceFlow("hunter2is8chars", getFlowState()!, runner)).reply,
        );
        for (const r of replies) {
            expect(r.split("\n").some((l) => l.trim().startsWith("- "))).toBe(false);
            expect(r.split("\n").some((l) => l.trim().startsWith("* "))).toBe(false);
            const sentences = r.match(/[.!?]/g) ?? [];
            expect(sentences.length).toBeLessThanOrEqual(4);
        }
    });
});
