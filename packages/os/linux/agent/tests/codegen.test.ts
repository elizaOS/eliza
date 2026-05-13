// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

import {
    __test,
    type GenerationBrief,
    generateApp,
    CodegenError,
} from "../src/plugins/usbeliza-codegen/actions/generate-app.ts";

const { runClaudeArgs, secureJoin, isSafeSlug, validateOutput } = __test;

/** Build a fake child-process that stdouts a fixed string then exits cleanly.
 *
 * The mock emits the data + close events on the next process tick so that
 * the test code (in `runClaude`) has a chance to attach its `on('data')` and
 * `on('close')` listeners before the events fire. Using EventEmitter (not
 * Readable) for the stdout pipe keeps the timing deterministic.
 */
function fakeSpawn(stdoutText: string, code = 0) {
    return ((_cmd: string, _args: string[]) => {
        const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        // The downstream code calls `child.stdout?.on(...)` which works on the
        // EventEmitter shape; the real ChildProcess.stdout has more methods,
        // but they're not exercised by the production code.
        Object.assign(proc, { stdout, stderr });
        process.nextTick(() => {
            stdout.emit("data", Buffer.from(stdoutText, "utf8"));
            (proc as unknown as EventEmitter).emit("close", code);
        });
        return proc;
    }) as unknown as typeof import("node:child_process").spawn;
}

const SAMPLE_OUTPUT = JSON.stringify({
    type: "result",
    result: JSON.stringify({
        manifest: {
            schema_version: 1,
            slug: "calendar",
            title: "Calendar",
            intent: "show me my calendar",
            runtime: "webview",
            entry: "src/index.html",
            capabilities: [
                { kind: "time:read" },
                { kind: "storage:scoped" },
            ],
            version: 1,
            last_built_by: "claude-code-test",
            last_built_at: "2026-05-10T10:00:00Z",
        },
        files: {
            "src/index.html": "<!doctype html><title>Calendar</title>",
        },
    }),
});

describe("isSafeSlug", () => {
    test("accepts canonical slugs", () => {
        expect(isSafeSlug("calendar")).toBe(true);
        expect(isSafeSlug("text-editor")).toBe(true);
        expect(isSafeSlug("app42")).toBe(true);
    });

    test("rejects unsafe slugs", () => {
        expect(isSafeSlug("")).toBe(false);
        expect(isSafeSlug("Calendar")).toBe(false);
        expect(isSafeSlug("../etc")).toBe(false);
        expect(isSafeSlug("my_app")).toBe(false);
        expect(isSafeSlug("-leading-dash")).toBe(false);
    });
});

describe("secureJoin", () => {
    test("joins safe relative paths", () => {
        expect(secureJoin("/tmp/app", "src/index.html")).toBe(
            "/tmp/app/src/index.html",
        );
    });

    test("rejects path traversal", () => {
        expect(() => secureJoin("/tmp/app", "../../etc/passwd")).toThrow(
            CodegenError,
        );
    });

    test("rejects absolute paths", () => {
        expect(() => secureJoin("/tmp/app", "/etc/passwd")).toThrow(CodegenError);
    });
});

describe("validateOutput", () => {
    test("accepts a well-formed output", () => {
        expect(() =>
            validateOutput(
                {
                    manifest: {
                        schema_version: 1,
                        slug: "calendar",
                        entry: "src/index.html",
                    },
                    files: { "src/index.html": "ok" },
                },
                "calendar",
            ),
        ).not.toThrow();
    });

    test("rejects mismatched slug", () => {
        expect(() =>
            validateOutput(
                {
                    manifest: { schema_version: 1, slug: "notes", entry: "src/index.html" },
                    files: { "src/index.html": "ok" },
                },
                "calendar",
            ),
        ).toThrow(/slug/);
    });

    test("rejects entry not present in files", () => {
        expect(() =>
            validateOutput(
                {
                    manifest: { schema_version: 1, slug: "calendar", entry: "src/missing.html" },
                    files: { "src/index.html": "ok" },
                },
                "calendar",
            ),
        ).toThrow(/entry/);
    });

    test("rejects path traversal in files", () => {
        expect(() =>
            validateOutput(
                {
                    manifest: { schema_version: 1, slug: "calendar", entry: "src/index.html" },
                    files: { "src/index.html": "ok", "../etc/passwd": "evil" },
                },
                "calendar",
            ),
        ).toThrow(/escapes/);
    });
});

