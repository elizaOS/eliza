/**
 * @elizaos/plugin-omnivoice — local TTS via omnivoice.cpp.
 *
 * Registers ModelType.TEXT_TO_SPEECH backed by the libomnivoice shared
 * library. Handles voice design (gender / age / pitch / style / volume /
 * emotion), voice cloning (reference WAV + transcript), and a singing
 * codepath (separate model). Surfaces ModelType.TRANSCRIPTION as a
 * stub that throws OmnivoiceTranscriptionNotSupported — omnivoice has
 * no ASR head; users should pair this plugin with plugin-elevenlabs,
 * plugin-deepgram, or Whisper for STT.
 *
 * Auto-enables only when the user has provided OMNIVOICE_MODEL_PATH +
 * OMNIVOICE_CODEC_PATH or explicitly opted into local TTS via
 * features.localTts. Kept conservative because the shared library and
 * GGUFs are large and out-of-band.
 */

import { type IAgentRuntime, logger, ModelType, type Plugin } from "@elizaos/core";
import { OmnivoiceModelMissing, OmnivoiceTranscriptionNotSupported } from "./errors";
import { OmnivoiceContext } from "./ffi";
import { getSingingContext, runSingingSynthesis } from "./singing";
import { pcmFloatToWavBuffer, runSynthesis } from "./synth";
import type { OmnivoiceSynthesizeOptions, OmnivoiceVoiceDesign } from "./types";

interface RuntimeSettings {
  libPath: string | undefined;
  modelPath: string | undefined;
  codecPath: string | undefined;
  singingModelPath: string | undefined;
  lang: string | undefined;
  instruct: string | undefined;
  useFa: boolean;
}

interface OmnivoiceTtsInput {
  text: string;
  voice?: string;
  speed?: number;
  emotion?: string;
  singing?: boolean;
  lang?: string;
  instruct?: string;
  design?: OmnivoiceVoiceDesign;
}

function getSetting(
  runtime: IAgentRuntime,
  key: string,
  fallback?: string,
): string | undefined {
  const env =
    typeof process !== "undefined" && process.env ? process.env[key] : undefined;
  return (runtime.getSetting(key) as string | undefined) ?? env ?? fallback;
}

function loadSettings(runtime: IAgentRuntime): RuntimeSettings {
  return {
    libPath: getSetting(runtime, "OMNIVOICE_LIB_PATH"),
    modelPath: getSetting(runtime, "OMNIVOICE_MODEL_PATH"),
    codecPath: getSetting(runtime, "OMNIVOICE_CODEC_PATH"),
    singingModelPath: getSetting(runtime, "OMNIVOICE_SINGING_MODEL_PATH"),
    lang: getSetting(runtime, "OMNIVOICE_LANG", "English"),
    instruct: getSetting(runtime, "OMNIVOICE_INSTRUCT"),
    useFa: (getSetting(runtime, "OMNIVOICE_USE_FA", "true") ?? "true").toLowerCase() !== "false",
  };
}

let speechCtx: OmnivoiceContext | null = null;

async function getSpeechContext(settings: RuntimeSettings): Promise<OmnivoiceContext> {
  if (speechCtx) return speechCtx;
  if (!settings.modelPath) throw new OmnivoiceModelMissing("model_path", undefined);
  if (!settings.codecPath) throw new OmnivoiceModelMissing("codec_path", undefined);
  if (settings.libPath) {
    process.env.OMNIVOICE_LIB_PATH = settings.libPath;
  }
  speechCtx = await OmnivoiceContext.open({
    modelPath: settings.modelPath,
    codecPath: settings.codecPath,
    useFa: settings.useFa,
  });
  return speechCtx;
}

function buildSynthesisOptions(
  input: OmnivoiceTtsInput,
  settings: RuntimeSettings,
): OmnivoiceSynthesizeOptions {
  const design: OmnivoiceVoiceDesign | undefined = input.design ?? (
    input.emotion ? { emotion: input.emotion as OmnivoiceVoiceDesign["emotion"] } : undefined
  );
  return {
    text: input.text,
    lang: input.lang ?? settings.lang ?? "English",
    instruct: input.instruct ?? settings.instruct,
    design,
    singing: input.singing ?? false,
  };
}

export const omnivoicePlugin: Plugin = {
  name: "omnivoice",
  description:
    "Local TTS via omnivoice.cpp — voice cloning, voice design, emotion-aware synthesis, and singing on CPU/Metal/CUDA/Vulkan.",
  autoEnable: {
    shouldEnable: (env, _config) => {
      return Boolean(env.OMNIVOICE_MODEL_PATH && env.OMNIVOICE_CODEC_PATH);
    },
  },
  models: {
    [ModelType.TEXT_TO_SPEECH]: async (
      runtime: IAgentRuntime,
      input: string | OmnivoiceTtsInput,
    ): Promise<Buffer> => {
      const params: OmnivoiceTtsInput =
        typeof input === "string" ? { text: input } : input;
      if (typeof params.text !== "string" || params.text.trim().length === 0) {
        throw new Error("TEXT_TO_SPEECH requires non-empty text");
      }
      const settings = loadSettings(runtime);
      const opts = buildSynthesisOptions(params, settings);
      logger.info(
        `[plugin-omnivoice] TTS singing=${opts.singing ?? false} chars=${opts.text.length}`,
      );
      let result;
      if (opts.singing) {
        if (!settings.singingModelPath || !settings.codecPath) {
          throw new OmnivoiceModelMissing("model_path", settings.singingModelPath);
        }
        const ctx = await getSingingContext({
          modelPath: settings.singingModelPath,
          codecPath: settings.codecPath,
          useFa: settings.useFa,
        });
        result = await runSingingSynthesis(ctx, opts);
      } else {
        const ctx = await getSpeechContext(settings);
        result = await runSynthesis(ctx, opts);
      }
      return pcmFloatToWavBuffer(result.samples, result.sampleRate, result.channels);
    },
    [ModelType.TRANSCRIPTION]: async (
      _runtime: IAgentRuntime,
      _input: unknown,
    ): Promise<never> => {
      throw new OmnivoiceTranscriptionNotSupported();
    },
  },
};

export default omnivoicePlugin;

export type { Emotion, OmnivoiceSynthesizeOptions, OmnivoiceVoiceDesign } from "./types";
export { OmnivoiceContext } from "./ffi";
export {
  OmnivoiceModelMissing,
  OmnivoiceNotInstalled,
  OmnivoiceSynthesisFailed,
  OmnivoiceTranscriptionNotSupported,
} from "./errors";
export { runSynthesis, pcmFloatToWavBuffer } from "./synth";
export { runSingingSynthesis, getSingingContext } from "./singing";
