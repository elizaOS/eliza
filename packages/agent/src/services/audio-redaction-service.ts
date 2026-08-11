/**
 * Owns the fail-closed audio-PII variant workflow for runtime consumers.
 * It maps detector verdicts to timed words, produces a duration-preserving
 * candidate, re-transcribes that candidate, and only then publishes its
 * content-addressed media URL. Unverified bytes never enter the media store.
 */

import { ElizaError, type IAgentRuntime, Service } from "@elizaos/core";
import {
  assertCompleteAudioRedactionPlan,
  buildAudioRedactionSpans,
  normalizeSpokenText,
  type PiiTextSpan,
} from "@elizaos/shared/audio-redaction";
import {
  type RedactionTranscriber,
  verifyAudioRedaction,
} from "@elizaos/shared/audio-redaction-verify";
import type { TranscriptWord } from "@elizaos/shared/transcripts";
import {
  findRedactedAudioVariant,
  persistVerifiedRedactedAudioVariant,
  prepareRedactedAudioVariant,
  type RedactedAudioVariant,
} from "../api/audio-redaction-store.ts";
import {
  openAiCompatSttTranscriber,
  runtimeTranscriptionTranscriber,
} from "../api/audio-redaction-verify.ts";
import { mediaFileNameFromUrl } from "../api/media-store.ts";

export const AUDIO_REDACTION_SERVICE_TYPE = "audio-redaction";
export const AUDIO_REDACTION_RULESET_VERSION = "2026-08-06.1";

export interface VerifiedAudioRedactionRequest {
  originalAudioUrl: string;
  durationMs: number;
  words: readonly TranscriptWord[];
  piiSpans: readonly PiiTextSpan[];
  mode?: "mute" | "bleep";
  rulesetVersion?: string;
  languageHint?: string;
}

export interface VerifiedAudioRedactionResult {
  url: string;
  hash: string;
  reused: boolean;
  verifierIds: string[];
  spanCount: number;
  sentinelTexts: string[];
}

function intersects(
  word: TranscriptWord,
  span: { startMs: number; endMs: number },
): boolean {
  return word.startMs < span.endMs && span.startMs < word.endMs;
}

/**
 * Pick audible witnesses before, between, and after redaction windows. All
 * selected witnesses must survive re-transcription, catching whole-file and
 * broad-neighbourhood over-mutes without relying on transcript equality.
 */
export function selectAudioRedactionSentinels(
  words: readonly TranscriptWord[],
  spans: readonly { startMs: number; endMs: number }[],
): string[] {
  const candidates = words
    .filter((word) => !spans.some((span) => intersects(word, span)))
    .map((word) => ({
      text: word.text.trim(),
      normalized: normalizeSpokenText(word.text),
      midpoint: (word.startMs + word.endMs) / 2,
    }))
    .filter((word) => word.normalized.length > 0)
    .sort((a, b) => a.midpoint - b.midpoint);
  const preferred = candidates.filter((word) => word.normalized.length >= 3);
  const pool = preferred.length > 0 ? preferred : candidates;
  const unique = pool.filter(
    (word, index) =>
      pool.findIndex(
        (candidate) => candidate.normalized === word.normalized,
      ) === index,
  );
  if (unique.length === 0) {
    throw new ElizaError(
      "audio redaction has no non-PII timed word available as an over-mute sentinel",
      { code: "AUDIO_REDACTION_SENTINEL_UNAVAILABLE" },
    );
  }
  const positions =
    unique.length <= 3
      ? unique.map((_word, index) => index)
      : [0, Math.floor((unique.length - 1) / 2), unique.length - 1];
  return positions.map((index) => unique[index].text);
}

