/**
 * Coverage for the harness CLI orchestration (main -> runScenario -> buildReadme)
 * plus the #16180 home-isolation contract. The live seams (reference server, WS
 * client, ffmpeg/MP4, real target) are faked; the filesystem is REAL: secrets
 * are real JSON files in a temp dir the CLI reads via VOICE_EVIDENCE_SECRETS_DIR,
 * the fixture is the real committed WAV, and the REAL Evidence sink writes into
 * the VOICE_EVIDENCE_ROOT temp dir. Every test asserts all produced artifacts
 * stay below the mkdtemp root and that the real ~/.moltbot tree has zero delta
 * (reassigning process.env.HOME is NOT sufficient under Bun — homedir() keeps
 * returning the real account home, which is how the original leak happened).
 * A subprocess leg runs the real, unmocked CLI to a loud failure and proves the
 * failure path honors the seam too. The process.exit + argv globals are
 * saved/restored, and the mocks are restored in afterAll so sibling suites in
 * the same bun process are not poisoned.
 */

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

import * as realClient from "./client.ts";
import * as realMp4 from "./mp4.ts";
import { EVIDENCE_ROOT_ENV, SECRETS_DIR_ENV } from "./paths.ts";
import * as realRealTarget from "./real/real-target.ts";
import * as realServer from "./reference/voice-session-server.ts";

const realClientExports = { ...realClient };
const realServerExports = { ...realServer };
const realRealTargetExports = { ...realRealTarget };
const realMp4Exports = { ...realMp4 };

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));

// The real account home, captured before any test touches process.env.HOME.
// Bun's homedir() ignores a HOME reassignment, so this is what the pre-#16180
// CLI actually wrote under — the no-delta assertions below guard exactly it.
const REAL_HOME = homedir();
const REAL_MOLTBOT = join(REAL_HOME, ".moltbot");

/**
 * Serialize a directory tree (names, kinds, sizes, mtimes) for before/after
 * comparison. Any write anywhere below `root` — new file, new dir, touched
 * mtime, changed size — changes the serialization. `<absent>` keeps a missing
 * root (fresh CI account) distinguishable from an empty one.
 */
function snapshotTree(root: string): string {
  if (!existsSync(root)) return "<absent>";
  const lines: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const p = join(dir, entry.name);
      const st = lstatSync(p);
      const kind = entry.isDirectory()
        ? "dir"
        : entry.isSymbolicLink()
          ? "link"
          : "file";
      lines.push(
        `${relative(root, p)} ${kind} size=${st.size} mtimeMs=${st.mtimeMs}`,
      );
      if (entry.isDirectory()) walk(p);
    }
  };
  walk(root);
  return lines.join("\n");
}

/** Absolute paths of every file below `root` (throws if root is missing). */
function listFilesRecursive(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(root);
  return files;
}

// Reference server double: mint + a no-op stop. runScenario wires hooks but our
// faked runClient marks the stages, so the server internals are not needed here.
const serverStub = () => ({
  ...realServerExports,
  startReferenceServer: () => ({
    port: 0,
    wsUrl: "ws://127.0.0.1:0/api/v1/voice/session/ws",
    mint: () => ({
      sessionId: "sess-1",
      token: "tok",
      wsUrl: "ws://127.0.0.1:0/api/v1/voice/session/ws",
      expiresAt: Date.now() + 1000,
    }),
    stop: () => undefined,
  }),
});
mock.module("./reference/voice-session-server.ts", serverStub);

const realTargetStub = () => ({
  ...realRealTargetExports,
  startRealTarget: async () => ({
    wsUrl: "ws://127.0.0.1:0/api/v1/voice/session/ws?sessionId=",
    mint: async () => ({
      sessionId: "sess-real",
      token: "tok",
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    }),
    stop: async () => undefined,
  }),
});
mock.module("./real/real-target.ts", realTargetStub);

// MP4: report ffmpeg present and write a real (fake-content) walkthrough.mp4 so
// the CLI's read-back-and-index step exercises the real filesystem — this suite
// deliberately mocks no fs API.
const mp4Stub = () => ({
  ...realMp4Exports,
  ensureFfmpeg: () => ({ ok: true, version: "6.0", installHint: "hint" }),
  assembleMp4: (params: { dir: string; out: string }) => {
    writeFileSync(join(params.dir, params.out), new Uint8Array([0, 0, 0, 0]));
    return { ok: true };
  },
});
mock.module("./mp4.ts", mp4Stub);

