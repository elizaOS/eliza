// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Multi-turn apt-get install flow.
 *
 * Entry: the INSTALL_PACKAGE action calls `beginInstallPackageFlow` after
 * it has resolved + validated the package list. We don't snipe install
 * intent in `shouldStartInstallPackageFlow` the way wifi/persistence
 * flows do, because the action's regex already does the heavy lifting
 * (verb + name + apt-cache check) and we want its replies to surface
 * apt-cache errors immediately, not "ready?".
 *
 *   step "confirm"  — first turn after entry. User says yes/no.
 *      yes → transition to "running", spawn apt-get, stream progress.
 *      no  → clearFlow + "OK, skipped."
 *   step "running"  — install in flight. Most user messages just echo
 *      "still working on X — N% done." `cancel` / `stop` kills the
 *      apt process (BAIL_WORDS handled by dispatch.ts cover this too).
 *
 * The actual apt-get spawn happens in `beginInstallPackageFlow` after
 * the "yes" answer arrives — we don't fire-and-forget at entry because
 * the user might still bail. The promise runs in the background; the
 * flow state's `step = "running"` is what tells subsequent turns
 * "we're mid-install".
 *
 * Boundaries (spawn) are injected via `beginInstallPackageFlow`'s
 * options so tests don't shell out to apt.
 */

import {
    DEFAULT_SPAWN,
    type SpawnStream,
    type SpawnStreamFn,
} from "./install-package-runner.ts";
import { clearFlow, setFlow, type FlowState } from "./state.ts";

export interface InstallPackageFlowReply {
    readonly reply: string;
    /** True when this turn ended the flow (success, bail, or hard failure). */
    readonly done: boolean;
}

export interface BeginInstallPackageOptions {
    readonly packages: readonly string[];
    readonly sizeMb: number;
    readonly spawnFn?: SpawnStreamFn;
}

/**
 * In-process registry of running installs. Maps the flow's "running"
 * marker to the live SpawnStream so `cancel` can kill it. Capped at
 * one entry — concurrent installs would race over the dpkg lock anyway.
 */
const RUNNING_INSTALLS = new Map<string, SpawnStream>();
const INSTALL_KEY = "current";

export function isInstallRunning(): boolean {
    return RUNNING_INSTALLS.has(INSTALL_KEY);
}

/**
 * Format the confirm prompt — used at entry and re-used in some test
 * assertions. Plural "packages" only when >1.
 */
export function formatConfirmPrompt(packages: readonly string[], sizeMb: number): string {
    if (packages.length === 0) {
        return "I don't have any packages to install.";
    }
    if (packages.length === 1) {
        return `I can install ${packages[0]} (~${sizeMb} MB). Want to proceed? yes / no`;
    }
    const joined = formatList(packages);
    return `I can install ${joined} (~${sizeMb} MB total). Proceed? yes / no`;
}

