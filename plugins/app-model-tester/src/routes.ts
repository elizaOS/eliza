import type http from "node:http";
import { readCompatJsonBody } from "@elizaos/app-core/api/compat-route-shared";
import { sendJson, sendJsonError } from "@elizaos/app-core/api/response";
import {
  type IAgentRuntime,
  ModelType,
  type ModelTypeName,
} from "@elizaos/core";

type TestKind =
  | "text-small"
  | "text-large"
  | "embedding"
  | "image"
  | "image-description"
  | "transcription"
  | "text-to-speech"
  | "vad";

interface ModelTestRequest {
  test?: TestKind;
  prompt?: string;
  imageDataUrl?: string;
  audioDataUrl?: string;
  pcmSamples?: number[];
  sampleRateHz?: number;
}

interface VadSegment {
  startMs: number;
  endMs: number;
  peakRms: number;
}

const MODEL_TESTS: Array<{
  id: TestKind;
  label: string;
  modelType: ModelTypeName | "VAD";
}> = [
  { id: "text-small", label: "Text small", modelType: ModelType.TEXT_SMALL },
  {
    id: "text-large",
    label: "Text large stream",
    modelType: ModelType.TEXT_LARGE,
  },
  { id: "embedding", label: "Embedding", modelType: ModelType.TEXT_EMBEDDING },
  { id: "image", label: "Image generation", modelType: ModelType.IMAGE },
  {
    id: "image-description",
    label: "Image description",
    modelType: ModelType.IMAGE_DESCRIPTION,
  },
  {
    id: "transcription",
    label: "Transcription",
    modelType: ModelType.TRANSCRIPTION,
  },
  {
    id: "text-to-speech",
    label: "Text to speech",
    modelType: ModelType.TEXT_TO_SPEECH,
  },
  { id: "vad", label: "Voice activity", modelType: "VAD" },
];

const DEFAULT_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAkCAYAAAA5DDySAAAApklEQVR4nO3YsRGAMAxD0axAw7EBK7AX87EXVDBCbMcg3/ELtbH0yrRpWe8/p6kLqAOAuoA6AKgLqAOAuoA6YYDtOLtRj3sFwDJ8BOLa59SkAkTGexHKAoyM9yCUBMgYb0UAoBpA5ngLAgAAAAAAAAAAAEAZgGyE3i0AKgJkIVjulAUYRbDeKA0QRfC8Xx7AAxF9+8vwK6wuoA4A6gLqAKAuoM7vAR7cS+fbY4yFJwAAAABJRU5ErkJggg==";

type LocalInferenceServices = Awaited<
  ReturnType<typeof importLocalInferenceServices>
>;

let localActivationPromise: Promise<LocalInferenceServices> | null = null;

async function importLocalInferenceServices() {
  return import("@elizaos/plugin-local-inference/services");
}

