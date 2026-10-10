import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const [assetsArg, runtimeArg, wavArg, expected] = process.argv.slice(2);
if (!assetsArg || !runtimeArg || !wavArg || !expected)
  throw Error(
    "Usage: node packages/voice/test/consumer.mjs ASSET_DIRECTORY ONNX_WASM_MODULE SPEECH_WAV EXPECTED_TRANSCRIPT",
  );
const assets = path.resolve(assetsArg),
  runtime = path.resolve(runtimeArg),
  wavFile = path.resolve(wavArg);
const voice = path.resolve(import.meta.dirname, "../dist"),
  repository = path.resolve(import.meta.dirname, "../../..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(assets, "manifest.json")),
);
const output = testOutputPath("browser-speech-consumer");
const host = path.join(output, "host");
fs.mkdirSync(host, { recursive: true });
fs.writeFileSync(
  path.join(host, "index.html"),
  "<!doctype html><title>Voice consumer</title><button>Start</button>",
);
fs.writeFileSync(
  path.join(host, "worker.ts"),
  `import * as ort from '/@fs${runtime}';import {installSpeechWorker} from '/@fs${voice}/browser-speech/speech-worker.js';installSpeechWorker(self,ort);`,
);
const requests = [];
const server = await createServer({
  root: host,
  configFile: false,
  server: {
    host: "127.0.0.1",
    port: 0,
    fs: { allow: [repository, path.dirname(runtime)] },
  },
  plugins: [
    {
      name: "owned-speech-assets",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url, "http://localhost");
          if (url.pathname === "/speech/manifest.json") {
            const m = structuredClone(manifest);
            if (url.searchParams.has("tamper"))
              m.files.glue.path = "corrupt-glue.mjs";
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(m));
            return;
          }
          if (url.pathname === "/speech/corrupt-glue.mjs") {
            res.setHeader("Content-Type", "text/javascript");
            res.end("invalid glue");
            return;
          }
          for (const file of Object.values(manifest.files)) {
            if (url.pathname === "/speech/" + file.path) {
              res.setHeader(
                "Content-Type",
                file.path.endsWith(".mjs")
                  ? "text/javascript"
                  : "application/octet-stream",
              );
              fs.createReadStream(path.join(assets, file.path)).pipe(res);
              return;
            }
          }
          next();
        });
      },
    },
  ],
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
    const { BrowserAudioCapture } = await import("/@fs" + source);
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
  }, voice + "/browser-capture/audio-capture.js");
  console.log(JSON.stringify({ capture }));
  assert.equal(capture.retired, "AbortError");
  assert.equal(capture.ended, 0);
  assert.equal(capture.saved, true);
  assert.ok(capture.bytes > 0);
  const wav = fs.readFileSync(wavFile).toString("base64");
  const result = await page.evaluate(
    async ({ source, wav }) => {
      const { BrowserSpeechRecognizer } = await import(
        "/@fs" + source + "/browser-speech/speech-recognizer.js"
      );
      const { decodeRecordingPcm } = await import(
        "/@fs" + source + "/browser-capture/recording-pcm.js"
      );
      const signal = new AbortController().signal;
      const bytes = Uint8Array.from(atob(wav), (c) => c.charCodeAt(0));
      const samples = await decodeRecordingPcm(
        new Blob([bytes], { type: "audio/wav" }),
        signal,
      );
      const recognizer = new BrowserSpeechRecognizer({
        manifestUrl: () => location.origin + "/speech/manifest.json",
        createWorker: () => new Worker("/worker.ts", { type: "module" }),
      });
      try {
        return await recognizer.transcribe(samples, signal);
      } finally {
        recognizer.cancel();
      }
    },
    { source: voice, wav },
  );
  assert.equal(result.noSpeech, false);
  const normalized = (text) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  assert.equal(normalized(result.text), normalized(expected));
  const corruption = await page.evaluate(async (source) => {
    const { BrowserSpeechRecognizer } = await import(
      "/@fs" + source + "/browser-speech/speech-recognizer.js"
    );
    const engine = new BrowserSpeechRecognizer({
      manifestUrl: () => location.origin + "/speech/manifest.json?tamper=1",
      createWorker: () => new Worker("/worker.ts", { type: "module" }),
    });
    try {
      await engine.transcribe(
        new Float32Array(16000),
        new AbortController().signal,
      );
      return "incorrect success";
    } catch (e) {
      return e.code;
    } finally {
      engine.cancel();
    }
  }, voice);
  assert.equal(corruption, "model-load-failed");
  const summary = {
    capture,
    transcript: result,
    corruption,
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