// Client double: mark every required baseline stage so the DoD gate passes, and
// return a downlink so the output-wav + TTS-frame assertions hold.
let clientResultOverride: Partial<realClient.ClientRunResult> = {};
let markStages = true;
const clientStub = () => ({
  ...realClientExports,
  runClient: async (opts: {
    evidence: {
      mark: (s: string) => void;
      wsEvent: (a: string, b: string, c: Record<string, unknown>) => void;
    };
  }) => {
    const ev = opts.evidence;
    if (markStages) {
      for (const s of [
        "ws_hello",
        "ready",
        "stt_final",
        "llm_first_text",
        "tts_first_frame",
        "tts_complete",
      ]) {
        ev.mark(s);
      }
    }
    return {
      downlinkPcm: new Uint8Array(32),
      downlinkFrameCount: 4,
      postBargeInFrameCount: 0,
      sawReady: true,
      sawSttFinal: true,
      sawSpeakingStart: true,
      sawInterrupted: false,
      errors: [] as Array<{ code: string; retryable: boolean }>,
      bargeInSentMonoMs: null,
      firstSilenceAfterBargeInMonoMs: null,
      ...clientResultOverride,
    };
  },
});
mock.module("./client.ts", clientStub);

const originalArgv = process.argv;
const originalHome = process.env.HOME;
const originalOpenRouter = process.env.OPENROUTER_API_KEY;
const originalEvidenceRoot = process.env[EVIDENCE_ROOT_ENV];
const originalSecretsDir = process.env[SECRETS_DIR_ENV];
let tmpRoot = "";
let evidenceOverrideRoot = "";
let secretsOverrideDir = "";
let realMoltbotBefore = "";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  clientResultOverride = {};
  markStages = true;
  tmpRoot = mkdtempSync(join(tmpdir(), "voice-evidence-cli-"));
  evidenceOverrideRoot = join(tmpRoot, "evidence");
  secretsOverrideDir = join(tmpRoot, "secrets");
  // REAL secret files in the override dir: the CLI's loadSecret() performs a
  // genuine disk read through the seam (nothing intercepts readFileSync here).
  mkdirSync(secretsOverrideDir, { recursive: true });
  writeFileSync(
    join(secretsOverrideDir, "deepgram.json"),
    JSON.stringify({ api_key: "dg-test" }),
  );
  writeFileSync(
    join(secretsOverrideDir, "cartesia.json"),
    JSON.stringify({ api_key: "ct-test" }),
  );
  process.env[EVIDENCE_ROOT_ENV] = evidenceOverrideRoot;
  process.env[SECRETS_DIR_ENV] = secretsOverrideDir;
  // Reassigned for hygiene only: Bun's homedir() ignores it (#16180), which is
  // why the two explicit overrides above are the actual isolation mechanism.
  process.env.HOME = tmpRoot;
  process.env.OPENROUTER_API_KEY = "or-key";
  realMoltbotBefore = snapshotTree(REAL_MOLTBOT);
});

