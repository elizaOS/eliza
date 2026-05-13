// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * DOWNLOAD_MODEL — pull a bigger local LLM from HuggingFace and pin it
 * as the new default.
 *
 * Flow:
 *
 *   1. Resolve which model the user wants: either an explicit phrase
 *      ("download qwen 7b") matched against MODEL_CATALOG.displayName via
 *      a tiny token-overlap scorer, or — if no specific model named —
 *      the recommended tier from `recommendModelTier()`.
 *   2. Stream `curl -fL <url> -o <path>` and tail its stderr for the
 *      transfer-progress line (curl's -# style or its default
 *      progress-meter row). Surface "Downloading X — 23%" via the
 *      callback as percentages tick up.
 *   3. On success, write `~/.eliza/active-model.toml` with `path = "..."`
 *      so the local-llama plugin picks it up on next runtime restart.
 *   4. Reply with the size + restart hint, optionally calling
 *      `runtime.restartAgent?.()` if the runtime supports it.
 *
 * Spawn boundary is injected via runtime `options` (same pattern as
 * LOGIN_CLAUDE) so tests don't pull GGUFs over the network.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Action, ActionExample, IAgentRuntime } from "@elizaos/core";

import {
    buildHuggingFaceResolveUrl,
    type CatalogModel,
    MODEL_CATALOG,
} from "../../local-inference/catalog.ts";
import { recommendModelTier } from "../../local-inference/picker.ts";
import { normalize } from "../match.ts";

/**
 * Model-name resolution. Splits both the user text and each catalog
 * `displayName` into normalized content tokens, scores by intersection
 * size, and returns the highest-scoring chat-category model above a
 * minimum-shared-tokens threshold. Returns null if nothing meaningful
 * matches (caller falls back to `recommendModelTier`).
 */
export function resolveRequestedModel(
    userText: string,
    catalog: readonly CatalogModel[] = MODEL_CATALOG,
): CatalogModel | null {
    const msgTokens = new Set(
        normalize(userText).filter(
            (t) => !["download", "get", "pull", "install", "model", "a", "the", "me", "give"].includes(t),
        ),
    );
    if (msgTokens.size === 0) return null;

    let best: { model: CatalogModel; score: number } | null = null;
    for (const model of catalog) {
        if (model.category !== "chat") continue;
        const nameTokens = new Set(normalize(model.displayName));
        let shared = 0;
        for (const t of msgTokens) if (nameTokens.has(t)) shared++;
        if (shared === 0) continue;
        if (best === null || shared > best.score) {
            best = { model, score: shared };
        }
    }
    return best?.model ?? null;
}

/** Where downloaded GGUFs land. Honors `USBELIZA_MODELS_DIR` for tests. */
export function modelsDir(): string {
    const explicit = Bun.env.USBELIZA_MODELS_DIR;
    if (explicit !== undefined && explicit !== "") return explicit;
    const home = Bun.env.HOME ?? "/home/eliza";
    return `${home}/.eliza/models`;
}

/** Where the "active model" pointer lives. */
export function activeModelTomlPath(): string {
    const explicit = Bun.env.USBELIZA_ACTIVE_MODEL_TOML;
    if (explicit !== undefined && explicit !== "") return explicit;
    const home = Bun.env.HOME ?? "/home/eliza";
    return `${home}/.eliza/active-model.toml`;
}

/**
 * curl's progress lines look (after newlines/CR-overprints) something like:
 *
 *   "  3 4760M    3  166M    0     0  73.2M      0  0:01:04  0:00:02  0:01:02 73.2M"
 *
 * The 1st numeric column on each row IS the percent (0–100). curl writes
 * progress to stderr; we strip CR-overprint and grab the first integer of
 * the latest line. Exported for tests.
 */
export function parseCurlPercent(line: string): number | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    const m = /^(\d+)\b/.exec(trimmed);
    if (m === null || m[1] === undefined) return null;
    const v = parseInt(m[1], 10);
    if (Number.isNaN(v) || v < 0 || v > 100) return null;
    return v;
}

export interface SpawnStream {
    readonly stderr: AsyncIterable<string>;
    readonly exit: Promise<number | null>;
    kill(): void;
}

export type SpawnStreamFn = (cmd: string, args: readonly string[]) => SpawnStream;

/**
 * Production spawn using Bun.spawn. We pipe stderr through a
 * TextDecoder + line splitter so consumers see one curl-progress row
 * per yield. Errors at spawn time (binary missing) are translated to
 * an immediate exit=null result so callers can detect them.
 */
function defaultSpawn(cmd: string, args: readonly string[]): SpawnStream {
    let proc: Bun.Subprocess<"ignore", "ignore", "pipe"> | null = null;
    try {
        proc = Bun.spawn([cmd, ...args], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
        });
    } catch {
        // Fall through with an empty handle below.
    }
    if (proc === null) {
        return {
            stderr: (async function* () {})(),
            exit: Promise.resolve(null),
            kill: () => {},
        };
    }
    const child = proc;
    const decoder = new TextDecoder();
    async function* lines(): AsyncIterable<string> {
        let buffer = "";
        const reader = child.stderr.getReader();
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                // curl uses both \n and \r (carriage return overprint) to
                // refresh the progress line. Split on either.
                const parts = buffer.split(/[\r\n]/);
                buffer = parts.pop() ?? "";
                for (const part of parts) {
                    if (part.length > 0) yield part;
                }
            }
            if (buffer.length > 0) yield buffer;
        } finally {
            reader.releaseLock();
        }
    }
    return {
        stderr: lines(),
        exit: child.exited.then((code) => (typeof code === "number" ? code : null)),
        kill: () => {
            try {
                child.kill();
            } catch {
                // Already exited.
            }
        },
    };
}

