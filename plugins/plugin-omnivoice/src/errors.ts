/**
 * Error types for plugin-omnivoice. Specific subclasses make planner-side
 * recovery (e.g. "fallback to cloud TTS when omnivoice missing") trivial.
 */

export const BUILD_INSTRUCTIONS = [
  "libomnivoice shared library not found.",
  "Build it with:",
  "  node packages/inference/build-omnivoice.mjs",
  "Then set OMNIVOICE_LIB_PATH to the produced libomnivoice.{so,dylib,dll}.",
].join("\n");

export class OmnivoiceNotInstalled extends Error {
  constructor(detail?: string) {
    const suffix = detail ? `\n\nDetail: ${detail}` : "";
    super(`${BUILD_INSTRUCTIONS}${suffix}`);
    this.name = "OmnivoiceNotInstalled";
  }
}

export class OmnivoiceModelMissing extends Error {
  constructor(field: "model_path" | "codec_path", value: string | undefined) {
    super(
      `OMNIVOICE_${field.toUpperCase()} is required for omnivoice TTS but was ${
        value === undefined ? "unset" : `set to a missing path: ${value}`
      }. Download GGUFs from https://huggingface.co/Serveurperso/OmniVoice-GGUF`,
    );
    this.name = "OmnivoiceModelMissing";
  }
}

export class OmnivoiceTranscriptionNotSupported extends Error {
  constructor() {
    super(
      [
        "@elizaos/plugin-omnivoice does not provide ASR/transcription.",
        "omnivoice.cpp ships an `omnivoice-codec` tool which encodes WAV →",
        "RVQ tokens, not text. Use plugin-elevenlabs, plugin-deepgram, or",
        "Whisper for speech-to-text.",
      ].join(" "),
    );
    this.name = "OmnivoiceTranscriptionNotSupported";
  }
}

export class OmnivoiceSynthesisFailed extends Error {
  readonly status: number;
  readonly lastError: string | undefined;
  constructor(status: number, lastError: string | undefined) {
    super(
      `omnivoice ov_synthesize failed with status ${status}${
        lastError ? ` — ${lastError}` : ""
      }`,
    );
    this.name = "OmnivoiceSynthesisFailed";
    this.status = status;
    this.lastError = lastError;
  }
}
