// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * `generate-app` action.
 *
 * Takes a brief, spawns `claude --print --output-format json --json-schema=...`
 * with our system prompt + user prompt, parses the structured output, writes
 * `manifest.json` + every file in `files` to `~/.eliza/apps/<slug>/`, and
 * returns a `GenerationOutput` describing the on-disk paths.
 *
 * Phase 0 ships only the `claude` backend (locked decision: provider
 * portability lives at the trait/interface boundary; Phase 1 adds `codex`,
 * Phase 1.5 adds the managed-proxy).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";

import type { CalibrationBlock } from "../../../persona.ts";
import {
    type CodegenOutput,
    CODEGEN_OUTPUT_SCHEMA,
} from "../schemas.ts";
import { buildSystemPrompt, buildUserPrompt } from "../prompts.ts";
import { listVersions, promoteVersion } from "./app-history.ts";

/** Available code generation backends. Phase 0 = `claude` only. */
export type CodeGeneratorBackend = "claude" | "codex" | "local-llama" | "managed-proxy";

export interface GenerationBrief {
    slug: string;
    intent: string;
    existingSrc?: Record<string, string>;
    calibration: CalibrationBlock | null;
    /** Override the apps root (defaults to `~/.eliza/apps`). For tests. */
    appsRoot?: string;
    /** Override the spawn function. For tests; not part of the public API. */
    spawnFn?: typeof spawn;
    /** Internal retry-loop critique passed back into the prompt. Not for callers. */
    critique?: string;
}

export interface GenerationOutput {
    slug: string;
    manifestPath: string;
    srcPath: string;
    backend: CodeGeneratorBackend;
}

export class CodegenError extends Error {
    public readonly stage: "spawn" | "parse" | "validate" | "write";

    constructor(
        message: string,
        stage: "spawn" | "parse" | "validate" | "write",
        cause?: unknown,
    ) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "CodegenError";
        this.stage = stage;
    }
}

const APPS_ROOT_DEFAULT = (() => {
    const explicit = Bun.env.USBELIZA_APPS_ROOT;
    if (explicit !== undefined && explicit !== "") {
        return explicit;
    }
    const home = Bun.env.HOME ?? "/tmp";
    return join(home, ".eliza/apps");
})();

const CLAUDE_BIN = Bun.env.USBELIZA_CLAUDE_BIN ?? "claude";

/** Builder identifier embedded in `manifest.last_built_by`. */
const BUILDER_ID = `claude-code-${Bun.env.USBELIZA_CLAUDE_VERSION ?? "unknown"}`;

/**
 * Cheap "can we actually invoke real codegen right now" check. Returns
 * false when the claude binary is missing OR no auth marker exists.
 * On false, `generateApp` falls back to the stub instead of paying a
 * 30s spawn that's guaranteed to fail. Tests inject a `spawnFn` and
 * bypass this check (we assume their environment is configured).
 */
function claudeIsAvailable(spawnFn?: typeof spawn): boolean {
    if (spawnFn !== undefined) return true; // test path — trust the caller
    if (!claudeBinaryPresent()) return false;
    const home = Bun.env.HOME ?? "/tmp";
    if (existsSync(join(home, ".eliza/auth/claude.json"))) return true;
    if (existsSync(join(home, ".eliza/auth/codex.json"))) return true;
    return false;
}

function claudeBinaryPresent(): boolean {
    const explicit = Bun.env.USBELIZA_CLAUDE_BIN;
    if (explicit !== undefined && existsSync(explicit)) return true;
    for (const p of ["/usr/local/bin/claude", "/usr/bin/claude"]) {
        if (existsSync(p)) return true;
    }
    return false;
}

/** Maximum number of automatic retries per `generateApp` call. Locked
 *  decision #16: bounded at 2. After that, the caller surfaces the version
 *  picker / "couldn't build this" message. */
export const MAX_AUTO_RETRIES = 2;