export interface DownloadOptions {
    readonly spawnFn?: SpawnStreamFn;
    /** Called whenever curl reports a new integer percent value. */
    readonly onProgress?: (percent: number) => void | Promise<void>;
    /**
     * Throttle the per-percent callback to at most one call per N points
     * (default 5) so we don't flood the chat with 100 messages. The first
     * and last percent always fire.
     */
    readonly progressStepPercent?: number;
}

export interface DownloadResult {
    readonly status: "ok" | "spawn-failed" | "curl-failed";
    readonly destPath: string;
    readonly exitCode: number | null;
    readonly lastStderr: string;
}

/**
 * Download a single GGUF to `destPath`, streaming curl's stderr to
 * `onProgress`. Writes to `<destPath>.part` then renames into place on
 * success — partial downloads don't shadow real files.
 */
export async function downloadGguf(
    url: string,
    destPath: string,
    options: DownloadOptions = {},
): Promise<DownloadResult> {
    await mkdir(dirname(destPath), { recursive: true });
    const partPath = `${destPath}.part`;
    const spawnFn = options.spawnFn ?? defaultSpawn;
    const step = options.progressStepPercent ?? 5;

    const handle = spawnFn("curl", ["-fL", "--progress-bar", url, "-o", partPath]);

    let lastReportedPercent = -1;
    let lastStderr = "";
    let sawProgressLine = false;
    for await (const line of handle.stderr) {
        lastStderr = line;
        const percent = parseCurlPercent(line);
        if (percent === null) continue;
        sawProgressLine = true;
        if (
            percent === 0 ||
            percent === 100 ||
            percent - lastReportedPercent >= step
        ) {
            lastReportedPercent = percent;
            if (options.onProgress !== undefined) {
                await options.onProgress(percent);
            }
        }
    }
    const exitCode = await handle.exit;

    if (exitCode === null && !sawProgressLine && lastStderr === "") {
        return {
            status: "spawn-failed",
            destPath,
            exitCode,
            lastStderr,
        };
    }
    if (exitCode !== 0) {
        return { status: "curl-failed", destPath, exitCode, lastStderr };
    }
    // Move the .part file to its final destination.
    await rename(partPath, destPath);
    return { status: "ok", destPath, exitCode, lastStderr };
}

/** Format `path = "<abs>"` into the tiny active-model TOML file. */
export function buildActiveModelToml(absPath: string): string {
    // TOML: strings are double-quoted with backslash escaping for `"` and
    // `\`. Catalog paths are ASCII filenames under our control, but
    // escape defensively anyway.
    const escaped = absPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `path = "${escaped}"\n`;
}

/**
 * Resolve which model to download. If `userText` names a model, use it.
 * Otherwise fall back to the recommended tier for this host's RAM (with
 * a final fallback to `mid-7b` when /proc/meminfo can't be read).
 */
function resolveTargetModel(userText: string): {
    model: CatalogModel;
    reason: "requested" | "recommended" | "fallback";
} {
    const requested = resolveRequestedModel(userText);
    if (requested !== null) return { model: requested, reason: "requested" };
    try {
        const pick = recommendModelTier();
        return { model: pick.recommended, reason: "recommended" };
    } catch {
        // Hosts without /proc/meminfo (containers, mocked filesystems):
        // pick the mid-tier as a sensible "bigger than the bundled 1B".
        const fallback = MODEL_CATALOG.find((m) => m.id === "mid-7b");
        if (fallback === undefined) {
            // catalog mis-shape — re-throw via the next caller.
            throw new Error("catalog missing mid-7b fallback");
        }
        return { model: fallback, reason: "fallback" };
    }
}

interface DownloadRuntimeOptions {
    spawnFn?: SpawnStreamFn;
    progressStepPercent?: number;
    /** Test hook — when set, skips writing to disk and just returns. */
    skipPersist?: boolean;
}

function readDownloadOptions(options: unknown): DownloadRuntimeOptions {
    if (typeof options !== "object" || options === null) return {};
    const o = options as Record<string, unknown>;
    const out: DownloadRuntimeOptions = {};
    if (typeof o.spawnFn === "function") out.spawnFn = o.spawnFn as SpawnStreamFn;
    if (typeof o.progressStepPercent === "number") {
        out.progressStepPercent = o.progressStepPercent;
    }
    if (typeof o.skipPersist === "boolean") out.skipPersist = o.skipPersist;
    return out;
}

interface RestartableRuntime extends IAgentRuntime {
    restartAgent?: () => Promise<void> | void;
}

