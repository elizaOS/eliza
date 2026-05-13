// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * DOWNLOAD_MODEL unit tests.
 *
 * The handler shells out to curl. We mock the spawn boundary so the
 * tests don't actually pull GGUFs over the network. The temp HOME +
 * USBELIZA_MODELS_DIR pin where the .part / .gguf files would land if
 * the (fake) curl actually produced them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IAgentRuntime, Memory } from "@elizaos/core";

import {
    DOWNLOAD_MODEL_ACTION,
    activeModelTomlPath,
    buildActiveModelToml,
    downloadGguf,
    modelsDir,
    parseCurlPercent,
    resolveRequestedModel,
    type SpawnStream,
    type SpawnStreamFn,
} from "../src/runtime/actions/download-model.ts";
import { matchAction } from "../src/runtime/match.ts";
import { USBELIZA_ACTIONS } from "../src/runtime/plugin.ts";

const fakeRuntime = {} as unknown as IAgentRuntime;
const memoryOf = (text: string) =>
    ({ content: { text } } as unknown as Memory);

const originalHome = process.env.HOME;
const originalModelsDir = process.env.USBELIZA_MODELS_DIR;
const originalActiveToml = process.env.USBELIZA_ACTIVE_MODEL_TOML;

let tempRoot = "";

beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "usbeliza-dl-"));
    process.env.HOME = tempRoot;
    process.env.USBELIZA_MODELS_DIR = join(tempRoot, "models");
    process.env.USBELIZA_ACTIVE_MODEL_TOML = join(tempRoot, "active-model.toml");
});

afterEach(() => {
    if (tempRoot !== "") {
        rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = "";
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalModelsDir === undefined) delete process.env.USBELIZA_MODELS_DIR;
    else process.env.USBELIZA_MODELS_DIR = originalModelsDir;
    if (originalActiveToml === undefined) delete process.env.USBELIZA_ACTIVE_MODEL_TOML;
    else process.env.USBELIZA_ACTIVE_MODEL_TOML = originalActiveToml;
});

/**
 * Build a fake spawn that emits the given progress percentages as
 * curl-like progress lines, optionally writes the destination file, and
 * exits with the chosen code.
 */
function buildSpawn(opts: {
    percentages: number[];
    exitCode?: number;
    /** Write a 0-byte placeholder at the `-o` argument path. */
    createPartFile?: boolean;
}): SpawnStreamFn {
    return (_cmd, args) => {
        // Find the -o <path> argument so we can drop a .part file there
        // when requested.
        const oIdx = args.indexOf("-o");
        const partPath = oIdx >= 0 ? args[oIdx + 1] : undefined;

        async function* lines(): AsyncIterable<string> {
            for (const p of opts.percentages) {
                yield `${p} 1234M 5 100M 0 0 1M 0 0:00:10 0:00:01 0:00:09 1M`;
            }
            if (opts.createPartFile === true && partPath !== undefined) {
                // mkdir + touch the part file so the action's rename() works.
                await mkdir(dirname(partPath), { recursive: true });
                writeFileSync(partPath, "fake gguf bytes");
            }
        }
        const stream: SpawnStream = {
            stderr: lines(),
            exit: Promise.resolve(opts.exitCode ?? 0),
            kill: () => {},
        };
        return stream;
    };
}

describe("parseCurlPercent", () => {
    test("returns the leading percent from a progress row", () => {
        expect(parseCurlPercent("  3 4760M  3  166M  0 0  73.2M 0 0:01:04")).toBe(3);
        expect(parseCurlPercent("100 4760M 100 4760M 0 0  90M 0 --:--:--")).toBe(100);
    });

    test("returns null for non-numeric / out-of-range lines", () => {
        expect(parseCurlPercent("Downloading...")).toBeNull();
        expect(parseCurlPercent("")).toBeNull();
        expect(parseCurlPercent("200 too high")).toBeNull();
    });
});

describe("resolveRequestedModel", () => {
    test("matches 'download qwen 7b' to Qwen2.5 7B Instruct", () => {
        const m = resolveRequestedModel("download qwen 7b");
        expect(m?.id).toBe("mid-7b");
    });

    test("matches 'pull llama 3.2 1b' to Llama-3.2 1B", () => {
        const m = resolveRequestedModel("pull llama 3.2 1b");
        expect(m?.id).toBe("tiny-1b");
    });

    test("returns null when no model words match", () => {
        // The catalog tokens are model names; without overlap we get
        // null and the caller falls back to recommendModelTier.
        expect(resolveRequestedModel("download a model")).toBeNull();
        expect(resolveRequestedModel("get me a bigger model")).toBeNull();
    });
});

describe("buildActiveModelToml", () => {
    test("emits `path = \"<abs>\"` newline", () => {
        const toml = buildActiveModelToml("/home/eliza/.eliza/models/qwen.gguf");
        expect(toml).toBe('path = "/home/eliza/.eliza/models/qwen.gguf"\n');
    });

    test("escapes embedded quotes and backslashes", () => {
        const toml = buildActiveModelToml('/tmp/"weird"\\path');
        expect(toml).toBe('path = "/tmp/\\"weird\\"\\\\path"\n');
    });
});

describe("modelsDir / activeModelTomlPath honour env", () => {
    test("USBELIZA_MODELS_DIR wins", () => {
        expect(modelsDir()).toBe(join(tempRoot, "models"));
    });

    test("USBELIZA_ACTIVE_MODEL_TOML wins", () => {
        expect(activeModelTomlPath()).toBe(join(tempRoot, "active-model.toml"));
    });
});

