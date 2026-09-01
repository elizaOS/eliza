/**
 * Gandr TTS synthesis for the cloud voice route: calls Gandr's OpenAI
 * compatible speech endpoint and returns either the MP3 byte stream (default
 * clients) or a finished WAV built from the raw PCM output (codec-less
 * clients such as the LP3, which has no MP3 decoder).
 *
 * Why this exists: Gandr speaks the OpenAI `/v1/audio/speech` contract over
 * plain HTTPS, so unlike the Cartesia path there is no WebSocket adapter to
 * drive. The MP3 lane streams the response body straight through, mirroring
 * `synthesizeCartesiaBytes`. The WAV lane requests `response_format: "pcm"`
 * (Gandr's PCM output is headerless s16le mono at 24000 Hz), drains it under
 * a byte cap, and wraps it with the shared pcm16 helpers. Both lanes throw
 * typed errors so the route answers with an honest provider failure instead
 * of broken audio.
 */
import { drainPcm16ToWav } from "../../../../shared/src/lib/services/pcm16-wav";

const GANDR_SPEECH_URL = "https://tts.gandr.ai/v1/audio/speech";
const GANDR_MODEL_ID = "tts-1";

/** Sample rate of Gandr's headerless s16le mono PCM output (Hz). */
export const GANDR_PCM_SAMPLE_RATE = 24_000;

/**
 * Gandr accepts up to 2000 characters per request. The route rejects longer
 * texts on the Gandr lane with an explicit 400 before safety and admission,
 * because truncated speech must never be served as success.
 */
export const GANDR_MAX_INPUT_CHARS = 2000;

/**
 * Wall-clock ceiling for one Gandr request, applied to the fetch and the body
 * drain. Input caps at {@link GANDR_MAX_INPUT_CHARS}, so a healthy synthesis
 * finishes well inside this; the signal exists so a stalled upstream cannot
 * pin the Worker request open (same reasoning as the Kokoro lane's 30s
 * timeout and the Cartesia WAV deadline).
 */
const GANDR_REQUEST_TIMEOUT_MS = 30_000;

export type GandrRestErrorClassification =
  | "rate_limit"
  | "quota"
  | "auth"
  | "bad_request"
  | "provider_unavailable";

export class GandrRestTtsError extends Error {
  constructor(
    readonly status: number,
    readonly classification: GandrRestErrorClassification,
    readonly safeProviderMessage: string,
  ) {
    super(safeProviderMessage);
    this.name = "GandrRestTtsError";
  }
}

export interface GandrBytesResult {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentType: string;
  readonly provider: "gandr";
  readonly modelId: typeof GANDR_MODEL_ID;
}

export interface GandrWavResult {
  readonly wav: Uint8Array<ArrayBuffer>;
  readonly totalMs: number;
}

async function requestGandrSpeech(args: {
  apiKey: string;
  voice: string;
  text: string;
  responseFormat: "mp3" | "pcm";
  fetch?: typeof fetch;
}): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | null }> {
  const fetchImpl = args.fetch ?? fetch;
  const response = await fetchImpl(GANDR_SPEECH_URL, {
    method: "POST",
    headers: {
      // Gandr authenticates with a standard OpenAI-style bearer token.
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GANDR_MODEL_ID,
      input: args.text,
      voice: args.voice,
      response_format: args.responseFormat,
    }),
    signal: AbortSignal.timeout(GANDR_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok || !response.body) {
    throw new GandrRestTtsError(
      response.status,
      classifyGandrRestFailure(response.status),
      safeGandrRestMessage(response.status),
    );
  }

  return {
    body: response.body,
    contentType: response.headers.get("Content-Type"),
  };
}

/**
 * Synthesize `text` as MP3 and stream the response body through unchanged.
 * Throws a typed {@link GandrRestTtsError} on any non-2xx or bodyless
 * response so the route can map it to a safe client-facing status.
 */
export async function synthesizeGandrBytes(args: {
  apiKey: string;
  voice: string;
  text: string;
  fetch?: typeof fetch;
}): Promise<GandrBytesResult> {
  const { body, contentType } = await requestGandrSpeech({
    apiKey: args.apiKey,
    voice: args.voice,
    text: args.text,
    responseFormat: "mp3",
    ...(args.fetch ? { fetch: args.fetch } : {}),
  });
  return {
    body,
    contentType: contentType ?? "audio/mpeg",
    provider: "gandr",
    modelId: GANDR_MODEL_ID,
  };
}

/**
 * Synthesize `text` as raw PCM and return a finished 16-bit PCM WAV. The
 * drain throws on empty output and on `maxPcmBytes` overflow, so the caller
 * never serves truncated or silent audio as success.
 */
export async function synthesizeGandrWav(args: {
  apiKey: string;
  voice: string;
  text: string;
  maxPcmBytes: number;
  fetch?: typeof fetch;
}): Promise<GandrWavResult> {
  const started = Date.now();
  const { body } = await requestGandrSpeech({
    apiKey: args.apiKey,
    voice: args.voice,
    text: args.text,
    responseFormat: "pcm",
    ...(args.fetch ? { fetch: args.fetch } : {}),
  });
  const wav = await drainPcm16ToWav(
    body,
    args.maxPcmBytes,
    GANDR_PCM_SAMPLE_RATE,
  );
  return { wav, totalMs: Date.now() - started };
}

function classifyGandrRestFailure(
  status: number,
): GandrRestErrorClassification {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 404 || status === 422) return "bad_request";
  if (status === 402) return "quota";
  return "provider_unavailable";
}

function safeGandrRestMessage(status: number): string {
  if (status === 429) {
    return "Gandr text-to-speech is rate limited or quota constrained. Please try again later.";
  }
  if (status === 401 || status === 403) {
    return "Gandr text-to-speech authentication failed. Check the configured API key.";
  }
  if (status === 402) {
    return "Gandr text-to-speech quota is exhausted.";
  }
  if (status === 400 || status === 404 || status === 422) {
    return "Gandr text-to-speech rejected the request.";
  }
  return "Gandr text-to-speech is unavailable.";
}