function formatList(items: readonly string[]): string {
    if (items.length === 0) return "";
    if (items.length === 1) return items[0] ?? "";
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * Begin the flow. Persists the package list + size to flow state and
 * returns the confirm prompt. If another install is already running we
 * bail out at this stage rather than queueing.
 */
export async function beginInstallPackageFlow(
    options: BeginInstallPackageOptions,
): Promise<InstallPackageFlowReply> {
    if (isInstallRunning()) {
        return {
            reply:
                "I'm already running an install — let me finish that one first, " +
                "or say 'cancel' to stop it.",
            done: true,
        };
    }
    if (options.packages.length === 0) {
        return { reply: "I don't have any packages to install.", done: true };
    }
    setFlow({
        schema_version: 1,
        flowId: "install-package",
        step: "confirm",
        data: {
            packages: [...options.packages],
            size_mb: options.sizeMb,
            log: [],
        },
        updatedAt: Date.now(),
    });
    // Stash the spawnFn for the "yes" branch. Goes into the in-memory
    // map keyed by the same INSTALL_KEY so cancel can find it; we use
    // a separate map for spawn-fns vs running streams.
    if (options.spawnFn !== undefined) {
        SPAWN_FN_OVERRIDE.set(INSTALL_KEY, options.spawnFn);
    } else {
        SPAWN_FN_OVERRIDE.delete(INSTALL_KEY);
    }
    return {
        reply: formatConfirmPrompt(options.packages, options.sizeMb),
        done: false,
    };
}

/** Test hook — lets us inject the spawn fn at entry, pulled back at yes. */
const SPAWN_FN_OVERRIDE = new Map<string, SpawnStreamFn>();

function isYes(message: string): boolean {
    const norm = message.trim().toLowerCase();
    if (norm === "") return false;
    const yes = ["y", "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "go", "do it", "proceed", "go ahead"];
    return yes.some((y) => norm === y || norm.startsWith(y + " ") || norm.startsWith(y + "."));
}

function isNo(message: string): boolean {
    const norm = message.trim().toLowerCase();
    const no = ["n", "no", "nope", "not now", "not yet", "later", "wait"];
    return no.some((n) => norm === n || norm.startsWith(n + " ") || norm.startsWith(n + "."));
}

/**
 * Apt-get's `Setting up X (...)` lines on stdout signal a package
 * finished installing — we count those to surface progress and to
 * compose the success summary.
 */
const SETTING_UP_RE = /^Setting up\s+([a-z0-9][a-z0-9.+\-:_]*)/i;

/**
 * Run the install in the background. Streams stdout/stderr lines into
 * the result accumulator; the next user turn surfaces the partial
 * progress to chat. Stores the spawn stream so `cancel` can kill it.
 */
interface InstallResult {
    status: "ok" | "failed" | "cancelled";
    exitCode: number | null;
    installedCount: number;
    durationMs: number;
    lastError: string;
}

interface RunningInstall {
    promise: Promise<InstallResult>;
    state: { installedCount: number; lastLine: string };
}

const RUNNING_TRACKERS = new Map<string, RunningInstall>();

function startInstall(packages: readonly string[], spawnFn: SpawnStreamFn): RunningInstall {
    const tracker = { installedCount: 0, lastLine: "" };
    const args = ["apt-get", "install", "-y", "--no-install-recommends", ...packages];
    const handle = spawnFn("sudo", args);
    RUNNING_INSTALLS.set(INSTALL_KEY, handle);

    const promise: Promise<InstallResult> = (async () => {
        const startedAt = Date.now();
        let lastError = "";
        let cancelled = false;
        const stdoutReader = (async () => {
            for await (const line of handle.stdout) {
                tracker.lastLine = line;
                const m = SETTING_UP_RE.exec(line);
                if (m !== null) tracker.installedCount += 1;
            }
        })();
        const stderrReader = (async () => {
            for await (const line of handle.stderr) {
                if (line.trim().length > 0) lastError = line;
                if (line.toLowerCase().includes("interrupt")) cancelled = true;
            }
        })();
        await Promise.all([stdoutReader, stderrReader]);
        const exitCode = await handle.exit;
        RUNNING_INSTALLS.delete(INSTALL_KEY);
        RUNNING_TRACKERS.delete(INSTALL_KEY);
        const durationMs = Date.now() - startedAt;
        if (cancelled) {
            return { status: "cancelled" as const, exitCode, installedCount: tracker.installedCount, durationMs, lastError };
        }
        if (exitCode === 0) {
            return { status: "ok" as const, exitCode, installedCount: tracker.installedCount, durationMs, lastError };
        }
        return { status: "failed" as const, exitCode, installedCount: tracker.installedCount, durationMs, lastError };
    })();

    const running: RunningInstall = { promise, state: tracker };
    RUNNING_TRACKERS.set(INSTALL_KEY, running);
    return running;
}

/**
 * Format a duration in ms as a short "Xm Ys" / "Ys" string for the
 * success summary.
 */
export function formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min === 0) return `${sec}s`;
    return `${min}m ${sec}s`;
}

