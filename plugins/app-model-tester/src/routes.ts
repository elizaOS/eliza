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

function runtimeHasModel(
  runtime: IAgentRuntime,
  modelType: ModelTypeName,
): boolean {
  return (
    typeof runtime.getModel === "function" &&
    Boolean(runtime.getModel(modelType))
  );
}

function coerceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "text" in value) {
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
  if (
    samples === null ||
    typeof sampleRateHz !== "number" ||
    sampleRateHz <= 0
  ) {
    return null;
  }
  return { pcm: Float32Array.from(samples), sampleRateHz };
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
) {
  const chunks: string[] = [];
  const result = await runtime.useModel(modelType, {
    prompt,
    maxTokens: 160,
    temperature: 0.2,
    stream,
    onStreamChunk: (chunk: string) => chunks.push(chunk),
  });
  if (result !== null && typeof result === "object" && "textStream" in result) {
    for await (const chunk of (result as { textStream: AsyncIterable<string> })
      .textStream) {
      chunks.push(chunk);
    }
  }
  return { text: coerceText(result), chunks };
}

async function runModelTest(runtime: IAgentRuntime, body: ModelTestRequest) {
  const prompt =
    typeof body.prompt === "string" && body.prompt.trim()
      ? body.prompt.trim()
      : "Reply with one short sentence proving this model call worked.";

  switch (body.test) {
    case "text-small":
      return runText(runtime, ModelType.TEXT_SMALL, prompt, false);
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
      const result = await runtime.useModel(ModelType.IMAGE, {
        prompt,
        count: 1,
        size: "512x512",
      });
      return { images: result };
    }
    case "image-description": {
      if (!body.imageDataUrl) throw new Error("Choose an image first.");
      const result = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
        imageUrl: body.imageDataUrl,
        prompt: "Describe this image in concrete visual detail.",
      });
      return { description: coerceText(result), raw: result };
    }
    case "transcription": {
      const pcmPayload = toPcmPayload(body);
      const input = pcmPayload
        ? pcmPayload
        : body.audioDataUrl
          ? { audioUrl: body.audioDataUrl, prompt }
          : null;
      if (!input) throw new Error("Choose an audio file first.");
      const transcript = await runtime.useModel(ModelType.TRANSCRIPTION, input);
      return { transcript };
    }
    case "text-to-speech": {
      const result = await runtime.useModel(ModelType.TEXT_TO_SPEECH, {
        text: prompt,
      });
      return audioBytesToBase64(result);
    }
    case "vad": {
      const samples = readNumberArray(body.pcmSamples);
      if (samples === null || typeof body.sampleRateHz !== "number") {
        throw new Error("Choose an audio file first.");
      }
      return detectVoiceActivity(samples, body.sampleRateHz);
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
  if (!pathname.startsWith("/api/model-tester")) return false;

  if (method === "GET" && pathname === "/api/model-tester/status") {
    sendJson(res, 200, {
      tests: MODEL_TESTS.map((test) => ({
        ...test,
        available:
          test.modelType === "VAD"
            ? true
            : runtimeHasModel(runtime, test.modelType),
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