export async function generateApp(brief: GenerationBrief): Promise<GenerationOutput> {
    const appsRoot = brief.appsRoot ?? APPS_ROOT_DEFAULT;
    const appDir = join(appsRoot, brief.slug);

    if (!isSafeSlug(brief.slug)) {
        throw new CodegenError(`invalid slug: ${brief.slug}`, "validate");
    }

    // Codegen mode resolution:
    //   1. `USBELIZA_CODEGEN_STUB=1` forces the stub — for unit tests + the
    //      smoke harness so orchestration (intent → manifest → launcher →
    //      window) verifies without baking Anthropic credentials.
    //   2. Otherwise, real claude codegen — gated on the claude marker so
    //      the user isn't surprised by a 30s spawn that fails because
    //      they haven't signed in. Returns stub with `last_built_by:
    //      stub-fallback` when claude isn't available (graceful degrade
    //      instead of error: a first-boot user gets an instant placeholder
    //      they can replace once they sign into Claude).
    if (Bun.env.USBELIZA_CODEGEN_STUB === "1") {
        return await runStubCodegen(brief, appDir);
    }
    if (!claudeIsAvailable(brief.spawnFn)) {
        return await runStubCodegen(brief, appDir);
    }

    let lastError: CodegenError | undefined;
    let critique: string | undefined;

    // Read the version number of the current installed app (if any) so we
    // can archive it under the right `.history/v<N>/` directory on the
    // atomic swap. First-time builds default to 0.
    const oldVersion = await readCurrentVersion(appDir);

    // Attempt N = first try + MAX_AUTO_RETRIES retries (PLAN.md #16:
    // bounded at 2). On every failure the next attempt's brief carries
    // a `critique` field naming the prior failure so claude can fix it.
    for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
        try {
            const parsed = await runClaude(
                { ...brief, ...(critique !== undefined ? { critique } : {}) },
                brief.spawnFn ?? spawn,
            );
            validateOutput(parsed, brief.slug);

            // Atomic-swap layout (PLAN.md locked decision #16):
            // write to `src.next/` + `manifest.next.json`, then call
            // promoteVersion() which renames the old src/ aside into
            // `.history/v<old>/` and the new tree into place.
            await mkdir(appDir, { recursive: true });
            await writeStaged(appDir, parsed);
            await promoteVersion(appDir, oldVersion);

            return {
                slug: brief.slug,
                manifestPath: join(appDir, "manifest.json"),
                srcPath: join(appDir, "src"),
                backend: "claude",
            };
        } catch (err) {
            lastError = err as CodegenError;
            // Clean up any partial src.next/ from this failed attempt so
            // the next try starts from a sane filesystem state.
            await rm(join(appDir, "src.next"), { recursive: true, force: true });
            await rm(join(appDir, "manifest.next.json"), { force: true });

            // Only retry on parse/validate failures — spawn / write failures
            // mean the environment is broken and retrying won't help.
            if (
                lastError.stage !== "parse" &&
                lastError.stage !== "validate"
            ) {
                throw lastError;
            }
            critique = `Your previous attempt failed at the ${lastError.stage} stage: ${lastError.message}. Try again, taking the constraint seriously this time.`;
        }
    }

    // Exhausted retries — caller can call listVersions(appDir) to surface
    // a "want to roll back to the version from Thursday?" picker.
    const history = await listVersions(appDir);
    const e =
        lastError ??
        new CodegenError(
            `generateApp exhausted ${MAX_AUTO_RETRIES + 1} attempts with no error captured`,
            "validate",
        );
    if (history.length > 0) {
        // Attach the history hint so dispatch.ts can render a chat reply
        // like "I couldn't build this one — want to roll back to your
        // version from Thursday?". The thrown error still surfaces the
        // root cause for diagnostics.
        (e as CodegenError & { rollbackOptions?: typeof history }).rollbackOptions =
            history;
    }
    throw e;
}

/**
 * Read the current installed manifest's `version` field. Used as the
 * slot number when archiving the soon-to-be-replaced src tree under
 * `.history/v<N>/`. Returns 0 if the app doesn't exist yet.
 */
async function readCurrentVersion(appDir: string): Promise<number> {
    const manifestPath = join(appDir, "manifest.json");
    try {
        const raw = await readFile(manifestPath, "utf8");
        const parsed = JSON.parse(raw) as { version?: number };
        return typeof parsed.version === "number" ? parsed.version : 0;
    } catch {
        return 0;
    }
}