function independentVerifierFromEnv(): RedactionTranscriber | null {
  const baseUrl = process.env.ELIZA_AUDIO_REDACTION_VERIFY_STT_URL?.trim();
  const model = process.env.ELIZA_AUDIO_REDACTION_VERIFY_STT_MODEL?.trim();
  if (!baseUrl && !model) return null;
  if (!baseUrl || !model) {
    throw new ElizaError(
      "independent audio-redaction verifier requires both STT URL and model",
      { code: "AUDIO_REDACTION_VERIFY_CONFIG_INVALID" },
    );
  }
  return openAiCompatSttTranscriber({
    baseUrl,
    model,
    apiKey: process.env.ELIZA_AUDIO_REDACTION_VERIFY_STT_API_KEY?.trim(),
  });
}

export class AudioRedactionService extends Service {
  static serviceType = AUDIO_REDACTION_SERVICE_TYPE;
  capabilityDescription =
    "Creates content-addressed audio PII variants only after fail-closed ASR verification";

  static async start(runtime: IAgentRuntime): Promise<AudioRedactionService> {
    return new AudioRedactionService(runtime);
  }

  async redactAndVerify(
    request: VerifiedAudioRedactionRequest,
  ): Promise<VerifiedAudioRedactionResult> {
    try {
      return await this.runRedaction(request);
    } catch (error) {
      // error-policy:J2 The action boundary translates this failure; report it
      // here with non-sensitive geometry while preserving the typed cause.
      this.runtime.reportError("audio-redaction", error, {
        durationMs: request.durationMs,
        wordCount: request.words.length,
        piiSpanCount: request.piiSpans.length,
      });
      throw error;
    }
  }

  private async runRedaction(
    request: VerifiedAudioRedactionRequest,
  ): Promise<VerifiedAudioRedactionResult> {
    const originalFileName = mediaFileNameFromUrl(request.originalAudioUrl);
    if (!originalFileName) {
      throw new ElizaError(
        "audio redaction requires a canonical local media-store URL",
        { code: "AUDIO_REDACTION_ORIGINAL_URL_INVALID" },
      );
    }
    if (request.piiSpans.length === 0) {
      throw new ElizaError(
        "audio redaction requires at least one PII verdict",
        {
          code: "AUDIO_REDACTION_INPUT_INVALID",
        },
      );
    }
    const plan = buildAudioRedactionSpans(request.words, request.piiSpans, {
      durationMs: request.durationMs,
    });
    assertCompleteAudioRedactionPlan(plan);
    const sentinelTexts = selectAudioRedactionSentinels(
      request.words,
      plan.spans,
    );
    const mode = request.mode ?? "mute";
    const rulesetVersion =
      request.rulesetVersion ?? AUDIO_REDACTION_RULESET_VERSION;
    const keyParts = {
      originalSha: originalFileName.slice(0, 64),
      spans: plan.spans,
      mode,
      rulesetVersion,
    };
    const existing = findRedactedAudioVariant(keyParts);
    if (existing) {
      return this.result(existing, [], plan.spans.length, sentinelTexts);
    }

    const prepared = await prepareRedactedAudioVariant({
      originalFileName,
      spans: plan.spans,
      mode,
      rulesetVersion,
    });
    const transcribers: RedactionTranscriber[] = [
      runtimeTranscriptionTranscriber(this.runtime),
    ];
    const independent = independentVerifierFromEnv();
    if (independent) transcribers.push(independent);
    const verification = await verifyAudioRedaction(
      transcribers,
      {
        audio: prepared.bytes,
        mimeType: prepared.mimeType,
        ...(request.languageHint ? { languageHint: request.languageHint } : {}),
      },
      {
        piiTexts: request.piiSpans.map((span) => span.text),
        sentinelTexts,
      },
    );
    const variant = persistVerifiedRedactedAudioVariant(prepared, verification);
    return this.result(
      variant,
      verification.findings.map((finding) => finding.verifierId),
      plan.spans.length,
      sentinelTexts,
    );
  }

  private result(
    variant: RedactedAudioVariant,
    verifierIds: string[],
    spanCount: number,
    sentinelTexts: string[],
  ): VerifiedAudioRedactionResult {
    return {
      url: variant.url,
      hash: variant.hash,
      reused: variant.reused,
      verifierIds,
      spanCount,
      sentinelTexts,
    };
  }

  async stop(): Promise<void> {}
}