describe("downloadGguf", () => {
    test("streams progress and renames .part to final on success", async () => {
        const dest = join(tempRoot, "models", "out.gguf");
        const seen: number[] = [];
        const result = await downloadGguf("https://example/x.gguf", dest, {
            spawnFn: buildSpawn({
                percentages: [0, 5, 50, 100],
                createPartFile: true,
            }),
            progressStepPercent: 1,
            onProgress: (p) => {
                seen.push(p);
            },
        });
        expect(result.status).toBe("ok");
        expect(seen).toEqual([0, 5, 50, 100]);
        expect(existsSync(dest)).toBe(true);
        expect(existsSync(`${dest}.part`)).toBe(false);
    });

    test("returns curl-failed when curl exits non-zero", async () => {
        const dest = join(tempRoot, "models", "out.gguf");
        const result = await downloadGguf("https://example/x.gguf", dest, {
            spawnFn: buildSpawn({ percentages: [0], exitCode: 22, createPartFile: false }),
        });
        expect(result.status).toBe("curl-failed");
        expect(result.exitCode).toBe(22);
        expect(existsSync(dest)).toBe(false);
    });

    test("throttles progress callbacks by progressStepPercent", async () => {
        const dest = join(tempRoot, "models", "out.gguf");
        const seen: number[] = [];
        await downloadGguf("https://example/x.gguf", dest, {
            spawnFn: buildSpawn({
                percentages: [0, 1, 2, 3, 4, 5, 50, 100],
                createPartFile: true,
            }),
            progressStepPercent: 5,
            onProgress: (p) => {
                seen.push(p);
            },
        });
        // First (0) and last (100) always fire; middle bumps gated by step.
        expect(seen[0]).toBe(0);
        expect(seen[seen.length - 1]).toBe(100);
        // 1..4 should NOT all have fired (step=5) — at most one more
        // between 0 and 50.
        expect(seen.length).toBeLessThanOrEqual(5);
    });
});

describe("DOWNLOAD_MODEL handler", () => {
    test("successful happy path writes active-model.toml and confirms", async () => {
        const spawnFn = buildSpawn({ percentages: [0, 100], createPartFile: true });
        const captured: string[] = [];
        const result = await DOWNLOAD_MODEL_ACTION.handler(
            fakeRuntime,
            memoryOf("download qwen 7b"),
            undefined,
            { spawnFn },
            async (response) => {
                if (typeof response.text === "string") captured.push(response.text);
                return [];
            },
        );

        expect(result?.success).toBe(true);
        expect(result?.text).toMatch(/Downloaded Qwen2\.5 7B Instruct/);
        // active-model.toml should point at the new gguf.
        const toml = readFileSync(activeModelTomlPath(), "utf8");
        expect(toml).toContain("Qwen2.5-7B-Instruct-Q4_K_M.gguf");
        // Progress callback fired at least once.
        expect(captured.some((t) => t.includes("Downloading"))).toBe(true);
    });

    test("curl failure surfaces a network-shaped error", async () => {
        const spawnFn = buildSpawn({ percentages: [], exitCode: 6 });
        const result = await DOWNLOAD_MODEL_ACTION.handler(
            fakeRuntime,
            memoryOf("download qwen 7b"),
            undefined,
            { spawnFn },
        );
        expect(result?.success).toBe(false);
        expect(result?.text).toContain("couldn't download");
        // No active-model.toml on failure.
        expect(existsSync(activeModelTomlPath())).toBe(false);
    });

    test("already-on-disk path re-pins without re-downloading", async () => {
        // Pre-create the destination GGUF.
        const dest = join(tempRoot, "models", "Qwen2.5-7B-Instruct-Q4_K_M.gguf");
        await mkdir(dirname(dest), { recursive: true });
        writeFileSync(dest, "already here");

        let spawned = false;
        const spawnFn: SpawnStreamFn = () => {
            spawned = true;
            return {
                stderr: (async function* () {})(),
                exit: Promise.resolve(0),
                kill: () => {},
            };
        };

        const result = await DOWNLOAD_MODEL_ACTION.handler(
            fakeRuntime,
            memoryOf("download qwen 7b"),
            undefined,
            { spawnFn },
        );
        expect(result?.success).toBe(true);
        expect(result?.text).toContain("already have");
        expect(spawned).toBe(false);
        // Still pinned.
        expect(readFileSync(activeModelTomlPath(), "utf8")).toContain(
            "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        );
    });
});

describe("Action selection (similes)", () => {
    test("'download a model' picks DOWNLOAD_MODEL", () => {
        const m = matchAction("download a model", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("DOWNLOAD_MODEL");
    });

    test("'upgrade my model' picks DOWNLOAD_MODEL", () => {
        const m = matchAction("upgrade my model", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("DOWNLOAD_MODEL");
    });

    test("'list models' still picks LIST_MODELS, not DOWNLOAD_MODEL", () => {
        const m = matchAction("list models", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("LIST_MODELS");
    });

    test("'download qwen' picks DOWNLOAD_MODEL", () => {
        const m = matchAction("download qwen", USBELIZA_ACTIONS);
        expect(m?.action.name).toBe("DOWNLOAD_MODEL");
    });
});
