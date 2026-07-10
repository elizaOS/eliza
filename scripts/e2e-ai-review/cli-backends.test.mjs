/**
 * Unit tests for the pure backend-selection module: PATH probing with an
 * injected executable check, argv assembly, error classification, quota-aware
 * backend picking, and last-JSON-object extraction. node:test, no subprocesses.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  buildClaudeArgs,
  buildCodexArgs,
  classifyBackendError,
  DEFAULT_CODEX_MODEL,
  detectBackends,
  extractLastJsonObject,
  MAX_CODEX_IMAGES,
  pickBackend,
} from "./cli-backends.mjs";

test("detectBackends finds executables in PATH order", () => {
  const pathEnv = ["/a/bin", "/b/bin"].join(path.delimiter);
  const executables = new Set([
    "/b/bin/codex",
    "/a/bin/claude",
    "/b/bin/claude",
  ]);
  const detected = detectBackends({
    pathEnv,
    isExecutable: (candidate) => executables.has(candidate),
  });
  assert.equal(detected.codex, "/b/bin/codex");
  assert.equal(detected.claude, "/a/bin/claude");
});

test("detectBackends returns null for missing CLIs", () => {
  const detected = detectBackends({
    pathEnv: "/nowhere",
    isExecutable: () => false,
  });
  assert.deepEqual(detected, { codex: null, claude: null });
});

test("buildCodexArgs assembles a read-only exec invocation", () => {
  const args = buildCodexArgs({ repoRoot: "/repo", prompt: "review this" });
  assert.deepEqual(args, [
    "exec",
    "-m",
    DEFAULT_CODEX_MODEL,
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-C",
    "/repo",
    "review this",
  ]);
});

test("buildCodexArgs uses workspace-write in write mode and caps images", () => {
  const images = ["/i/1.png", "/i/2.png", "/i/3.png", "/i/4.png", "/i/5.png"];
  const args = buildCodexArgs({
    model: "custom-model",
    repoRoot: "/repo",
    prompt: "fix it",
    images,
    write: true,
  });
  assert.equal(args[2], "custom-model");
  assert.equal(args[args.indexOf("-s") + 1], "workspace-write");
  const attached = args.filter((arg) => arg === "-i");
  assert.equal(attached.length, MAX_CODEX_IMAGES);
  assert.ok(!args.includes("/i/5.png"));
  assert.equal(args[args.length - 1], "fix it");
  // -i is greedy multi-value: the arg right after the last image must be a
  // flag, never the prompt positional.
  const lastImage = args.lastIndexOf("-i");
  assert.ok(
    args[lastImage + 2].startsWith("-"),
    "image list must be flag-terminated",
  );
});

test("buildCodexArgs rejects missing repoRoot or prompt", () => {
  assert.throws(() => buildCodexArgs({ prompt: "x" }), /repoRoot/);
  assert.throws(() => buildCodexArgs({ repoRoot: "/repo" }), /prompt/);
});

test("buildClaudeArgs assembles read and write invocations", () => {
  assert.deepEqual(buildClaudeArgs({ prompt: "review" }), ["-p", "review"]);
  assert.deepEqual(buildClaudeArgs({ prompt: "fix", write: true }), [
    "-p",
    "--permission-mode",
    "acceptEdits",
    "fix",
  ]);
  assert.deepEqual(buildClaudeArgs({ prompt: "review", model: "opus" }), [
    "-p",
    "--model",
    "opus",
    "review",
  ]);
  assert.throws(() => buildClaudeArgs({}), /prompt/);
});

test("classifyBackendError recognizes quota patterns", () => {
  for (const message of [
    "You've hit your usage limit",
    "usage limit reached — upgrade your plan",
    "Rate limit exceeded, retry later",
    "HTTP 429 Too Many Requests",
    "you have reached your plan limit",
    "the model is overloaded",
    "insufficient quota",
  ]) {
    assert.deepEqual(classifyBackendError(message), { kind: "quota" }, message);
  }
});

test("classifyBackendError recognizes auth patterns", () => {
  for (const message of [
    "You are not logged in. Please run codex login",
    "HTTP 401 Unauthorized",
    "invalid api key provided",
  ]) {
    assert.deepEqual(classifyBackendError(message), { kind: "auth" }, message);
  }
});

test("classifyBackendError recognizes transient patterns", () => {
  for (const message of [
    "request timed out after 60s",
    "connect ECONNRESET 1.2.3.4:443",
    "HTTP 503 Service Unavailable",
    "network error while streaming",
  ]) {
    assert.deepEqual(
      classifyBackendError(message),
      { kind: "transient" },
      message,
    );
  }
});

test("classifyBackendError falls through to other", () => {
  assert.deepEqual(classifyBackendError("segmentation fault"), {
    kind: "other",
  });
  assert.deepEqual(classifyBackendError(""), { kind: "other" });
});

test("classifyBackendError prefers quota over transient when both match", () => {
  assert.deepEqual(classifyBackendError("rate limit hit, connection closed"), {
    kind: "quota",
  });
});

test("pickBackend prefers codex with the default model", () => {
  const detected = { codex: "/bin/codex", claude: "/bin/claude" };
  const picked = pickBackend({ detected });
  assert.deepEqual(picked, {
    name: "codex",
    command: "/bin/codex",
    model: DEFAULT_CODEX_MODEL,
  });
});

test("pickBackend falls back to claude when codex is quota-excluded", () => {
  const detected = { codex: "/bin/codex", claude: "/bin/claude" };
  const picked = pickBackend({ detected, excluded: new Set(["codex"]) });
  assert.deepEqual(picked, {
    name: "claude",
    command: "/bin/claude",
    model: null,
  });
});

test("pickBackend honors an explicit preference and never substitutes", () => {
  const detected = { codex: "/bin/codex", claude: "/bin/claude" };
  const picked = pickBackend({ preference: "claude", detected, model: "opus" });
  assert.deepEqual(picked, {
    name: "claude",
    command: "/bin/claude",
    model: "opus",
  });
  assert.equal(
    pickBackend({
      preference: "claude",
      detected,
      excluded: new Set(["claude"]),
    }),
    null,
  );
});

test("pickBackend returns null when nothing usable remains", () => {
  assert.equal(pickBackend({ detected: { codex: null, claude: null } }), null);
  assert.equal(
    pickBackend({
      detected: { codex: "/bin/codex", claude: "/bin/claude" },
      excluded: new Set(["codex", "claude"]),
    }),
    null,
  );
});

test("extractLastJsonObject finds a verdict wrapped in prose", () => {
  const output = `Working...\nHere is my review:\n{"verdict":"pass","confidence":0.9}\nDone.`;
  assert.deepEqual(extractLastJsonObject(output), {
    verdict: "pass",
    confidence: 0.9,
  });
});

test("extractLastJsonObject returns the LAST object, not nested ones", () => {
  const output = `{"first": true}\ntext\n{"verdict":"fail","findings":[{"severity":"major"}]}`;
  const parsed = extractLastJsonObject(output);
  assert.equal(parsed.verdict, "fail");
  assert.deepEqual(parsed.findings, [{ severity: "major" }]);
});

test("extractLastJsonObject survives braces inside strings and markdown fences", () => {
  const output =
    'note: "{" is tricky\n```json\n{"verdict":"pass","notes":"uses {curly} braces and \\"quotes\\""}\n```';
  const parsed = extractLastJsonObject(output);
  assert.equal(parsed.verdict, "pass");
  assert.ok(parsed.notes.includes("{curly}"));
});

test("extractLastJsonObject ignores unparseable brace spans", () => {
  const output =
    '{not json at all} but then {"verdict":"flaky","confidence":0.4}';
  assert.deepEqual(extractLastJsonObject(output), {
    verdict: "flaky",
    confidence: 0.4,
  });
});

test("extractLastJsonObject returns null when no object exists", () => {
  assert.equal(extractLastJsonObject("no json here"), null);
  assert.equal(extractLastJsonObject("[1,2,3]"), null);
  assert.equal(extractLastJsonObject(""), null);
});
