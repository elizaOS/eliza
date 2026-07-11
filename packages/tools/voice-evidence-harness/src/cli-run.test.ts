/**
 * Coverage for the harness CLI orchestration (main -> runScenario -> buildReadme).
 * The live seams (secret files, reference server, WS client, ffmpeg/MP4) are
 * faked; the REAL Evidence sink writes into a temp dir. A `--scenario=baseline`
 * run exercises the full evidence pipeline: fixture load, mint, client run with
 * all required stages marked, output-wav write, domain/timing/interrupt
 * artifacts, README build, and the top-level INDEX + pass path. The
 * process.exit + argv globals are saved/restored, and the mocks are restored in
 * afterAll so the non-isolated coverage lane's siblings are not poisoned.
 */

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

import * as realFs from "node:fs";
import * as realClient from "./client.ts";
import * as realMp4 from "./mp4.ts";
import * as realRealTarget from "./real/real-target.ts";
import * as realServer from "./reference/voice-session-server.ts";
import { writeWav } from "./wav.ts";

const realFsExports = { ...realFs };
const realClientExports = { ...realClient };
const realServerExports = { ...realServer };
const realRealTargetExports = { ...realRealTarget };
const realMp4Exports = { ...realMp4 };

// A valid linear16 mono 16k WAV the fixture reads resolve to.
const fixtureWav = writeWav({
  pcm: new Uint8Array(64),
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  audioFormat: 1,
});

// readFileSync: fake the two secret JSONs + any *.wav fixture; delegate the rest
// (Evidence's own reads are writes, so this is safe).
mock.module("node:fs", () => ({
  ...realFsExports,
  readFileSync: (p: unknown, ...rest: unknown[]) => {
    const path = String(p);
    if (path.endsWith("deepgram.json"))
      return JSON.stringify({ api_key: "dg" });
    if (path.endsWith("cartesia.json"))
      return JSON.stringify({ api_key: "ct" });
    if (path.endsWith(".wav")) return Buffer.from(fixtureWav);
    if (path.endsWith("walkthrough.mp4")) return Buffer.from([0, 0, 0, 0]);
    return (realFsExports.readFileSync as typeof realFs.readFileSync)(
      p as string,
      ...(rest as []),
    );
  },
}));

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

// MP4: report ffmpeg present + a successful assembly so the mp4 branch runs.
const mp4Stub = () => ({
  ...realMp4Exports,
  ensureFfmpeg: () => ({ ok: true, version: "6.0", installHint: "hint" }),
  assembleMp4: () => ({ ok: true }),
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
let tmpHome = "";

beforeEach(() => {
  clientResultOverride = {};
  markStages = true;
  tmpHome = mkdtempSync(join(tmpdir(), "cli-home-"));
  process.env.HOME = tmpHome;
  process.env.OPENROUTER_API_KEY = "or-key";
});

afterEach(() => {
  process.argv = originalArgv;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalOpenRouter;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

afterAll(() => {
  mock.module("node:fs", () => realFsExports);
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

test("baseline reference scenario runs the full evidence pipeline end-to-end", async () => {
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
});
