/**
 * Exercises the real streaming playback sink and packaged AudioWorklet in
 * Chromium OfflineAudioContext graphs at native device rates. PCM artifacts
 * expose duration, pitch, frame continuity, and barge-in reset for inspection.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const sourceRoot = new URL("../", import.meta.url);
const output = process.env.PLAYBACK_EVIDENCE_DIR;
const bundle = await build({
  stdin: {
    contents:
      'export { createVoiceSessionPlayback } from "./voice-session-playback"; export { floatPcmToInt16Bytes } from "./voice-session-pcm";',
    resolveDir: fileURLToPath(sourceRoot),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
});
const worklet = `${await readFile(new URL("worklets/voice-session-downlink.js", sourceRoot), "utf8")}
// Test-only port barrier: queue and render behavior are inherited unchanged.
registerProcessor("eliza-voice-session-downlink-evidence", class extends ElizaVoiceSessionDownlink {
  constructor() {
    super();
    const receive = this.port.onmessage;
    this.port.onmessage = (event) => {
      if (event.data.type === "evidence-barrier") this.port.postMessage({ type: "evidence-ready" });
      else receive(event);
    };
  }
});`;
const server = createServer((request, response) => {
  response.setHeader(
    "Content-Type",
    request.url === "/" ? "text/html" : "text/javascript",
  );
  if (request.url === "/")
    response.end(
      "<!doctype html><title>Voice playback sample-rate verification</title>",
    );
  else if (request.url === "/voice.js")
    response.end(bundle.outputFiles[0].contents);
  else if (request.url?.startsWith("/worklets/voice-session-downlink.js"))
    response.end(worklet);
  else {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const results = await page.evaluate(async () => {
    const { createVoiceSessionPlayback, floatPcmToInt16Bytes } = await import(
      "/voice.js"
    );
    let lastNode;
    const NativeAudioWorkletNode = globalThis.AudioWorkletNode;
    globalThis.AudioWorkletNode = class extends NativeAudioWorkletNode {
      constructor(context, name) {
        super(context, `${name}-evidence`);
        lastNode = this;
      }
    };
    async function render(rate, chunkSize, reset = false, single = false) {
      const sourceLength = single ? 1 : 1600;
      const length = Math.ceil((sourceLength * rate) / 16000);
      const context = new OfflineAudioContext(1, length + 128, rate);
      // Offline graphs have no autoplay lifecycle. Only adapt that lifecycle;
      // construction, queueing, resampling, worklet and rendering remain real.
      Object.defineProperties(context, {
        state: { value: "running" },
        close: { value: async () => {} },
      });
      const sink = await createVoiceSessionPlayback({
        createAudioContext: () => context,
      });
      if (sink.backend !== "audioworklet")
        throw new Error("Real AudioWorklet unavailable");
      const source = Float32Array.from({ length: sourceLength }, (_, i) =>
        single ? 1 : 0.5 * Math.sin((2 * Math.PI * 400 * i) / 16000),
      );
      if (reset) {
        sink.enqueue(floatPcmToInt16Bytes(new Float32Array([-1])));
        sink.flush();
      }
      for (let i = 0; i < source.length; i += chunkSize) {
        sink.enqueue(floatPcmToInt16Bytes(source.subarray(i, i + chunkSize)));
      }
      // Offline rendering can outrun MessagePort delivery. The inherited
      // processor acknowledges a FIFO barrier before the graph begins.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Worklet queue barrier timed out")),
          5000,
        );
        const receive = (event) => {
          if (event.data.type !== "evidence-ready") return;
          clearTimeout(timer);
          lastNode.port.removeEventListener("message", receive);
          resolve();
        };
        lastNode.port.addEventListener("message", receive);
        lastNode.port.postMessage({ type: "evidence-barrier" });
      });
      const buffer = await context.startRendering();
      const pcm = Array.from(buffer.getChannelData(0));
      await sink.stop();
      return { rate, length, pcm };
    }
    const results = [];
    for (const rate of [16000, 44100, 48000]) {
      const whole = await render(rate, 1600);
      const chunks = await render(rate, 7);
      const reset = await render(rate, 7, true);
      const single = await render(rate, 1, true, true);
      results.push({
        ...whole,
        chunked: chunks.pcm,
        reset: reset.pcm,
        single: single.pcm,
      });
    }
    return results;
  });
  const measurements = [];
  if (output) await mkdir(output, { recursive: true });
  for (const result of results) {
    assert.deepEqual(
      result.chunked,
      result.pcm,
      `chunk continuity at ${result.rate}`,
    );
    assert.deepEqual(
      result.reset,
      result.pcm,
      `barge-in reset at ${result.rate}`,
    );
    assert(result.pcm.slice(result.length).every((sample) => sample === 0));
    const singleLength = Math.ceil(result.rate / 16000);
    assert.deepEqual(
      result.single,
      [...new Array(singleLength).fill(1), ...new Array(128).fill(0)],
      `final single-sample frame at ${result.rate}`,
    );
    const crossings = [];
    for (let i = 1; i < result.length; i++) {
      if (result.pcm[i - 1] <= 0 && result.pcm[i] > 0) crossings.push(i);
    }
    const duration =
      (result.pcm.findLastIndex((sample) => sample !== 0) + 1) / result.rate;
    const frequency =
      ((crossings.length - 1) * result.rate) /
      (crossings.at(-1) - crossings[0]);
    assert.equal(crossings.length, 40, `tone cycles at ${result.rate}`);
    assert(
      Math.abs(frequency - 400) < 0.2,
      `400 Hz pitch at ${result.rate}: ${frequency}`,
    );
    assert(
      Math.abs(duration - 0.1) <= 1 / result.rate,
      `100 ms duration at ${result.rate}: ${duration}`,
    );
    measurements.push({
      sampleRate: result.rate,
      durationSeconds: duration,
      frequencyHz: frequency,
      risingCrossings: crossings.length,
      chunkContinuity: true,
      bargeInReset: true,
      finalSingleSample: true,
    });
    if (output) {
      const wav = Buffer.alloc(44 + result.pcm.length * 2);
      wav.write("RIFF");
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(result.rate, 24);
      wav.writeUInt32LE(result.rate * 2, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(wav.length - 44, 40);
      result.pcm.forEach((sample, index) =>
        wav.writeInt16LE(Math.round(sample * 32767), 44 + index * 2),
      );
      await writeFile(`${output}/playback-${result.rate}.wav`, wav);
    }
  }
  if (output)
    await writeFile(
      `${output}/measurements.json`,
      JSON.stringify(measurements, null, 2),
    );
  console.log(JSON.stringify(measurements, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
