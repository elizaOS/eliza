// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Multi-turn LUKS persistence setup flow.
 *
 * Triggered when the user says "set up persistence" / "encrypt my stuff" /
 * "enable luks" — the single-shot SETUP_PERSISTENCE action still
 * matches the same similes but only emits the pre-flow explanation;
 * this flow takes over to drive the full passphrase dance.
 *
 *   step 0 (entry)                     — warm explanation, ask "ready?"
 *   step "awaiting-confirm"            — yes → ask for passphrase.
 *   step "awaiting-passphrase"         — validate length + dictionary,
 *                                        ask for confirmation.
 *   step "awaiting-passphrase-confirm" — match → run cryptsetup, report,
 *                                        else "didn't match, try again".
 *
 * Boundary: the actual LUKS work is delegated to a `PersistenceRunner`
 * — production shells out to the bundled `usbeliza-persistence-setup`
 * script piping the passphrase via stdin; tests inject a fake runner
 * to skip the spawn.
 *
 * Per locked v9 rule: every reply is 1-3 sentences of warm prose, no
 * bullet lists, no menu. The "I can't see what you type" framing in
 * step 2 is a friendly fiction (we do see it — we have to, to set up
 * the LUKS volume) but it reduces typing anxiety. We never echo the
 * passphrase back, only its length.
 */

import { spawn } from "node:child_process";

import { clearFlow, setFlow, type FlowState } from "./state.ts";

export interface PersistenceRunner {
    /**
     * Run the LUKS setup with the given passphrase. Returns a result
     * describing what happened — success, write-protected, already-set-up,
     * or generic failure with a message. The runner is responsible for
     * shelling out to the bundled `usbeliza-persistence-setup` script
     * (or `cryptsetup` directly) and piping the passphrase via stdin so
     * it never appears on a command line or in /proc.
     */
    run(passphrase: string): Promise<PersistenceResult>;
}

export type PersistenceResult =
    | { kind: "success" }
    | { kind: "already-set-up" }
    | { kind: "write-protected" }
    | { kind: "failed"; message: string };