/**
 * Write the new manifest + files to `<appDir>/src.next/` (and
 * `manifest.next.json`). The atomic rename happens in promoteVersion().
 * Caller has already validated `parsed` against the schema.
 */
async function writeStaged(appDir: string, parsed: CodegenOutput): Promise<void> {
    await writeFile(
        join(appDir, "manifest.next.json"),
        JSON.stringify(parsed.manifest, null, 4),
    );
    const stagingRoot = join(appDir, "src.next");
    // Strip a leading "src/" off the file paths so they end up under
    // src.next/ instead of src.next/src/. The codegen output uses paths
    // relative to the app root (e.g. "src/index.html") because that's
    // what claude is told to emit — we re-root them here.
    for (const [relPath, contents] of Object.entries(parsed.files)) {
        const rerooted = relPath.startsWith("src/")
            ? relPath.slice(4)
            : relPath;
        const target = secureJoin(stagingRoot, rerooted);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, contents);
    }
}

export const __test = {
    runClaudeArgs,
    secureJoin,
    isSafeSlug,
    validateOutput,
};

/**
 * Deterministic stub codegen — used by the VM smoke harness to verify the
 * full orchestration chain (intent dispatch → codegen → manifest → launcher
 * → bubblewrap → window) without requiring `claude` / Anthropic credentials
 * inside the qcow2. Produces a tiny self-contained HTML page that displays
 * the slug + a clock so the screenshot proves the right window opened.
 *
 * Activated by the `USBELIZA_CODEGEN_STUB=1` env var; off by default. The
 * real path is exercised on the host (already verified end-to-end with the
 * actual `claude --print --output-format json --json-schema=…` flow) and
 * by `codegen.test.ts`'s mocked-spawn coverage.
 */
async function runStubCodegen(
    brief: GenerationBrief,
    appDir: string,
): Promise<GenerationOutput> {
    const now = new Date().toISOString();
    const title = brief.slug.replace(/-/g, " ").replace(/\b\w/g, (c) =>
        c.toUpperCase(),
    );
    const manifest = {
        schema_version: 1 as const,
        slug: brief.slug,
        title,
        intent: brief.intent,
        runtime: "webview" as const,
        entry: "src/index.html",
        capabilities: [{ kind: "time:read" }, { kind: "storage:scoped" }],
        version: 1,
        last_built_by: "usbeliza-codegen-stub",
        last_built_at: now,
    };
    const html = `\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; height: 100vh;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: #0a0a0a; color: #f2f2f2;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  h1 { font-size: 2.5rem; margin: 0 0 .5rem; }
  .meta { color: #888; font-size: .9rem; }
  .clock { margin-top: 2rem; font-size: 3rem; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<h1>${title}</h1>
<div class="meta">${brief.slug} · stub · ${now}</div>
<div class="clock" id="c"></div>
<script>
  const c = document.getElementById("c");
  function tick(){ c.textContent = new Date().toLocaleTimeString(); }
  tick(); setInterval(tick, 1000);
</script>
</body>
</html>
`;
    await mkdir(appDir, { recursive: true });
    await writeFile(
        join(appDir, "manifest.json"),
        JSON.stringify(manifest, null, 4),
    );
    await mkdir(join(appDir, "src"), { recursive: true });
    await writeFile(join(appDir, "src/index.html"), html);
    return {
        slug: brief.slug,
        manifestPath: join(appDir, "manifest.json"),
        srcPath: join(appDir, "src"),
        backend: "claude",
    };
}

