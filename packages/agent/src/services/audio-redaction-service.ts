/**
 * Owns the fail-closed audio-PII variant workflow for runtime consumers.
 * It maps detector verdicts to timed words, produces a duration-preserving
 * candidate, re-transcribes that candidate, and only then publishes its
 * content-addressed media URL. Unverified bytes never enter the media store.
 * Timed-word lists are budgeted before sentinel selection so a hostile STT
 * stream cannot pin the agent event loop on quadratic uniqueness.
 */

import { ElizaError, type IAgentRuntime, Service } from "@elizaos/core";
import {
  assertCompleteAudioRedactionPlan,
  buildAudioRedactionSpans,
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
import {
  AudioRedactionWordBudgetError,
  assertAudioRedactionInputBudget as assertAudioRedactionInputBudgetLinear,
  assertAudioRedactionWordBudget as assertAudioRedactionWordBudgetLinear,
  selectAudioRedactionSentinels as selectAudioRedactionSentinelsLinear,
} from "./audio-redaction-word-budget.ts";

export {
  MAX_AUDIO_REDACTION_MATCH_CANDIDATES,
  MAX_AUDIO_REDACTION_NORMALIZED_CHARS,
  MAX_AUDIO_REDACTION_PII_NORMALIZED_CHARS,
  MAX_AUDIO_REDACTION_PII_SPAN_CHARS,
  MAX_AUDIO_REDACTION_PII_SPANS,
  MAX_AUDIO_REDACTION_WORD_CHARS,
  MAX_AUDIO_REDACTION_WORDS,
} from "./audio-redaction-word-budget.ts";

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

function rethrowAudioRedactionBudget(error: unknown): never {
  if (error instanceof AudioRedactionWordBudgetError) {
    throw new ElizaError(error.message, {
      code: error.code,
      context: error.context,
    });
  }
  throw error;
}

export function assertAudioRedactionWordBudget(
  words: readonly TranscriptWord[],
): void {
  try {
    assertAudioRedactionWordBudgetLinear(words);
  } catch (error) {
    // error-policy:J2 preserve the budget code for runtime.reportError
    rethrowAudioRedactionBudget(error);
  }
}

export function assertAudioRedactionInputBudget(
  words: readonly TranscriptWord[],
  piiSpans: readonly PiiTextSpan[],
): void {
  try {
    assertAudioRedactionInputBudgetLinear(words, piiSpans);
  } catch (error) {
    // error-policy:J2 preserve the budget code for runtime.reportError
    rethrowAudioRedactionBudget(error);
  }
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
  try {
    return selectAudioRedactionSentinelsLinear(words, spans);
  } catch (error) {
    // error-policy:J2 preserve the budget code for runtime.reportError
    rethrowAudioRedactionBudget(error);
  }
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
    assertAudioRedactionInputBudget(request.words, request.piiSpans);
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