afterEach(() => {
  process.argv = originalArgv;
  restoreEnv("HOME", originalHome);
  restoreEnv("OPENROUTER_API_KEY", originalOpenRouter);
  restoreEnv(EVIDENCE_ROOT_ENV, originalEvidenceRoot);
  restoreEnv(SECRETS_DIR_ENV, originalSecretsDir);
  // Safety net behind the per-test assertions: no test may leave a delta under
  // the real ~/.moltbot tree.
  expect(snapshotTree(REAL_MOLTBOT)).toBe(realMoltbotBefore);
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

afterAll(() => {
  mock.module("./client.ts", () => realClientExports);
  mock.module("./reference/voice-session-server.ts", () => realServerExports);
  mock.module("./real/real-target.ts", () => realRealTargetExports);
  mock.module("./mp4.ts", () => realMp4Exports);
});

// Import cli (which auto-runs main()) with a per-call process.exit capture so
// cross-test async bleed cannot pollute the assertion. Returns the exit codes
// this specific run requested, after the async main() settles.
async function importCli(): Promise<Array<number | undefined>> {
  const localExits: Array<number | undefined> = [];
  const prevExit = process.exit;
  process.exit = ((code?: number) => {
    localExits.push(code);
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  try {
    try {
      // IMPORTANT: import cli.ts with NO query string. A `?bust=...` specifier
      // runs the code but bun attributes its coverage to the query-string URL,
      // NOT `cli.ts`, so the changed-file gate would see cli.ts as ~10%.
      // main() runs once on this first (and only) import.
      await import("./cli.ts");
    } catch (err) {
      if (!(err instanceof ExitSignal) && !String(err).includes("exit:")) {
        throw err;
      }
    }
    // main() is async (scenario loop + `.catch(exit(1))`); drain the queue so
    // any exit it requests is recorded before we restore process.exit.
    for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 5));
  } finally {
    process.exit = prevExit;
  }
  return localExits;
}

test("baseline reference scenario runs the full evidence pipeline under the override root", async () => {
  // main() only runs once per test process (module is cached after the first
  // import), and we import cli.ts WITHOUT a query bust so coverage lands on
  // cli.ts. A baseline reference run drives the fullest single-scenario path:
  // fixture load, mint, client run with all required stages, output-wav write,
  // domain/timing/interrupt artifacts, MP4, README, INDEX, and the pass exit.
  process.argv = [
    "bun",
    "src/cli.ts",
    "--scenario=baseline",
    "--target=reference",
  ];
  const exits = await importCli();
  // The fully-faked baseline run meets its DoD -> no non-zero exit.
  expect(exits.every((c) => c === 0 || c === undefined)).toBe(true);

  // Exactly one timestamped run dir, created under the override root.
  const runDirs = readdirSync(evidenceOverrideRoot);
  expect(runDirs).toHaveLength(1);
  const runDir = join(evidenceOverrideRoot, runDirs[0]);
  const indexMd = readFileSync(join(runDir, "INDEX.md"), "utf8");
  expect(indexMd).toContain("| baseline | PASS |");

  // Every artifact of the run sits below the mkdtemp root — nothing may escape
  // toward the real home (#16180 acceptance criterion).
  const artifacts = listFilesRecursive(evidenceOverrideRoot);
  expect(artifacts.length).toBeGreaterThan(0);
  for (const artifact of artifacts) {
    expect(artifact.startsWith(tmpRoot + sep)).toBe(true);
  }

  // The complete per-scenario DoD artifact set landed in <run>/baseline/.
  const produced = new Set(
    artifacts.map((artifactPath) => relative(runDir, artifactPath)),
  );
  for (const expected of [
    "INDEX.md",
    "baseline/input.wav",
    "baseline/output-tts.wav",
    "baseline/domain-rows.json",
    "baseline/timing-report.json",
    "baseline/interrupt-assertion.json",
    "baseline/ws-transcript.json",
    "baseline/server.log.json",
    "baseline/client.log.json",
    "baseline/all.log.json",
    "baseline/walkthrough.mp4",
    "baseline/README.md",
  ]) {
    expect(produced.has(expected)).toBe(true);
  }

  // input.wav is the REAL committed fixture, read through the real fs.
  const fixtureBytes = readFileSync(join(PKG_DIR, "fixtures/turn_weather.wav"));
  const capturedInput = readFileSync(join(runDir, "baseline/input.wav"));
  expect(capturedInput.equals(fixtureBytes)).toBe(true);

  // The real ~/.moltbot tree is untouched by the passing run.
  expect(snapshotTree(REAL_MOLTBOT)).toBe(realMoltbotBefore);
});

test("failing CLI subprocess (real, unmocked) keeps every write under the override root", () => {
  // The real cli.ts, no module mocks: secrets resolve through
  // VOICE_EVIDENCE_SECRETS_DIR (a genuine disk read of the temp JSONs proves
  // the secrets seam), then the missing OPENROUTER_API_KEY fails the run
  // loudly. The evidence dir is created before that failure, so this leg
  // proves the FAILURE path also lands under the override root and leaves the
  // real home untouched.
  const childEnv: Record<string, string | undefined> = { ...process.env };
  delete childEnv.OPENROUTER_API_KEY;
  const res = spawnSync(
    process.execPath,
    ["run", "src/cli.ts", "--scenario=baseline", "--target=reference"],
    { cwd: PKG_DIR, env: childEnv, encoding: "utf8", timeout: 120_000 },
  );
  expect(res.error).toBeUndefined();
  expect(res.status).toBe(1);
  expect(`${res.stdout}\n${res.stderr}`).toContain(
    "OPENROUTER_API_KEY not set",
  );

  // The failure still produced its (partial) evidence tree under the override
  // root: one timestamped run dir containing the baseline scenario dir.
  const runDirs = readdirSync(evidenceOverrideRoot);
  expect(runDirs).toHaveLength(1);
  const scenarioDir = join(evidenceOverrideRoot, runDirs[0], "baseline");
  expect(lstatSync(scenarioDir).isDirectory()).toBe(true);
  for (const artifact of listFilesRecursive(evidenceOverrideRoot)) {
    expect(artifact.startsWith(tmpRoot + sep)).toBe(true);
  }

  // No delta anywhere under the real ~/.moltbot tree — the default evidence
  // root and the default secrets dir both live below it.
  expect(snapshotTree(REAL_MOLTBOT)).toBe(realMoltbotBefore);
});