function isSafeSlug(slug: string): boolean {
    return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

/** Build the argv we pass to `claude --print`. Exposed for tests. */
function runClaudeArgs(brief: GenerationBrief): string[] {
    return [
        "--print",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(CODEGEN_OUTPUT_SCHEMA),
        "--system-prompt",
        buildSystemPrompt(),
        "--dangerously-skip-permissions",
        buildUserPrompt({
            slug: brief.slug,
            intent: brief.intent,
            ...(brief.existingSrc !== undefined ? { existingSrc: brief.existingSrc } : {}),
            calibration: brief.calibration,
            now: new Date().toISOString(),
            builderId: BUILDER_ID,
            ...(brief.critique !== undefined ? { critique: brief.critique } : {}),
        }),
    ];
}

async function runClaude(
    brief: GenerationBrief,
    spawnFn: typeof spawn,
): Promise<CodegenOutput> {
    return await new Promise<CodegenOutput>((resolveOutput, rejectOutput) => {
        const child = spawnFn(CLAUDE_BIN, runClaudeArgs(brief), {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (err) => {
            rejectOutput(
                new CodegenError(
                    `failed to spawn ${CLAUDE_BIN}: ${err.message}`,
                    "spawn",
                    err,
                ),
            );
        });
        child.on("close", (code) => {
            if (code !== 0) {
                rejectOutput(
                    new CodegenError(
                        `${CLAUDE_BIN} exited with code ${code}: ${stderr.slice(0, 800)}`,
                        "spawn",
                    ),
                );
                return;
            }
            // The shape of stdout depends on which claude flags we used:
            //   - With `--json-schema`, the validated payload lands in
            //     wrapper.structured_output (already an object).
            //   - With `--output-format json` alone, the assistant's text reply
            //     is in wrapper.result (a string we then JSON.parse).
            //   - Some build scripts pipe inner JSON directly.
            // Resolve to whichever path produces a usable object.
            const wrapper = safeParse(stdout) as
                | {
                      type?: string;
                      is_error?: boolean;
                      result?: string;
                      structured_output?: unknown;
                  }
                | undefined;
            if (wrapper === undefined) {
                rejectOutput(
                    new CodegenError(
                        "claude stdout was not valid JSON",
                        "parse",
                    ),
                );
                return;
            }
            if (wrapper.is_error === true) {
                rejectOutput(
                    new CodegenError(
                        "claude reported is_error=true",
                        "spawn",
                    ),
                );
                return;
            }
            if (
                wrapper.structured_output !== undefined &&
                wrapper.structured_output !== null
            ) {
                resolveOutput(wrapper.structured_output as CodegenOutput);
                return;
            }
            if (typeof wrapper.result === "string" && wrapper.result.length > 0) {
                const inner = safeParse(wrapper.result);
                if (inner !== undefined) {
                    resolveOutput(inner as CodegenOutput);
                    return;
                }
                rejectOutput(
                    new CodegenError(
                        "claude `result` was not valid inner JSON",
                        "parse",
                    ),
                );
                return;
            }
            rejectOutput(
                new CodegenError(
                    "claude stdout had neither `structured_output` nor a non-empty `result`",
                    "parse",
                ),
            );
        });
    });
}

function safeParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function validateOutput(output: unknown, expectedSlug: string): void {
    if (typeof output !== "object" || output === null) {
        throw new CodegenError("output is not an object", "validate");
    }
    const o = output as Partial<CodegenOutput>;
    if (typeof o.manifest !== "object" || o.manifest === null) {
        throw new CodegenError("missing `manifest` field", "validate");
    }
    if (o.manifest.slug !== expectedSlug) {
        throw new CodegenError(
            `manifest.slug ${JSON.stringify(o.manifest.slug)} does not match brief slug ${JSON.stringify(expectedSlug)}`,
            "validate",
        );
    }
    if (o.manifest.schema_version !== 1) {
        throw new CodegenError(
            `unsupported manifest.schema_version ${String(o.manifest.schema_version)}`,
            "validate",
        );
    }
    if (typeof o.files !== "object" || o.files === null) {
        throw new CodegenError("missing `files` map", "validate");
    }
    if (typeof o.manifest.entry !== "string" || !(o.manifest.entry in o.files)) {
        throw new CodegenError(
            `manifest.entry ${JSON.stringify(o.manifest.entry)} is not present in files`,
            "validate",
        );
    }
    for (const path of Object.keys(o.files)) {
        if (path.includes("..") || path.startsWith("/") || normalize(path) !== path) {
            throw new CodegenError(
                `file path ${JSON.stringify(path)} escapes the app directory`,
                "validate",
            );
        }
    }
}

function secureJoin(root: string, child: string): string {
    const target = resolve(root, child);
    const rel = relative(root, target);
    if (rel.startsWith("..") || resolve(root, rel) !== target) {
        throw new CodegenError(
            `file path ${JSON.stringify(child)} escapes ${JSON.stringify(root)}`,
            "validate",
        );
    }
    return target;
}
