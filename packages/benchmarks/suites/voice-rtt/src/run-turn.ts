/**
 * One-turn benchmark orchestration.
 *
 * This module timestamps the full acoustic-end to playout path while keeping
 * provider calls behind adapters. It models interruption as a client-side
 * cancellation boundary and asserts that no audio frames are accepted after
 * the playout silence checkpoint.
 */

import { deriveStages } from "./metrics.ts";
import { firstSpeakablePhrase } from "./speakable.ts";
import { TraceBuilder } from "./trace.ts";
import type {
  CaseResult,
  CorpusCase,
  LlmAdapter,
  SttAdapter,
  TtsAdapter,
  VoiceTrace,
} from "./types.ts";

export async function runTurn(args: {
  corpus: CorpusCase;
  runIndex: number;
  traceId: string;
  mode: "mock" | "live";
  stt: SttAdapter;
  llm: LlmAdapter;
  tts: TtsAdapter;
  timeoutMs: number;
  unsafeTranscripts: boolean;
  audioDir?: string;
}): Promise<CaseResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const trace = new TraceBuilder(args.traceId);
  const errors: string[] = [];

  try {
    trace.mark("input_acoustic_end", args.corpus.inputAudioMs, "client");
    const stt = await args.stt.transcribe({
      traceId: args.traceId,
      corpus: args.corpus,
      signal: controller.signal,
      unsafeTranscripts: args.unsafeTranscripts,
      audioDir: args.audioDir,
    });
    trace.mark("stt_eager_end", stt.eagerEndAtMs, args.stt.name);
    trace.mark("stt_final", stt.finalAtMs, args.stt.name);
    trace.timing(
      "stt",
      stt.finalAtMs - args.corpus.inputAudioMs,
      "input_end_to_final",
    );

    const chatAdmissionAt = stt.finalAtMs + 12;
    trace.mark("chat_admission", chatAdmissionAt, "harness");
    trace.mark("llm_preforward", chatAdmissionAt + 4, args.llm.name);
    const llm = await args.llm.complete({
      traceId: args.traceId,
      corpus: args.corpus,
      transcript: stt.transcript,
      admissionAtMs: chatAdmissionAt,
      signal: controller.signal,
    });
    trace.mark("llm_first_text_token", llm.firstTokenAtMs, args.llm.name);
    trace.timing(
      "llm_ttft",
      llm.firstTokenAtMs - chatAdmissionAt,
      "chat_to_first_token",
    );

    const phrase = firstSpeakablePhrase(llm.replyText);
    const firstSpeakableAt = firstSpeakableAtMs(llm, phrase);
    trace.mark("first_speakable_phrase", firstSpeakableAt, "harness");
    // The current adapter returns after the complete stream. Do not backdate a
    // TTS request to the earlier phrase timestamp when the call happens now.
    // A future duplex adapter can lower this naturally by invoking TTS from its
    // streaming phrase callback.
    const ttsRequestAt = Math.max(firstSpeakableAt + 6, llm.completeAtMs);
    trace.mark("tts_request", ttsRequestAt, args.tts.name);
    let firstAudioAt: number | null = null;
    let firstAudioBytes = 0;
    let firstPlayoutAt: number | null = null;
    let interruptAt: number | null = null;
    let silenceAt: number | null = null;
    let postInterruptAudioFrames = 0;
    let acceptingAudio = true;
    const tts = await args.tts.synthesize({
      traceId: args.traceId,
      corpus: args.corpus,
      text: phrase,
      requestAtMs: ttsRequestAt,
      signal: controller.signal,
      onAudioFrame(frame) {
        if (firstAudioAt === null) {
          firstAudioAt = frame.atMs;
          firstAudioBytes = frame.bytes;
          firstPlayoutAt =
            frame.atMs + args.corpus.mockTimingsMs.playoutBufferMs;
          trace.mark("tts_first_audio_frame", frame.atMs, args.tts.name);
          trace.timing(
            "tts_ttfa",
            frame.atMs - ttsRequestAt,
            "request_to_first_audio",
          );
          trace.mark("client_playout_start", firstPlayoutAt, "client");
          if (
            args.corpus.kind === "barge-in" &&
            args.corpus.bargeInAtMs !== undefined
          ) {
            interruptAt = firstPlayoutAt + args.corpus.bargeInAtMs;
          }
        }

        if (!acceptingAudio) {
          if (silenceAt !== null && frame.atMs > silenceAt) {
            postInterruptAudioFrames++;
          }
          return false;
        }

        if (interruptAt !== null && frame.atMs >= interruptAt) {
          trace.mark("interrupt", interruptAt, "client");
          silenceAt =
            interruptAt +
            (args.corpus.mockTimingsMs.interruptSilenceAfterBargeIn ?? 300);
          trace.mark("playout_silence", silenceAt, "client");
          acceptingAudio = false;
          if (frame.atMs > silenceAt) {
            postInterruptAudioFrames++;
          }
          return false;
        }

        return true;
      },
    });
    if (firstAudioAt === null) {
      throw new Error("TTS completed without audio frames");
    }

    const voiceTrace: VoiceTrace = {
      traceId: args.traceId,
      mode: args.mode,
      caseId: args.corpus.id,
      runIndex: args.runIndex,
      checkpoints: trace.checkpoints,
      serverTiming: trace.serverTiming,
      lengths: {
        inputAudioMs: args.corpus.inputAudioMs,
        transcriptChars: stt.transcriptChars,
        replyChars: llm.replyText.length,
        firstSpeakablePhraseChars: phrase.length,
        firstAudioBytes,
      },
      transcript: args.unsafeTranscripts ? stt.transcript : undefined,
      replyText: args.unsafeTranscripts ? llm.replyText : undefined,
      cancelled: tts.cancelled,
      postInterruptAudioFrames,
      providerRequestIds: {
        ...(stt.requestId ? { stt: stt.requestId } : {}),
        ...(llm.requestId ? { llm: llm.requestId } : {}),
        ...(tts.requestId ? { tts: tts.requestId } : {}),
      },
      errors,
    };
    const stages = deriveStages(voiceTrace);
    return {
      caseId: args.corpus.id,
      kind: args.corpus.kind,
      runIndex: args.runIndex,
      trace: voiceTrace,
      stages,
    };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function firstSpeakableAtMs(
  llm: {
    firstTokenAtMs: number;
    tokens: Array<{ text: string; atMs: number }>;
  },
  phrase: string,
): number {
  if (llm.tokens.length === 0) return llm.firstTokenAtMs;
  let accumulated = "";
  for (const token of llm.tokens) {
    accumulated += token.text;
    if (accumulated.trim().length >= phrase.length) return token.atMs;
  }
  return llm.tokens[llm.tokens.length - 1].atMs;
}
