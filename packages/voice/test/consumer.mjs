import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

// Qualifies @elizaos/voice/browser-capture in headless Chromium: MediaRecorder session
// ownership, WAV decoding to mono 16 kHz samples, PCM16 WAV encoding and cancellation.
// The package has no recognizer; hosts send the WAV to their own speech service.
if (process.argv.length > 2)
  throw Error("Usage: node packages/voice/test/consumer.mjs (no arguments)");
const voice = path.resolve(import.meta.dirname, "../dist"),
  repository = path.resolve(import.meta.dirname, "../../..");
const output = testOutputPath("browser-capture-consumer");
const host = path.join(output, "host");
fs.mkdirSync(host, { recursive: true });
fs.writeFileSync(
  path.join(host, "index.html"),
  "<!doctype html><title>Voice consumer</title><button>Start</button>",
);
const requests = [];
const server = await createServer({
  root: host,
  configFile: false,
  server: { host: "127.0.0.1", port: 0, fs: { allow: [repository] } },
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
try {
  const page = await browser.newPage();
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    requests.push(u.href);
    if (
      !["127.0.0.1", "localhost"].includes(u.hostname) &&
      !["blob:", "data:"].includes(u.protocol)
    )
      return route.abort();
    return route.continue();
  });
  await page.goto(origin);
  const capture = await page.evaluate(async (source) => {
    const { BrowserAudioCapture } = await import(`/@fs${source}`);
    const pending = [],
      ended = [],
      contexts = [];
    const audio = new BrowserAudioCapture({
      hidden: () => false,
      openMicrophone: (onLost) =>
        new Promise((resolve) => pending.push({ resolve, onLost })),
      stopped: (e) => ended.push(e),
    });
    function stream() {
      const context = new AudioContext(),
        osc = context.createOscillator(),
        sink = context.createMediaStreamDestination();
      contexts.push(context);
      osc.connect(sink);
      osc.start();
      return {
        stream: sink.stream,
        close: () => {
          osc.stop();
          void context.close();
        },
      };
    }
    const older = audio.start().catch((e) => e.name),
      newer = audio.start();
    const live = stream();
    pending[1].resolve(live);
    const current = await newer;
    pending[0].resolve(stream());
    const retired = await older;
    pending[0].onLost();
    await new Promise((resolve) => setTimeout(resolve, 350));
    let saved, error;
    try {
      saved = await audio.stop();
    } catch (e) {
      error = e.message;
    }
    const result = {
      retired,
      ended: ended.length,
      saved: saved?.recordingId === current.recordingId,
      bytes: saved ? audio.get(saved.recordingId)?.blob.size : 0,
      error,
    };
    audio.clear();
    await Promise.all(
      contexts.map((c) => (c.state === "closed" ? undefined : c.close())),
    );
    return result;
  }, `${voice}/browser-capture/audio-capture.js`);
  console.log(JSON.stringify({ capture }));
  assert.equal(capture.retired, "AbortError");
  assert.equal(capture.ended, 0);
  assert.equal(capture.saved, true);
  assert.ok(capture.bytes > 0);
  const pcm = await page.evaluate(async (source) => {
    const { decodeRecordingPcm, encodePcm16Wav, recordingPcmWav } =
      await import(`/@fs${source}/browser-capture/recording-pcm.js`);
    // One second of a 440 Hz tone at 0.5 amplitude, encoded at 48 kHz so decoding
    // must resample it to 16 kHz.
    const tone = new Float32Array(48000);
    for (let i = 0; i < tone.length; i++)
      tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    const source48k = new Blob([encodePcm16Wav(tone, 48000)], {
      type: "audio/wav",
    });
    const samples = await decodeRecordingPcm(
      source48k,
      new AbortController().signal,
    );
    let sum = 0;
    for (const value of samples) sum += value * value;
    const wav = await recordingPcmWav(source48k, new AbortController().signal);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const aborted = new AbortController();
    aborted.abort();
    let abortError;
    try {
      await decodeRecordingPcm(source48k, aborted.signal);
    } catch (e) {
      abortError = e.name;
    }
    let rateError;
    try {
      encodePcm16Wav(new Float32Array(1), 4000);
    } catch (e) {
      rateError = e.message;
    }
    const clipped = encodePcm16Wav(Float32Array.of(-2, 2, Number.NaN), 16000);
    const clippedView = new DataView(clipped.buffer);
    return {
      length: samples.length,
      rms: Math.sqrt(sum / samples.length),
      wavBytes: wav.byteLength,
      riff: String.fromCharCode(...wav.subarray(0, 4)),
      wave: String.fromCharCode(...wav.subarray(8, 12)),
      channels: view.getUint16(22, true),
      sampleRate: view.getUint32(24, true),
      bitsPerSample: view.getUint16(34, true),
      dataBytes: view.getUint32(40, true),
      abortError,
      rateError,
      clipped: [0, 1, 2].map((i) => clippedView.getInt16(44 + i * 2, true)),
    };
  }, voice);
  console.log(JSON.stringify({ pcm }));
  assert.equal(pcm.length, 16000);
  // A 0.5-amplitude sine has RMS 0.5 / sqrt(2).
  assert.ok(Math.abs(pcm.rms - 0.5 / Math.SQRT2) < 0.02, `rms ${pcm.rms}`);
  assert.equal(pcm.riff, "RIFF");
  assert.equal(pcm.wave, "WAVE");
  assert.equal(pcm.channels, 1);
  assert.equal(pcm.sampleRate, 16000);
  assert.equal(pcm.bitsPerSample, 16);
  assert.equal(pcm.dataBytes, 32000);
  assert.equal(pcm.wavBytes, 44 + 32000);
  assert.equal(pcm.abortError, "AbortError");
  assert.equal(pcm.rateError, "Unsupported sample rate.");
  assert.deepEqual(pcm.clipped, [-32768, 32767, 0]);
  const summary = {
    capture,
    pcm,
    foreignRequests: requests.filter(
      (u) =>
        !u.startsWith(origin) &&
        !u.startsWith("blob:") &&
        !u.startsWith("data:"),
    ),
  };
  assert.deepEqual(summary.foreignRequests, []);
  fs.writeFileSync(
    path.join(output, "browser-summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary));
} finally {
  await browser.close();
  await server.close();
}
