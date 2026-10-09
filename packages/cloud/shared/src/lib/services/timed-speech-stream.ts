import { ElizaError } from "@elizaos/core";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_CHARACTERS = 50000;
const MAX_FRAMES = 2048;
const invalid = () =>
  new ElizaError("Invalid timed speech response", {
    code: "TTS_TIMING_INVALID",
    severity: "ephemeral",
  });

interface Alignment {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
}
function alignment(value: unknown): Alignment | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") throw invalid();
  const data = value as Record<string, unknown>;
  const chars = data.characters;
  const starts = data.characterStartTimesSeconds;
  const ends = data.characterEndTimesSeconds;
  if (
    !Array.isArray(chars) ||
    !Array.isArray(starts) ||
    !Array.isArray(ends) ||
    chars.length > MAX_CHARACTERS ||
    chars.length !== starts.length ||
    chars.length !== ends.length
  )
    throw invalid();
  for (let i = 0; i < chars.length; i++) {
    if (
      typeof chars[i] !== "string" ||
      chars[i].length === 0 ||
      chars[i].length > 16 ||
      typeof starts[i] !== "number" ||
      typeof ends[i] !== "number" ||
      !Number.isFinite(starts[i]) ||
      !Number.isFinite(ends[i]) ||
      starts[i] < 0 ||
      ends[i] < starts[i] ||
      ends[i] > 3600 ||
      (i > 0 && (starts[i] < starts[i - 1] || ends[i] < ends[i - 1]))
    )
      throw invalid();
  }
  return {
    characters: [...chars],
    characterStartTimesSeconds: [...starts],
    characterEndTimesSeconds: [...ends],
  };
}

/** Bounded, demand-driven NDJSON. Alignment coordinates remain provider supplied;
 * clients must not invent offsets or word boundaries from audio byte lengths. */
export function createTimedSpeechStream(
  source: AsyncIterable<unknown>,
  abort: () => void,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let sequence = 0,
    audioBytes = 0,
    characters = 0;
  let closed = false;
  async function closeSource() {
    try {
      abort();
      await iterator.return?.();
    } catch {
      // Provider cleanup errors may include request text; keep the public
      // cancellation boundary as redacted as the read boundary.
      throw invalid();
    }
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const item = await iterator.next();
          if (closed) return;
          if (item.done) {
            if (audioBytes === 0) throw invalid();
            closed = true;
            controller.enqueue(
              encoder.encode(`${JSON.stringify({ type: "done", frames: sequence, audioBytes })}\n`),
            );
            controller.close();
            return;
          }
          if (++sequence > MAX_FRAMES || !item.value || typeof item.value !== "object")
            throw invalid();
          const value = item.value as Record<string, unknown>;
          const audio = value.audioBase64;
          if (
            typeof audio !== "string" ||
            audio.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 ||
            audio.length % 4 !== 0 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio)
          )
            throw invalid();
          audioBytes +=
            (audio.length / 4) * 3 - (audio.endsWith("==") ? 2 : audio.endsWith("=") ? 1 : 0);
          if (audioBytes > MAX_AUDIO_BYTES) throw invalid();
          const original = alignment(value.alignment);
          const normalized = alignment(value.normalizedAlignment);
          characters += (original?.characters.length ?? 0) + (normalized?.characters.length ?? 0);
          if (characters > MAX_CHARACTERS) throw invalid();
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: "audio", sequence: sequence - 1, audioBase64: audio, mimeType: "audio/mpeg", alignment: original, normalizedAlignment: normalized })}\n`,
            ),
          );
        } catch {
          if (closed) return;
          closed = true;
          try {
            await closeSource();
          } finally {
            controller.error(invalid());
          }
        }
      },
      async cancel() {
        closed = true;
        await closeSource();
      },
    },
    { highWaterMark: 0 },
  );
}