const MODEL_TESTER_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Eliza Model Tester</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#08090b; color:#f5f7fb; }
      body { margin:0; min-height:100vh; background:#08090b; }
      .shell { min-height:100vh; display:flex; flex-direction:column; }
      header { position:sticky; top:0; z-index:2; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 18px; border-bottom:1px solid #242833; background:#08090b; }
      h1 { margin:0; font-size:17px; line-height:1.2; }
      .sub { margin-top:4px; color:#9ba3b4; font-size:12px; }
      button { border:1px solid #3a4050; background:#161a22; color:#f5f7fb; border-radius:8px; padding:8px 11px; font-weight:650; cursor:pointer; }
      button:hover { background:#202634; }
      button:disabled { opacity:.55; cursor:not-allowed; }
      main { display:grid; grid-template-columns:minmax(260px,340px) 1fr; gap:16px; padding:16px; max-width:1400px; width:100%; box-sizing:border-box; margin:0 auto; }
      aside, section { border:1px solid #242833; background:#10131a; border-radius:8px; padding:14px; }
      textarea { width:100%; min-height:120px; box-sizing:border-box; resize:vertical; border:1px solid #343a48; border-radius:8px; background:#08090b; color:#f5f7fb; padding:10px; font:inherit; }
      label.file { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:10px; border:1px solid #343a48; border-radius:8px; padding:11px; cursor:pointer; color:#dbe1ee; }
      input[type=file] { display:none; }
      .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
      .card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
      h2 { margin:0; font-size:14px; }
      .model { margin-top:7px; color:#9ba3b4; font:12px ui-monospace, SFMono-Regular, Menlo, monospace; }
      .providers { margin-top:5px; color:#697286; font-size:12px; line-height:1.35; overflow-wrap:anywhere; }
      .pill { border:1px solid #3a4050; color:#9ba3b4; border-radius:999px; padding:4px 8px; font-size:12px; white-space:nowrap; }
      .pill.ready { border-color:#277a55; color:#7be0af; background:#0f2a20; }
      pre { margin:12px 0 0; max-height:260px; overflow:auto; border:1px solid #242833; border-radius:8px; background:#08090b; color:#c5ccda; padding:10px; font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; }
      audio, img.preview { margin-top:12px; width:100%; border-radius:8px; }
      img.preview { max-height:260px; object-fit:cover; border:1px solid #242833; }
      .error { color:#ff8b8b; font-size:12px; margin-top:10px; }
      @media (max-width: 860px) { main { grid-template-columns:1fr; } .grid { grid-template-columns:1fr; } }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <div><h1>Model Tester</h1><div class="sub">End-to-end Eliza-1 text, voice, audio, and vision probes</div></div>
        <div><button id="refresh">Refresh</button> <button id="run-all">Run all</button></div>
      </header>
      <main>
        <aside>
          <textarea id="prompt">Say exactly one short sentence about the Eliza-1 model tester working.</textarea>
          <label class="file">Image <span id="image-name">Choose image</span><input id="image-file" type="file" accept="image/*"></label>
          <label class="file">Audio <span id="audio-name">Choose audio</span><input id="audio-file" type="file" accept="audio/*"></label>
          <div id="asset-error" class="error"></div>
        </aside>
        <div id="cards" class="grid"></div>
      </main>
    </div>
    <script>
      const tests = ["text-small","text-large","embedding","text-to-speech","transcription","vad","image-description","image"];
      let statuses = [];
      let imageDataUrl = null;
      let audioPayload = null;
      const el = (id) => {
        const node = document.getElementById(id);
        if (!node) throw new Error("Missing #" + id);
        return node;
      };
      const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] || ch);
      const fileToDataUrl = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error("File read failed"));
        reader.readAsDataURL(file);
      });
      async function audioFileToPayload(file) {
        const audioDataUrl = await fileToDataUrl(file);
        const buffer = await file.arrayBuffer();
        const context = new AudioContext();
        const decoded = await context.decodeAudioData(buffer.slice(0));
        const src = decoded.getChannelData(0);
        const targetRate = 16000;
        const ratio = decoded.sampleRate / targetRate;
        const length = Math.min(targetRate * 15, Math.floor(src.length / ratio));
        const pcmSamples = Array.from({ length }, (_, i) => src[Math.floor(i * ratio)] || 0);
        await context.close();
        return { audioDataUrl, pcmSamples, sampleRateHz: targetRate };
      }
      function statusFor(id) {
        return statuses.find((status) => status.id === id);
      }
      function renderCards() {
        el("cards").innerHTML = tests.map((id) => {
          const status = statusFor(id) || {};
          const ready = status.available || id === "vad";
          const providers = status.providers && status.providers.length ? status.providers.join(", ") : "no provider registered";
          return '<section id="card-' + id + '">' +
            '<div class="card-head"><div><h2>' + escapeHtml(status.label || id) + '</h2><div class="model">' + escapeHtml(status.modelType || id) + '</div><div class="providers">' + escapeHtml(providers) + '</div></div>' +
            '<span class="pill ' + (ready ? "ready" : "") + '">' + (ready ? "Registered" : "Missing") + '</span></div>' +
            '<button data-run="' + id + '" style="margin-top:12px">Run</button><div id="out-' + id + '"><pre>No output yet.</pre></div></section>';
        }).join("");
        document.querySelectorAll("[data-run]").forEach((button) => {
          button.addEventListener("click", () => runTest(button.dataset.run || ""));
        });
      }
      function renderOutput(id, value) {
        const box = el("out-" + id);
        const output = value.ok ? value.output : value.error;
        let audio = "";
        if (value.ok && id === "text-to-speech" && output && typeof output === "object") {
          audio = '<audio controls src="data:' + (output.contentType || "audio/wav") + ';base64,' + (output.base64 || "") + '"></audio>';
        }
        let images = "";
        if (value.ok && id === "image" && output && typeof output === "object") {
          images = (output.images || []).map((img) => img.url ? '<img class="preview" src="' + img.url + '" alt="">' : "").join("");
        }
        box.innerHTML = audio + images + "<pre>" + escapeHtml(JSON.stringify(value, null, 2)) + "</pre>";
      }
      async function refresh() {
        const response = await fetch("/api/model-tester/status", { cache: "no-store" });
        statuses = (await response.json()).tests || [];
        renderCards();
      }
      async function runTest(id) {
        const button = document.querySelector('[data-run="' + id + '"]');
        if (button) button.disabled = true;
        el("out-" + id).innerHTML = "<pre>Running...</pre>";
        try {
          const response = await fetch("/api/model-tester/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              test: id,
              prompt: el("prompt").value,
              imageDataUrl,
              audioDataUrl: audioPayload && audioPayload.audioDataUrl,
              pcmSamples: audioPayload && audioPayload.pcmSamples,
              sampleRateHz: audioPayload && audioPayload.sampleRateHz
            })
          });
          renderOutput(id, await response.json());
        } catch (error) {
          renderOutput(id, { ok: false, test: id, error: error instanceof Error ? error.message : String(error) });
        } finally {
          if (button) button.disabled = false;
        }
      }
      el("refresh").addEventListener("click", refresh);
      el("run-all").addEventListener("click", async () => {
        for (const id of tests) await runTest(id);
      });
      el("image-file").addEventListener("change", async (event) => {
        const file = event.currentTarget.files && event.currentTarget.files[0];
        if (!file) return;
        imageDataUrl = await fileToDataUrl(file);
        el("image-name").textContent = file.name;
      });
      el("audio-file").addEventListener("change", async (event) => {
        const file = event.currentTarget.files && event.currentTarget.files[0];
        if (!file) return;
        try {
          audioPayload = await audioFileToPayload(file);
          el("audio-name").textContent = file.name;
          el("asset-error").textContent = "";
        } catch (error) {
          el("asset-error").textContent = error instanceof Error ? error.message : String(error);
        }
      });
      refresh();
    </script>
  </body>
</html>`;

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(html);
}

function runtimeHasModel(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
): boolean {
  return (
    typeof runtime.getModel === "function" &&
    Boolean(runtime.getModel(modelType))
  );
}

function runtimeModelProviders(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
): string[] {
  const models = (runtime as { models?: unknown }).models;
  if (!(models instanceof Map)) return [];
  const registrations = models.get(modelType);
  if (!Array.isArray(registrations)) return [];
  return registrations
    .map((entry) =>
      entry && typeof entry === "object"
        ? (entry as { provider?: unknown }).provider
        : null,
    )
    .filter((provider): provider is string => typeof provider === "string");
}

function coerceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value) {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return JSON.stringify(value, null, 2);
}

function detectAudioContentType(bytes: Uint8Array): string {
  const head = new TextDecoder().decode(bytes.slice(0, 4));
  if (head === "RIFF") return "audio/wav";
  if (head === "OggS") return "audio/ogg";
  if (head === "ID3" || bytes[0] === 0xff) return "audio/mpeg";
  return "application/octet-stream";
}

function audioBytesToBase64(value: unknown): {
  base64: string;
  byteLength: number;
  contentType: string;
} {
  if (value instanceof Uint8Array) {
    const bytes = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
    return {
      base64: Buffer.from(bytes).toString("base64"),
      byteLength: value.byteLength,
      contentType: detectAudioContentType(bytes),
    };
  }
  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);
    return {
      base64: Buffer.from(value).toString("base64"),
      byteLength: value.byteLength,
      contentType: detectAudioContentType(bytes),
    };
  }
  throw new Error("TEXT_TO_SPEECH returned non-audio output");
}

function readNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return null;
    out.push(Math.max(-1, Math.min(1, item)));
  }
  return out;
}

function toPcmPayload(body: ModelTestRequest): {
  pcm: Float32Array;
  sampleRateHz: number;
} | null {
  const samples = readNumberArray(body.pcmSamples);
  const sampleRateHz = body.sampleRateHz;
  if (!samples || typeof sampleRateHz !== "number" || sampleRateHz <= 0) {
    return null;
  }
  return { pcm: Float32Array.from(samples), sampleRateHz };
}

function makeDefaultAudioPayload(): {
  pcm: Float32Array;
  sampleRateHz: number;
  wav: Buffer;
} {
  const sampleRateHz = 16_000;
  const sampleCount = sampleRateHz;
  const wav = Buffer.alloc(44 + sampleCount * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + sampleCount * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRateHz, 24);
  wav.writeUInt32LE(sampleRateHz * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(sampleCount * 2, 40);

  const pcm = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRateHz) * 0.18;
    pcm[i] = sample;
    wav.writeInt16LE(
      Math.round(Math.max(-1, Math.min(1, sample)) * 32767),
      44 + i * 2,
    );
  }

  return { pcm, sampleRateHz, wav };
}

function dataUrlToBytes(dataUrl: string): {
  bytes: Buffer;
  mimeType: string;
} | null {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/i.exec(
    dataUrl,
  );
  if (!match) return null;
  return {
    bytes: Buffer.from(match[2] ?? "", "base64"),
    mimeType: match[1] || "application/octet-stream",
  };
}

function dataUrlToBuffer(dataUrl: string): Buffer | null {
  return dataUrlToBytes(dataUrl)?.bytes ?? null;
}

function decodePcm16Wav(bytes: Uint8Array): {
  pcm: Float32Array;
  sampleRate: number;
} {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Expected a RIFF/WAV audio buffer");
  }
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  if (bitsPerSample !== 16) {
    throw new Error(`Expected 16-bit PCM WAV, got ${bitsPerSample}-bit audio`);
  }

  let dataOffset = 12;
  let dataSize = 0;
  while (dataOffset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", dataOffset, dataOffset + 4);
    const chunkSize = buffer.readUInt32LE(dataOffset + 4);
    if (chunkId === "data") {
      dataOffset += 8;
      dataSize = chunkSize;
      break;
    }
    dataOffset += 8 + chunkSize + (chunkSize % 2);
  }
  if (!dataSize) throw new Error("WAV audio does not contain a data chunk");

  const sampleCount = Math.floor(dataSize / 2);
  const pcm = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    pcm[i] = buffer.readInt16LE(dataOffset + i * 2) / 32768;
  }
  return { pcm, sampleRate };
}

async function ensureLocalEngineActive(
  runtime: IAgentRuntime,
): Promise<LocalInferenceServices> {
  const services = await importLocalInferenceServices();
  if (
    services.localInferenceEngine.hasLoadedModel() &&
    services.localInferenceService.getActive().status === "ready"
  ) {
    return services;
  }

  if (localActivationPromise) return localActivationPromise;

  localActivationPromise = (async () => {
    const assignments = await services.localInferenceService.getAssignments();
    const modelId =
      assignments.TEXT_SMALL ??
      assignments.TEXT_LARGE ??
      assignments.TEXT_TO_SPEECH ??
      assignments.TRANSCRIPTION;
    const installed = await services.localInferenceService.getInstalled();
    const fallback = installed.find((model) => model.id.startsWith("eliza-1-"));
    const targetModelId = modelId ?? fallback?.id;
    if (!targetModelId) {
      throw new Error("No installed Eliza-1 local inference bundle was found.");
    }

    await services.localInferenceService.setActive(
      runtime as never,
      targetModelId,
      {
        contextSize: 4096,
        gpuLayers: 0,
      },
    );
    if (!services.localInferenceEngine.hasLoadedModel()) {
      throw new Error(`Eliza-1 bundle did not become active: ${targetModelId}`);
    }
    return services;
  })();

  try {
    return await localActivationPromise;
  } finally {
    localActivationPromise = null;
  }
}

async function tryLocalTextToSpeech(
  runtime: IAgentRuntime,
  text: string,
): Promise<{
  base64: string;
  byteLength: number;
  contentType: string;
  provider: string;
}> {
  const services = await ensureLocalEngineActive(runtime);
  await services.localInferenceEngine.ensureActiveBundleVoiceReady();
  const result = await services.localInferenceEngine.synthesizeSpeech(text);
  return {
    ...audioBytesToBase64(result),
    provider: "eliza-local-inference/direct",
  };
}

async function tryLocalTranscription(
  runtime: IAgentRuntime,
  pcmPayload: { pcm: Float32Array; sampleRateHz: number } | null,
  prompt: string,
): Promise<{
  transcript: string;
  provider: string;
  source: string;
}> {
  const services = await ensureLocalEngineActive(runtime);
  await services.localInferenceEngine.ensureActiveBundleVoiceReady();
  let audio = pcmPayload
    ? { pcm: pcmPayload.pcm, sampleRate: pcmPayload.sampleRateHz }
    : null;
  let source = "uploaded-or-default-pcm";
  if (!audio) {
    const spoken = await services.localInferenceEngine.synthesizeSpeech(prompt);
    audio = decodePcm16Wav(spoken);
    source = "local-tts-loopback";
  }
  const transcript = await services.localInferenceEngine.transcribePcm(audio);
  return {
    transcript,
    provider: "eliza-local-inference/direct",
    source,
  };
}

async function tryLocalImageDescription(
  runtime: IAgentRuntime,
  imageDataUrl: string,
): Promise<{
  description: string;
  raw: unknown;
  provider: string;
}> {
  const services = await ensureLocalEngineActive(runtime);
  const image = dataUrlToBytes(imageDataUrl);
  if (!image) throw new Error("Could not decode image data URL");
  const result = await services.localInferenceEngine.describeImage({
    bytes: image.bytes,
    mimeType: image.mimeType,
    prompt: "Describe this image in concrete visual detail.",
    maxTokens: 160,
    temperature: 0.1,
  });
  return {
    description: result.text,
    raw: result,
    provider: "eliza-local-inference/direct",
  };
}

async function tryLocalImageGeneration(
  runtime: IAgentRuntime,
  prompt: string,
): Promise<{
  images: Array<{ url: string }>;
  provider: string;
}> {
  const services = await ensureLocalEngineActive(runtime);
  const arbiter = services.localInferenceService.getMemoryArbiter();
  const result = await arbiter.requestImageGen<
    {
      prompt: string;
      width: number;
      height: number;
      steps: number;
      guidanceScale: number;
    },
    { image: Uint8Array; mime?: string }
  >({
    modelKey: "imagegen-sd-1_5-q5_0",
    payload: {
      prompt,
      width: 512,
      height: 512,
      steps: 8,
      guidanceScale: 7,
    },
  });
  const mime = result.mime === "image/jpeg" ? "image/jpeg" : "image/png";
  return {
    images: [
      {
        url: `data:${mime};base64,${Buffer.from(result.image).toString("base64")}`,
      },
    ],
    provider: "eliza-local-inference/direct",
  };
}

function summarizeAttemptError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detectVoiceActivity(
  samples: number[],
  sampleRateHz: number,
): {
  segments: VadSegment[];
  activeMs: number;
  totalMs: number;
  peakRms: number;
  frameCount: number;
} {
  const frameMs = 32;
  const frameSize = Math.max(1, Math.round((sampleRateHz * frameMs) / 1000));
  const riseThreshold = 0.012;
  const fallThreshold = riseThreshold * 0.6;
  const fallHoldMs = 200;
  const segments: VadSegment[] = [];
  let activeStart: number | null = null;
  let quietSince: number | null = null;
  let peak = 0;
  let activeMs = 0;
  let frameCount = 0;

  for (let offset = 0; offset < samples.length; offset += frameSize) {
    let sum = 0;
    const end = Math.min(samples.length, offset + frameSize);
    for (let i = offset; i < end; i += 1) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / Math.max(1, end - offset));
    const ts = (offset / sampleRateHz) * 1000;
    peak = Math.max(peak, rms);
    frameCount += 1;

    if (activeStart === null) {
      if (rms >= riseThreshold) {
        activeStart = ts;
        quietSince = null;
      }
      continue;
    }

    activeMs += frameMs;
    if (rms < fallThreshold) {
      quietSince ??= ts;
      if (ts - quietSince >= fallHoldMs) {
        segments.push({
          startMs: Math.round(activeStart),
          endMs: Math.round(ts),
          peakRms: Number(peak.toFixed(4)),
        });
        activeStart = null;
        quietSince = null;
        peak = 0;
      }
    } else {
      quietSince = null;
    }
  }

  if (activeStart !== null) {
    segments.push({
      startMs: Math.round(activeStart),
      endMs: Math.round((samples.length / sampleRateHz) * 1000),
      peakRms: Number(peak.toFixed(4)),
    });
  }

  return {
    segments,
    activeMs: Math.round(activeMs),
    totalMs: Math.round((samples.length / sampleRateHz) * 1000),
    peakRms: Number(peak.toFixed(4)),
    frameCount,
  };
}

async function runText(
  runtime: IAgentRuntime,
  modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE,
  prompt: string,
  stream: boolean,
  provider?: string,
) {
  const chunks: string[] = [];
  const result = await runtime.useModel(
    modelType,
    {
      prompt,
      maxTokens: 160,
      temperature: 0.2,
      stream,
      onStreamChunk: (chunk: string) => {
        chunks.push(chunk);
      },
    },
    provider,
  );
  if (result && typeof result === "object" && "textStream" in result) {
    for await (const chunk of (result as { textStream: AsyncIterable<string> })
      .textStream) {
      chunks.push(chunk);
    }
  }
  return { text: coerceText(result), chunks, provider: provider ?? "default" };
}

async function runModelTest(runtime: IAgentRuntime, body: ModelTestRequest) {
  const prompt =
    typeof body.prompt === "string" && body.prompt.trim()
      ? body.prompt.trim()
      : "Reply with one short sentence proving this model call worked.";

  switch (body.test) {
    case "text-small": {
      const attempts: string[] = [];
      for (const provider of [undefined, "anthropic", "openai"]) {
        try {
          return await runText(
            runtime,
            ModelType.TEXT_SMALL,
            prompt,
            false,
            provider,
          );
        } catch (error) {
          attempts.push(
            `${provider ?? "default"}: ${summarizeAttemptError(error)}`,
          );
        }
      }
      throw new Error(`All TEXT_SMALL providers failed:\n${attempts.join("\n")}`);
    }
    case "text-large":
      return runText(runtime, ModelType.TEXT_LARGE, prompt, true);
    case "embedding": {
      const vector = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
        text: prompt,
      });
      return {
        dimensions: Array.isArray(vector) ? vector.length : 0,
        preview: Array.isArray(vector) ? vector.slice(0, 8) : vector,
      };
    }
    case "image": {
      const attempts: string[] = [];
      try {
        const result = await tryLocalImageGeneration(runtime, prompt);
        return { ...result, attempts };
      } catch (error) {
        attempts.push(
          `eliza-local-inference/direct: ${summarizeAttemptError(error)}`,
        );
      }
      for (const provider of [undefined, "openai"]) {
        try {
          const result = await runtime.useModel(
            ModelType.IMAGE,
            {
              prompt,
              count: 1,
              size: "512x512",
            },
            provider,
          );
          return { images: result, provider: provider ?? "default", attempts };
        } catch (error) {
          attempts.push(
            `${provider ?? "default"}: ${summarizeAttemptError(error)}`,
          );
        }
      }
      throw new Error(
        `All IMAGE providers failed:\n${attempts.join("\n")}`,
      );
    }
    case "image-description": {
      const imageDataUrl = body.imageDataUrl ?? DEFAULT_IMAGE_DATA_URL;
      const attempts: string[] = [];
      try {
        const result = await tryLocalImageDescription(runtime, imageDataUrl);
        return { ...result, attempts };
      } catch (error) {
        attempts.push(
          `eliza-local-inference/direct: ${summarizeAttemptError(error)}`,
        );
      }
      for (const provider of [undefined, "anthropic", "openai"]) {
        try {
          const result = await runtime.useModel(
            ModelType.IMAGE_DESCRIPTION,
            {
              imageUrl: imageDataUrl,
              prompt: "Describe this image in concrete visual detail.",
            },
            provider,
          );
          return {
            description: coerceText(result),
            raw: result,
            provider: provider ?? "default",
            attempts,
          };
        } catch (error) {
          attempts.push(
            `${provider ?? "default"}: ${summarizeAttemptError(error)}`,
          );
        }
      }
      throw new Error(
        `All IMAGE_DESCRIPTION providers failed:\n${attempts.join("\n")}`,
      );
    }
    case "transcription": {
      const defaultAudio = makeDefaultAudioPayload();
      const pcmPayload = toPcmPayload(body);
      const audioDataUrl =
        typeof body.audioDataUrl === "string" ? body.audioDataUrl : null;
      const audioBuffer = audioDataUrl
        ? dataUrlToBuffer(audioDataUrl)
        : defaultAudio.wav;
      const attempts: string[] = [];

      try {
        const transcript = await tryLocalTranscription(
          runtime,
          pcmPayload,
          "model tester audio",
        );
        return { ...transcript, attempts };
      } catch (error) {
        attempts.push(
          `eliza-local-inference/direct: ${summarizeAttemptError(error)}`,
        );
      }

      if (audioBuffer) {
        for (const provider of ["elizacloud", "openai"]) {
          try {
            const transcript = await runtime.useModel(
              ModelType.TRANSCRIPTION,
              audioBuffer,
              provider,
            );
            return { transcript, provider, attempts };
          } catch (error) {
            attempts.push(`${provider}: ${summarizeAttemptError(error)}`);
          }
        }
      }

      if (pcmPayload) {
        try {
          const transcript = await runtime.useModel(
            ModelType.TRANSCRIPTION,
            pcmPayload as never,
          );
          return { transcript, provider: "default", attempts };
        } catch (error) {
          attempts.push(`default: ${summarizeAttemptError(error)}`);
        }
      }

      if (audioBuffer) {
        try {
          const transcript = await runtime.useModel(ModelType.TRANSCRIPTION, {
            audio: audioBuffer,
            mimeType: "audio/wav",
          } as never);
          return { transcript, provider: "default-audio-buffer", attempts };
        } catch (error) {
          attempts.push(
            `default-audio-buffer: ${summarizeAttemptError(error)}`,
          );
        }
      }

      throw new Error(
        attempts.length
          ? `All transcription providers failed:\n${attempts.join("\n")}`
          : "No transcription input could be prepared.",
      );
    }
    case "text-to-speech": {
      const attempts: string[] = [];
      try {
        const result = await tryLocalTextToSpeech(runtime, prompt);
        return { ...result, attempts };
      } catch (error) {
        attempts.push(
          `eliza-local-inference/direct: ${summarizeAttemptError(error)}`,
        );
      }
      for (const provider of ["openai", undefined]) {
        try {
          const result = await runtime.useModel(
            ModelType.TEXT_TO_SPEECH,
            {
              text: prompt,
            },
            provider,
          );
          return {
            ...audioBytesToBase64(result),
            provider: provider ?? "default",
            attempts,
          };
        } catch (error) {
          attempts.push(
            `${provider ?? "default"}: ${summarizeAttemptError(error)}`,
          );
        }
      }
      throw new Error(
        `All TEXT_TO_SPEECH providers failed:\n${attempts.join("\n")}`,
      );
    }
    case "vad": {
      const defaultAudio = makeDefaultAudioPayload();
      const samples = readNumberArray(body.pcmSamples);
      return detectVoiceActivity(
        samples ?? Array.from(defaultAudio.pcm),
        typeof body.sampleRateHz === "number"
          ? body.sampleRateHz
          : defaultAudio.sampleRateHz,
      );
    }
    default:
      throw new Error("Unknown model tester action.");
  }
}

export async function handleModelTesterRoute(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  runtime: IAgentRuntime,
): Promise<boolean> {
  if (method === "GET" && pathname === "/model-tester") {
    sendHtml(res, 200, MODEL_TESTER_HTML);
    return true;
  }

  if (!pathname.startsWith("/api/model-tester")) return false;

  if (method === "GET" && pathname === "/api/model-tester/status") {
    sendJson(res, 200, {
      tests: MODEL_TESTS.map((test) => ({
        ...test,
        available:
          test.modelType === "VAD"
            ? true
            : runtimeHasModel(runtime, test.modelType),
        providers:
          test.modelType === "VAD"
            ? ["browser-vad"]
            : runtimeModelProviders(runtime, test.modelType),
      })),
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/model-tester/run") {
    const body = (await readCompatJsonBody(
      _req,
      res,
    )) as ModelTestRequest | null;
    if (!body) return true;
    try {
      const startedAt = Date.now();
      const output = await runModelTest(runtime, body);
      sendJson(res, 200, {
        ok: true,
        test: body.test,
        durationMs: Date.now() - startedAt,
        output,
      });
    } catch (error) {
      sendJson(res, 200, {
        ok: false,
        test: body.test,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  sendJsonError(res, 404, "Unknown model tester route");
  return true;
}
