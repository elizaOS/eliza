import { fileURLToPath } from "node:url";
import { StandaloneSpeechService } from "./standalone-speech-service";

/** Longest utterance the ASR worker accepts. */
export const MAX_ASR_SECONDS = 60;

/** A request audio failure with the HTTP status and code the route returns. */
export class AsrAudioError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/**
 * Read a mono PCM16 WAV at 8–48 kHz. Returns the little-endian samples and the
 * sample rate. Rejects other formats, empty or over-long audio and digital
 * silence.
 */
export function readMonoPcm16Wav(bytes: Buffer): {
  samples: Buffer;
  sampleRate: number;
} {
  if (
    bytes.length < 44 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    throw new AsrAudioError(422, "invalid_pcm_wav");
  let sampleRate = 0;
  let samples: Buffer | undefined;
  for (let offset = 12; offset < bytes.length; ) {
    if (offset + 8 > bytes.length)
      throw new AsrAudioError(422, "invalid_pcm_wav");
    const length = bytes.readUInt32LE(offset + 4),
      begin = offset + 8,
      end = begin + length;
    if (end > bytes.length) throw new AsrAudioError(422, "invalid_pcm_wav");
    const kind = bytes.toString("ascii", offset, offset + 4);
    if (kind === "fmt ") {
      const rate = length >= 16 ? bytes.readUInt32LE(begin + 4) : 0;
      if (
        sampleRate ||
        length < 16 ||
        bytes.readUInt16LE(begin) !== 1 ||
        bytes.readUInt16LE(begin + 2) !== 1 ||
        rate < 8000 ||
        rate > 48000 ||
        bytes.readUInt32LE(begin + 8) !== rate * 2 ||
        bytes.readUInt16LE(begin + 12) !== 2 ||
        bytes.readUInt16LE(begin + 14) !== 16
      )
        throw new AsrAudioError(422, "requires_mono_pcm16");
      sampleRate = rate;
    }
    if (kind === "data") {
      if (samples) throw new AsrAudioError(422, "invalid_pcm_wav");
      samples = bytes.subarray(begin, end);
    }
    offset = end + (length % 2);
  }
  if (
    !sampleRate ||
    !samples?.length ||
    samples.length % 2 ||
    samples.length > MAX_ASR_SECONDS * sampleRate * 2
  )
    throw new AsrAudioError(422, "audio_duration_invalid");
  let nonzero = false;
  for (let i = 0; i < samples.length; i += 2)
    if (samples.readInt16LE(i) !== 0) {
      nonzero = true;
      break;
    }
  if (!nonzero) throw new AsrAudioError(422, "no_speech");
  return { samples, sampleRate };
}

/**
 * Speech recognition through `host-asr-worker` on libelizainference, with no
 * text model loaded: Phonon-2 (Parakeet-TDT) when ELIZA_ASR_MODEL_DIR has
 * `asr/phonon-2-fv5.gguf`, otherwise the Qwen3-ASR-0.6B pair.
 */
export class StandaloneAsrService extends StandaloneSpeechService<string> {
  protected readonly environment = [
    "ELIZA_INFERENCE_LIBRARY",
    "ELIZA_INFERENCE_LIBRARY_SHA256",
    "ELIZA_ASR_MODEL_DIR",
  ];
  protected readonly failure = "Speech transcription failed";
  protected readonly deadlineMs = 90_000;
  protected readonly maxResultBytes = 64_000;
  protected workerPath() {
    return fileURLToPath(
      import.meta.resolve("@elizaos/plugin-local-inference/host-asr-worker"),
    );
  }
  protected decode(value: Record<string, unknown>) {
    if (typeof value.text !== "string" || value.text.length > 16_000)
      throw Error("Invalid transcript");
    return value.text;
  }
  /** Transcribe little-endian mono PCM16 samples. */
  transcribe(
    id: string,
    samples: Buffer,
    sampleRate: number,
    signal: AbortSignal,
  ) {
    return this.request(
      id,
      {
        op: "transcribe",
        pcm: samples.toString("base64"),
        encoding: "s16",
        sampleRate,
      },
      signal,
    );
  }
}