const DEFAULT_RUNNER: PersistenceRunner = {
    async run(passphrase) {
        return await new Promise<PersistenceResult>((resolve) => {
            const script =
                process.env.USBELIZA_PERSIST_SCRIPT ?? "/usr/local/bin/usbeliza-persistence-setup";
            // The script reads the passphrase from stdin (one line) so
            // it never appears in argv.
            const child = spawn("sudo", ["-S", script], {
                stdio: ["pipe", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            child.stdout?.on("data", (chunk: Buffer) => {
                stdout += chunk.toString();
            });
            child.stderr?.on("data", (chunk: Buffer) => {
                stderr += chunk.toString();
            });
            child.on("error", (err) => {
                resolve({ kind: "failed", message: `spawn failed: ${err.message}` });
            });
            child.on("close", (code) => {
                // Exit code 2 = "already set up" sentinel from the
                // setup script when it detects a sealed LUKS partition
                // or an unlocked cleartext one with our label.
                if (code === 2) {
                    resolve({ kind: "already-set-up" });
                    return;
                }
                if (code === 0) {
                    resolve({ kind: "success" });
                    return;
                }
                const lower = (stdout + "\n" + stderr).toLowerCase();
                if (
                    lower.includes("already exists") ||
                    lower.includes("found existing persistence")
                ) {
                    resolve({ kind: "already-set-up" });
                    return;
                }
                if (
                    lower.includes("read-only") ||
                    lower.includes("write-protected") ||
                    lower.includes("permission denied")
                ) {
                    resolve({ kind: "write-protected" });
                    return;
                }
                resolve({
                    kind: "failed",
                    message: stderr.trim().slice(0, 1500) || `exit ${code}`,
                });
            });
            child.stdin?.write(`${passphrase}\n`);
            child.stdin?.end();
        });
    },
};

export interface PersistenceFlowReply {
    readonly reply: string;
    /** True when this turn ended the flow (success, bail, or hard failure). */
    readonly done: boolean;
}

/** Common weak passphrases — reject these even if length passes. */
const WEAK_PASSPHRASES = new Set([
    "password",
    "passw0rd",
    "12345678",
    "123456789",
    "1234567890",
    "qwerty",
    "qwertyuiop",
    "abcdef12",
    "letmein",
    "letmein!",
    "11111111",
    "00000000",
    "iloveyou",
    "trustno1",
]);

export interface PassphraseProblem {
    readonly tooShort?: boolean;
    readonly tooWeak?: boolean;
}

/**
 * Validate a passphrase candidate. Returns `null` on accept, or a
 * problem record on reject. The rules:
 *   - length ≥ 8 chars (cryptsetup accepts shorter, but a LUKS volume
 *     with a 4-char passphrase is a footgun);
 *   - not on the dictionary blocklist above (case-insensitive).
 */
export function validatePassphrase(candidate: string): PassphraseProblem | null {
    if (candidate.length < 8) return { tooShort: true };
    if (WEAK_PASSPHRASES.has(candidate.toLowerCase())) return { tooWeak: true };
    return null;
}

/**
 * Detect the "start a persistence flow" intent from a free-text
 * message. Mirrors the SETUP_PERSISTENCE action's similes but is
 * gated by the dispatcher BEFORE action selection so the multi-turn
 * flow wins.
 */
export function shouldStartPersistenceFlow(message: string): boolean {
    const norm = message.trim().toLowerCase();
    if (norm === "") return false;
    const triggers = [
        "set up persistence",
        "setup persistence",
        "enable persistence",
        "turn on persistence",
        "create encrypted partition",
        "encrypt my disk",
        "encrypt my stuff",
        "encrypt this stick",
        "enable luks",
        "make my stuff persist",
        "make stuff persist",
        "persistent storage",
        "set up encrypted",
    ];
    return triggers.some((t) => norm.includes(t));
}

const INTRO_REPLY =
    "I'll create an encrypted partition on the stick. " +
    "Everything that survives reboots — your apps, your wifi passwords, " +
    "downloaded models — lives there. You'll pick a passphrase you'll " +
    "type at boot. Ready?";

export async function beginPersistenceFlow(): Promise<PersistenceFlowReply> {
    setFlow({
        schema_version: 1,
        flowId: "persistence-setup",
        step: "awaiting-confirm",
        data: {},
        updatedAt: Date.now(),
    });
    return { reply: INTRO_REPLY, done: false };
}

function isYes(message: string): boolean {
    const norm = message.trim().toLowerCase();
    if (norm === "") return false;
    const yes = ["y", "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "ready", "go", "do it", "let's go", "lets go", "go ahead"];
    return yes.some((y) => norm === y || norm.startsWith(y + " ") || norm.startsWith(y + "."));
}

function isNo(message: string): boolean {
    const norm = message.trim().toLowerCase();
    const no = ["n", "no", "nope", "not now", "not yet", "later", "wait"];
    return no.some((n) => norm === n || norm.startsWith(n + " ") || norm.startsWith(n + "."));
}

async function handleAwaitingConfirm(message: string): Promise<PersistenceFlowReply> {
    if (isYes(message)) {
        setFlow({
            schema_version: 1,
            flowId: "persistence-setup",
            step: "awaiting-passphrase",
            data: {},
            updatedAt: Date.now(),
        });
        return {
            reply:
                "Pick a passphrase you'll remember — at least 8 characters, " +
                "something unique. I'll repeat the length so you can confirm. " +
                "Type it when you're ready.",
            done: false,
        };
    }
    if (isNo(message)) {
        clearFlow();
        return {
            reply: "OK, no encryption for now. Say 'set up persistence' anytime to start.",
            done: true,
        };
    }
    // Unclear — stay in this step, gently re-ask.
    return {
        reply: "Just yes or no — ready to set up the encrypted partition?",
        done: false,
    };
}

async function handleAwaitingPassphrase(
    message: string,
    _state: FlowState,
): Promise<PersistenceFlowReply> {
    const passphrase = message; // Don't trim — leading/trailing spaces are valid in a passphrase.
    const problem = validatePassphrase(passphrase);
    if (problem !== null) {
        if (problem.tooShort === true) {
            return {
                reply:
                    "That's pretty short — for an encrypted partition I'd want " +
                    "at least 8 characters, ideally something unique. Want to try a different one?",
                done: false,
            };
        }
        return {
            reply:
                "That one's on the common-password list — I'd really not want it " +
                "guarded by something a script can try in seconds. Want to try a different one?",
            done: false,
        };
    }
    setFlow({
        schema_version: 1,
        flowId: "persistence-setup",
        step: "awaiting-passphrase-confirm",
        data: { passphrase },
        updatedAt: Date.now(),
    });
    return {
        reply: `Got it (${passphrase.length} characters). I'll confirm — type it once more.`,
        done: false,
    };
}

async function handleAwaitingConfirm2(
    message: string,
    state: FlowState,
    runner: PersistenceRunner,
): Promise<PersistenceFlowReply> {
    const passphrase = typeof state.data.passphrase === "string" ? state.data.passphrase : "";
    if (passphrase === "") {
        clearFlow();
        return {
            reply: "I lost track of the passphrase — let's start over with 'set up persistence'.",
            done: true,
        };
    }
    if (message !== passphrase) {
        // Mismatch — go back to the entry step so the user picks fresh.
        setFlow({
            schema_version: 1,
            flowId: "persistence-setup",
            step: "awaiting-passphrase",
            data: {},
            updatedAt: Date.now(),
        });
        return {
            reply:
                "Those don't match — pick the passphrase again and I'll re-confirm. " +
                "Type when you're ready.",
            done: false,
        };
    }
    // Match — run LUKS setup.
    let result: PersistenceResult;
    try {
        result = await runner.run(passphrase);
    } catch (err) {
        clearFlow();
        return {
            reply: `Setup didn't complete — ${(err as Error).message}. Want to try again later?`,
            done: true,
        };
    }
    clearFlow();
    switch (result.kind) {
        case "success":
            return {
                reply:
                    "Done. Your stuff will persist from now on — next boot you'll see " +
                    "a passphrase prompt before the chat box.",
                done: true,
            };
        case "already-set-up":
            return {
                reply:
                    "Looks like this stick already has an encrypted partition. " +
                    "If you want to wipe and start over, open a terminal and run " +
                    "the setup script with --reformat.",
                done: true,
            };
        case "write-protected":
            return {
                reply:
                    "The stick is write-protected — most USB sticks have a tiny " +
                    "switch on the side. Toggle it, then ask me again.",
                done: true,
            };
        case "failed":
            return {
                reply:
                    `Setup didn't complete: ${result.message}. ` +
                    "Want to try again, or open a terminal to look at the partition directly?",
                done: true,
            };
    }
}

/**
 * Continue an in-progress persistence flow. The dispatcher already
 * handled the universal bail check, so this function trusts the
 * message is an in-flow answer.
 */
export async function continuePersistenceFlow(
    message: string,
    state: FlowState,
    runner: PersistenceRunner = DEFAULT_RUNNER,
): Promise<PersistenceFlowReply> {
    if (state.flowId !== "persistence-setup") {
        return {
            reply: "I lost track — start over with 'set up persistence'.",
            done: true,
        };
    }
    switch (state.step) {
        case "awaiting-confirm":
            return await handleAwaitingConfirm(message);
        case "awaiting-passphrase":
            return await handleAwaitingPassphrase(message, state);
        case "awaiting-passphrase-confirm":
            return await handleAwaitingConfirm2(message, state, runner);
        default:
            clearFlow();
            return {
                reply: "I lost track of where we were. Try 'set up persistence' again.",
                done: true,
            };
    }
}