async function handleConfirm(message: string, state: FlowState): Promise<InstallPackageFlowReply> {
    const packages = Array.isArray(state.data.packages)
        ? (state.data.packages as unknown[]).filter((p) => typeof p === "string") as string[]
        : [];
    if (packages.length === 0) {
        clearFlow();
        return { reply: "I lost track of which packages — try the install again.", done: true };
    }
    if (isNo(message)) {
        clearFlow();
        SPAWN_FN_OVERRIDE.delete(INSTALL_KEY);
        return { reply: "OK, skipped.", done: true };
    }
    if (!isYes(message)) {
        return {
            reply: "Just yes or no — should I install " + formatList(packages) + "?",
            done: false,
        };
    }
    const spawnFn = SPAWN_FN_OVERRIDE.get(INSTALL_KEY) ?? DEFAULT_SPAWN;
    SPAWN_FN_OVERRIDE.delete(INSTALL_KEY);

    setFlow({
        schema_version: 1,
        flowId: "install-package",
        step: "running",
        data: {
            packages,
            size_mb: typeof state.data.size_mb === "number" ? state.data.size_mb : 0,
            log: [],
            started_at: Date.now(),
        },
        updatedAt: Date.now(),
    });

    const running = startInstall(packages, spawnFn);
    // Await the promise BUT race a short timer so the chat sees a quick
    // initial ack rather than blocking until apt finishes. The next
    // user message (or a UI poll) re-enters handleRunning to surface
    // completion. We DO await the promise so test environments that
    // call beginInstallPackageFlow → "yes" can `await` the resulting
    // reply chain deterministically: when the spawn returns instantly
    // (mock), we report success on this turn; otherwise we tell the
    // user the install is running.
    const result = await Promise.race<InstallResult | "pending">([
        running.promise,
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    if (result === "pending") {
        return {
            reply: `Installing ${formatList(packages)} — I'll keep going in the background. Ask me how it's going.`,
            done: false,
        };
    }
    clearFlow();
    return formatInstallResult(packages, result);
}

function formatInstallResult(
    packages: readonly string[],
    result: InstallResult,
): InstallPackageFlowReply {
    if (result.status === "ok") {
        const dur = formatDuration(result.durationMs);
        const headPkg = packages[0] ?? "package";
        const extras = result.installedCount > packages.length
            ? ` + ${result.installedCount - packages.length} deps`
            : packages.length > 1
                ? ` + ${packages.length - 1} more`
                : "";
        return {
            reply: `Installed ${headPkg}${extras} in ${dur}.`,
            done: true,
        };
    }
    if (result.status === "cancelled") {
        return {
            reply: "Install cancelled.",
            done: true,
        };
    }
    const detail = result.lastError.trim().slice(0, 160);
    const suffix = detail.length > 0 ? ` (apt: "${detail}")` : "";
    return {
        reply: `Install failed${suffix}. Try 'apt update' from a terminal and ask me again.`,
        done: true,
    };
}

async function handleRunning(message: string, state: FlowState): Promise<InstallPackageFlowReply> {
    const packages = Array.isArray(state.data.packages)
        ? (state.data.packages as unknown[]).filter((p) => typeof p === "string") as string[]
        : [];
    const norm = message.trim().toLowerCase();
    const wantsCancel =
        norm === "cancel" || norm === "stop" || norm.includes("kill it") || norm.includes("abort");

    const running = RUNNING_TRACKERS.get(INSTALL_KEY);
    if (running === undefined) {
        // Install finished while the user was typing — surface that
        // and clear the flow on the next handle. Without a tracker we
        // can't tell ok vs failed, so go optimistic.
        clearFlow();
        return { reply: "Just finished — installed.", done: true };
    }
    if (wantsCancel) {
        const handle = RUNNING_INSTALLS.get(INSTALL_KEY);
        if (handle !== undefined) handle.kill();
        const result = await running.promise;
        clearFlow();
        return formatInstallResult(packages, result);
    }
    // Race: if the install finished on its own while the user was
    // typing, report success; otherwise echo "still working".
    const result = await Promise.race<InstallResult | "pending">([
        running.promise,
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    if (result === "pending") {
        const progress = running.state.installedCount;
        const total = packages.length;
        return {
            reply: `Still installing ${formatList(packages)} — ${progress}/${total} done so far.`,
            done: false,
        };
    }
    clearFlow();
    return formatInstallResult(packages, result);
}

/**
 * Continue an in-progress install-package flow. Mirrors the
 * wifi/persistence handlers — bail check happens in dispatch.ts.
 */
export async function continueInstallPackageFlow(
    message: string,
    state: FlowState,
): Promise<InstallPackageFlowReply> {
    if (state.flowId !== "install-package") {
        return {
            reply: "I lost track — start over with 'install <package>'.",
            done: true,
        };
    }
    switch (state.step) {
        case "confirm":
            return await handleConfirm(message, state);
        case "running":
            return await handleRunning(message, state);
        default:
            clearFlow();
            return {
                reply: "I lost track of where we were. Try 'install <package>' again.",
                done: true,
            };
    }
}

/**
 * Test helper — wipes the in-memory running-install registry so each
 * test starts with a clean slate.
 */
export function _resetInstallRegistry(): void {
    for (const handle of RUNNING_INSTALLS.values()) {
        try {
            handle.kill();
        } catch {
            // best-effort
        }
    }
    RUNNING_INSTALLS.clear();
    RUNNING_TRACKERS.clear();
    SPAWN_FN_OVERRIDE.clear();
}
