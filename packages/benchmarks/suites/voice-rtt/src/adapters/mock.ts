/**
 * Deterministic provider adapters for CI.
 *
 * These adapters exercise the full benchmark path, cancellation assertions,
 * trace derivation, reports, and gates without contacting external providers
 * or writing transcripts by default.
 */

import type { LlmAdapter, SttAdapter, TtsAdapter, TtsFrame } from "../types.ts";

export function createMockAdapters(): {
  stt: SttAdapter;
  llm: LlmAdapter;
  tts: TtsAdapter;
} {
  return {
    stt: {
      name: "mock-deepgram-flux",
      async transcribe({ corpus }) {
        const inputEnd = corpus.inputAudioMs;
        return {
          transcript: corpus.transcript,
          transcriptChars: corpus.transcript.length,
          eagerEndAtMs: inputEnd + corpus.mockTimingsMs.sttEagerAfterInputEnd,
          finalAtMs: inputEnd + corpus.mockTimingsMs.sttFinalAfterInputEnd,
          requestId: `mock-dg-${corpus.id}`,
        };
      },
    },
    llm: {
      name: "mock-cerebras-gemma-4-31b",
      async complete({ corpus, admissionAtMs }) {
        const replyText = corpus.expectedReply;
        const firstTokenAtMs =
          admissionAtMs + corpus.mockTimingsMs.llmFirstTokenAfterAdmission;
        return {
          replyText,
          firstTokenAtMs,
          completeAtMs:
            admissionAtMs + corpus.mockTimingsMs.llmCompleteAfterAdmission,
          tokens: (replyText.match(/\S+\s*/g) ?? [replyText]).map(
            (text, index) => ({
              text,
              atMs: firstTokenAtMs + index * 12,
            }),
          ),
          requestId: `mock-cb-${corpus.id}`,
        };
      },
    },
    tts: {
      name: "mock-cartesia-sonic-3.5",
      async synthesize({ corpus, requestAtMs, onAudioFrame }) {
        const firstAudioAtMs =
          requestAtMs + corpus.mockTimingsMs.ttsFirstAudioAfterRequest;
        const frameCount = corpus.kind === "barge-in" ? 28 : 6;
        const frames: TtsFrame[] = [];
        let cancelled = false;
        for (let index = 0; index < frameCount; index++) {
          const frame = {
            atMs: firstAudioAtMs + index * 40,
            bytes: 640,
          };
          if (!onAudioFrame(frame)) {
            cancelled = true;
            break;
          }
          frames.push(frame);
        }
        return {
          firstAudioAtMs,
          frames,
          cancelled,
          requestId: `mock-ct-${corpus.id}`,
        };
      },
    },
  };
}
