import { spawn as spawnProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished, test } from "vitest";
import { testOutputPath } from "../../../scripts/lib/test-output";
import { resolveBunExecutable } from "../../../scripts/lib/vitest-batches";
import { readMonoPcm16Wav } from "./standalone-asr-service";

function wav(samples: Int16Array, sampleRate: number, channels = 1): Buffer {
  const audio = Buffer.alloc(44 + samples.length * 2);
  audio.write("RIFF");
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVE", 8);
  audio.write("fmt ", 12);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(channels, 22);
  audio.writeUInt32LE(sampleRate, 24);
  audio.writeUInt32LE(sampleRate * channels * 2, 28);
  audio.writeUInt16LE(channels * 2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer).copy(audio, 44);
  return audio;
}

describe("standalone ASR audio input", () => {
  it("accepts mono PCM16 at the rate the speech output uses", () => {
    const { samples, sampleRate } = readMonoPcm16Wav(
      wav(new Int16Array([0, 100, -100, 0]), 24000),
    );
    expect(sampleRate).toBe(24000);
    expect([...new Int16Array(samples.buffer, samples.byteOffset, 4)]).toEqual([
      0, 100, -100, 0,
    ]);
  });

  it("refuses stereo, digital silence and over-long audio", () => {
    expect(() => readMonoPcm16Wav(wav(new Int16Array(4), 16000, 2))).toThrow(
      "requires_mono_pcm16",
    );
    expect(() => readMonoPcm16Wav(wav(new Int16Array(4), 16000))).toThrow(
      "no_speech",
    );
    expect(() =>
      readMonoPcm16Wav(wav(new Int16Array(61 * 8000).fill(1), 8000)),
    ).toThrow("audio_duration_invalid");
  });
});

/**
 * The real worker runtime (fd 3 protocol, engine thread, native-cancel retry)
 * driven by the real service through a packaged-style export. Only the
 * engine is synthetic: its `run` blocks until the protocol thread's cancel
 * lands, the way a native forward pass blocks the engine thread.
 */
const runtime = fileURLToPath(
  new URL(
    "../../../../plugins/plugin-local-inference/src/host-speech-runtime.ts",
    import.meta.url,
  ),
);
const engineWorker = `
import { existsSync, writeFileSync } from 'node:fs';
import { isMainThread } from 'node:worker_threads';
import { serveSpeechEngine, serveSpeechProtocol } from ${JSON.stringify(runtime)};
const flag = process.env.ELIZA_ASR_MODEL_DIR + '/cancelled';
if (isMainThread) {
 await serveSpeechProtocol({
  engineUrl: new URL(import.meta.url),
  maxLine: 1 << 20,
  idleReleaseMs: 60000,
  parse: (input) => ({ id: input.id, pcm: input.pcm, sampleRate: input.sampleRate }),
  cancel: (ctx) => { if (ctx === 7n) writeFileSync(flag, ''); },
 });
} else {
 serveSpeechEngine(() => ({
  ctx: 7n,
  run(request) {
   const samples = Buffer.from(request.pcm, 'base64').length / 2;
   if (samples < 1000) return { text: 'short ' + request.sampleRate };
   while (!existsSync(flag)) {}
   throw Error('cancelled');
  },
  release() {},
  dispose() {},
 }));
}
`;
const harness = `
import assert from 'node:assert/strict';
import { StandaloneAsrService } from './standalone-asr-service.ts';
const service = new StandaloneAsrService();
try {
 const short = Buffer.alloc(200, 1);
 assert.equal(await service.transcribe('00000000-0000-4000-8000-000000000001', short, 16000, new AbortController().signal), 'short 16000');
 const controller = new AbortController();
 const pending = service.transcribe('00000000-0000-4000-8000-000000000002', Buffer.alloc(32000, 1), 16000, controller.signal);
 await new Promise(resolve => setTimeout(resolve, 200));
 const start = Date.now();
 controller.abort();
 await assert.rejects(pending, {message:'Speech cancelled'});
 while (service.busy) await new Promise(resolve => setTimeout(resolve, 10));
 assert.ok(Date.now() - start < 5000);
 // The engine answered the cancel; the same worker serves the next request.
 assert.equal(service.initialized, true);
 assert.equal(await service.transcribe('00000000-0000-4000-8000-000000000003', short, 8000, new AbortController().signal), 'short 8000');
 console.log(JSON.stringify({passed:true}));
} finally { service.stop(); }
`;