const EXAMPLES: ActionExample[][] = [
    [
        { name: "{{user}}", content: { text: "download a model" } },
        {
            name: "Eliza",
            content: {
                text: "Downloading Qwen3.5 9B DFlash (5.8 GB). I'll keep you posted.",
            },
        },
    ],
    [
        { name: "{{user}}", content: { text: "download qwen 7b" } },
        {
            name: "Eliza",
            content: { text: "Downloading Qwen2.5 7B Instruct (4.7 GB)." },
        },
    ],
    [
        { name: "{{user}}", content: { text: "give me a bigger model" } },
        {
            name: "Eliza",
            content: {
                text:
                    "Downloaded Qwen3.5 9B DFlash (5.8 GB). I'll load it on the next restart.",
            },
        },
    ],
];

export const DOWNLOAD_MODEL_ACTION: Action = {
    name: "DOWNLOAD_MODEL",
    similes: [
        "download a model",
        "get a better model",
        "download qwen",
        "download llama",
        "download model",
        "install model",
        "install llama",
        "give me a bigger model",
        "switch to a bigger model",
        "switch model",
        "upgrade my model",
        "upgrade model",
        "pull a model",
        "install a model",
    ],
    description:
        "Download a larger local LLM from HuggingFace and pin it as the default. " +
        "Used when the user says 'download a model', 'get a better model', " +
        "'download qwen 7b', 'give me a bigger model', etc.",

    validate: async () => true,

    handler: async (runtime, message, _state, options, callback) => {
        const userText =
            typeof message.content?.text === "string" ? message.content.text : "";
        const opts = readDownloadOptions(options);

        let target: { model: CatalogModel; reason: "requested" | "recommended" | "fallback" };
        try {
            target = resolveTargetModel(userText);
        } catch (err) {
            const text = `I couldn't pick a model to download: ${(err as Error).message}.`;
            if (callback) await callback({ text, actions: ["DOWNLOAD_MODEL"] });
            return { success: false, text };
        }
        const { model } = target;

        const url = buildHuggingFaceResolveUrl(model);
        const destPath = join(modelsDir(), model.ggufFile);

        if (existsSync(destPath) && opts.skipPersist !== true) {
            // Already downloaded — just pin it.
            await mkdir(dirname(activeModelTomlPath()), { recursive: true });
            await writeFile(activeModelTomlPath(), buildActiveModelToml(destPath));
            const text =
                `You already have ${model.displayName} on disk. Pinned it as the default — ` +
                "I'll load it on the next restart.";
            if (callback) await callback({ text, actions: ["DOWNLOAD_MODEL"] });
            return {
                success: true,
                text,
                data: { actionName: "DOWNLOAD_MODEL", modelId: model.id, destPath },
            };
        }

        const startText = `Downloading ${model.displayName} (${model.sizeGb.toFixed(1)} GB).`;
        if (callback) await callback({ text: startText, actions: ["DOWNLOAD_MODEL"] });

        const downloadOpts: DownloadOptions = {
            ...(opts.spawnFn !== undefined ? { spawnFn: opts.spawnFn } : {}),
            ...(opts.progressStepPercent !== undefined
                ? { progressStepPercent: opts.progressStepPercent }
                : {}),
            onProgress: async (percent) => {
                if (callback) {
                    await callback({
                        text: `Downloading ${model.displayName} — ${percent}%`,
                        actions: ["DOWNLOAD_MODEL"],
                    });
                }
            },
        };

        const result = await downloadGguf(url, destPath, downloadOpts);
        if (result.status !== "ok") {
            const detail =
                result.lastStderr.trim().length > 0
                    ? ` (curl: "${result.lastStderr.trim().slice(0, 160)}")`
                    : "";
            const text =
                `I couldn't download ${model.displayName}${detail}. ` +
                "Check your network with 'am i online' and try again.";
            if (callback) await callback({ text, actions: ["DOWNLOAD_MODEL"] });
            return {
                success: false,
                text,
                data: { actionName: "DOWNLOAD_MODEL", status: result.status },
            };
        }

        // Pin as the default.
        if (opts.skipPersist !== true) {
            await mkdir(dirname(activeModelTomlPath()), { recursive: true });
            await writeFile(activeModelTomlPath(), buildActiveModelToml(destPath));
        }

        // Best-effort runtime reload — the runtime may not implement
        // restartAgent. We don't await reliably because the call might
        // tear down our own process; log and move on.
        const r = runtime as RestartableRuntime;
        if (typeof r.restartAgent === "function") {
            try {
                await r.restartAgent();
            } catch {
                // Restart hook is best-effort; the next manual restart picks
                // up active-model.toml regardless.
            }
        }

        const text =
            `Downloaded ${model.displayName} (${model.sizeGb.toFixed(1)} GB). ` +
            "Restarting my local model now.";
        if (callback) await callback({ text, actions: ["DOWNLOAD_MODEL"] });
        return {
            success: true,
            text,
            data: {
                actionName: "DOWNLOAD_MODEL",
                modelId: model.id,
                destPath,
                activeModelToml: activeModelTomlPath(),
            },
        };
    },

    examples: EXAMPLES,
};