describe("runClaudeArgs", () => {
    test("includes --print, --output-format json, --json-schema, --system-prompt, --dangerously-skip-permissions", () => {
        const args = runClaudeArgs({
            slug: "calendar",
            intent: "show me my calendar",
            calibration: null,
        });
        expect(args).toContain("--print");
        expect(args).toContain("--output-format");
        expect(args).toContain("json");
        expect(args).toContain("--json-schema");
        expect(args).toContain("--system-prompt");
        expect(args).toContain("--dangerously-skip-permissions");
    });
});

describe("generateApp", () => {
    test("writes manifest.json + files to disk and returns paths", async () => {
        const root = mkdtempSync(join(tmpdir(), "usbeliza-codegen-"));
        try {
            const brief: GenerationBrief = {
                slug: "calendar",
                intent: "show me my calendar",
                calibration: null,
                appsRoot: root,
                spawnFn: fakeSpawn(SAMPLE_OUTPUT),
            };
            const result = await generateApp(brief);
            expect(result.slug).toBe("calendar");
            expect(result.manifestPath).toBe(join(root, "calendar/manifest.json"));
            expect(result.backend).toBe("claude");

            const manifest = JSON.parse(
                readFileSync(result.manifestPath, "utf8"),
            ) as { slug: string; entry: string };
            expect(manifest.slug).toBe("calendar");
            expect(manifest.entry).toBe("src/index.html");

            const indexHtml = readFileSync(
                join(root, "calendar/src/index.html"),
                "utf8",
            );
            expect(indexHtml).toContain("Calendar");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("rejects invalid slug before spawning anything", async () => {
        const brief: GenerationBrief = {
            slug: "../bad",
            intent: "x",
            calibration: null,
            spawnFn: fakeSpawn("never reached"),
        };
        await expect(generateApp(brief)).rejects.toThrow(CodegenError);
    });
});

/** Build a fake spawn that returns invalid JSON N times then a valid output. */
function flakySpawn(failures: number, validOutput: string) {
    let attempt = 0;
    return ((_cmd: string, _args: string[]) => {
        const proc = new EventEmitter() as ChildProcessWithoutNullStreams;
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        Object.assign(proc, { stdout, stderr });
        const willFail = attempt < failures;
        attempt += 1;
        const payload = willFail
            ? JSON.stringify({
                  type: "result",
                  is_error: false,
                  result: "this is not valid JSON {{{",
              })
            : validOutput;
        process.nextTick(() => {
            stdout.emit("data", Buffer.from(payload, "utf8"));
            (proc as unknown as EventEmitter).emit("close", 0);
        });
        return proc;
    }) as unknown as typeof import("node:child_process").spawn;
}

describe("generateApp critique-loop convergence", () => {
    test("succeeds on the third attempt when the first two parse-fail", async () => {
        const root = mkdtempSync(join(tmpdir(), "usbeliza-codegen-flaky-"));
        try {
            const brief: GenerationBrief = {
                slug: "calendar",
                intent: "show me my calendar",
                calibration: null,
                appsRoot: root,
                spawnFn: flakySpawn(2, SAMPLE_OUTPUT),
            };
            const result = await generateApp(brief);
            expect(result.slug).toBe("calendar");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("gives up after MAX_AUTO_RETRIES (=2) parse failures", async () => {
        const root = mkdtempSync(join(tmpdir(), "usbeliza-codegen-giveup-"));
        try {
            // Three failures means: first attempt + 2 retries = 3 attempts,
            // all parse-fail. generateApp must surrender, not loop forever.
            const brief: GenerationBrief = {
                slug: "calendar",
                intent: "show me my calendar",
                calibration: null,
                appsRoot: root,
                spawnFn: flakySpawn(3, SAMPLE_OUTPUT),
            };
            try {
                await generateApp(brief);
                throw new Error("expected throw");
            } catch (err) {
                expect(err).toBeInstanceOf(CodegenError);
                expect((err as CodegenError).stage).toBe("parse");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