async function runBun(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const bun = resolveBunExecutable();
  if (!bun) throw Error("Bun is required for the speech worker tests");
  const child = spawnProcess(bun, ["--no-install", ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => {
    stdout += bytes.toString();
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

test("worker runtime cancels a blocked engine call and keeps the worker", async () => {
  const output = testOutputPath("standalone-asr-lifecycle", "fixtures");
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(path.join(output, "worker-"));
  try {
    const provider = path.join(
      root,
      "node_modules/@elizaos/plugin-local-inference",
    );
    await mkdir(provider, { recursive: true });
    await writeFile(
      path.join(provider, "package.json"),
      JSON.stringify({
        type: "module",
        exports: { "./host-asr-worker": "./worker.mjs" },
      }),
    );
    await writeFile(path.join(provider, "worker.mjs"), engineWorker);
    await writeFile(path.join(root, "harness.mjs"), harness);
    for (const file of [
      "standalone-asr-service.ts",
      "standalone-speech-service.ts",
    ])
      await writeFile(
        path.join(root, file),
        await readFile(fileURLToPath(new URL(`./${file}`, import.meta.url))),
      );
    const result = await runBun([path.join(root, "harness.mjs")], root, {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ELIZA_ASR_MODEL_DIR: root,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ passed: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

/**
 * Real libelizainference: Paradee speech out, a transcript back from the ASR
 * the model dir holds (Phonon-2 or the Qwen3-ASR pair), and a native ASR
 * cancel. Runs on macOS arm64 and Linux x86_64 when the reviewed
 * library and both pinned asset directories are configured; it never
 * downloads assets.
 */
const native =
  !!process.env.ELIZA_INFERENCE_LIBRARY &&
  !!process.env.ELIZA_INFERENCE_LIBRARY_SHA256 &&
  !!process.env.ELIZA_PARADEE_MODEL_DIR &&
  !!process.env.ELIZA_ASR_MODEL_DIR &&
  ((process.platform === "darwin" && process.arch === "arm64") ||
    (process.platform === "linux" && process.arch === "x64"));
const nativeHarness = `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { StandaloneAsrService, readMonoPcm16Wav } from './standalone-asr-service.ts';
import { StandaloneTtsService } from './standalone-speech-service.ts';
const tts = new StandaloneTtsService(), asr = new StandaloneAsrService();
const id = () => crypto.randomUUID();
try {
 const sentence = 'Please remember to water the plants tomorrow morning.';
 const speech = await tts.synthesize(id(), sentence, new AbortController().signal);
 writeFileSync(process.argv[2] + '/paradee.wav', speech);
 const audio = readMonoPcm16Wav(speech);
 assert.equal(audio.sampleRate, 24000);
 const text = await asr.transcribe(id(), audio.samples, audio.sampleRate, new AbortController().signal);
 assert.ok(text.trim().length > 0, 'transcript must not be empty');
 // Cancel a long transcription in flight: the native call stops early and
 // the same worker answers the next request.
 const long = Buffer.concat(Array(6).fill(audio.samples));
 const controller = new AbortController();
 const started = Date.now();
 const full = asr.transcribe(id(), long, audio.sampleRate, new AbortController().signal);
 const fullText = await full;
 const fullMs = Date.now() - started;
 const pending = asr.transcribe(id(), long, audio.sampleRate, controller.signal);
 await new Promise(resolve => setTimeout(resolve, Math.min(1000, fullMs / 4)));
 const cancelAt = Date.now();
 controller.abort();
 await assert.rejects(pending, {message:'Speech cancelled'});
 while (asr.busy) await new Promise(resolve => setTimeout(resolve, 10));
 const cancelMs = Date.now() - cancelAt;
 assert.ok(asr.initialized, 'cancel must not kill the worker');
 assert.ok(cancelMs < fullMs * 0.75, 'cancel must interrupt the native call: ' + cancelMs + ' of ' + fullMs + ' ms');
 const again = await asr.transcribe(id(), audio.samples, audio.sampleRate, new AbortController().signal);
 assert.ok(again.trim().length > 0);
 console.log(JSON.stringify({ text, fullText, fullMs, cancelMs }));
} finally { tts.stop(); asr.stop(); }
`;

describe.skipIf(!native)("standalone speech on libelizainference", () => {
  it("transcribes Paradee speech and cancels a transcription in flight", async () => {
    const output = testOutputPath("standalone-asr-native");
    await mkdir(output, { recursive: true });
    const harnessPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      ".standalone-asr-native.harness.ts",
    );
    await writeFile(harnessPath, nativeHarness);
    try {
      const result = await runBun(
        ["--conditions=eliza-source", harnessPath, output],
        path.dirname(harnessPath),
        process.env,
      );
      expect(result.code, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
      await writeFile(
        path.join(output, "report.json"),
        JSON.stringify(report, null, 2),
      );
      expect(report.text.length).toBeGreaterThan(0);
    } finally {
      await rm(harnessPath, { force: true });
    }
  }, 600_000);
});
