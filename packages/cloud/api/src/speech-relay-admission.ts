/** Canonical subscription/usage admission for one bounded speech session.
 * Provider USD estimates do not require prepaid user credits: the common
 * admission service uses monthly subscription allowance first when applicable.
 * No per-frame database or funding work occurs.
 */
import { PLATFORM_MARKUP_MULTIPLIER } from "@elizaos/cloud-shared/lib/pricing-constants";
import { InferenceBalanceCacheWarmingError } from "@elizaos/cloud-shared/lib/services/inference-billing-fast-path";
import { InsufficientCreditsError, type CreditReconciliationResult } from "@elizaos/cloud-shared/lib/services/credits";
import { admitOrganizationInference, type OrganizationInferenceAdmission } from "@elizaos/cloud-shared/lib/services/organization-inference-admission";
import { CARTESIA_SONIC_MODEL_ID } from "@elizaos/host/voice/cartesia-sonic-tts";
import type { SpeechRelayCreditReservation } from "@elizaos/host/voice/speech-relay-session";
import { SPEECH_RELAY_BUDGET } from "@elizaos/host/voice/speech-relay-session";
import type { SpeechSettlementOutcome } from "@elizaos/host/voice/speech-relay-wire";
import type { SettlementProgress } from "./speech-retirement-state";
import type { GenerativeRouteCaller } from "./lib/generative-route-auth";

const round = (value: number) =>
  Math.round((value + Number.EPSILON) * 1e6) / 1e6;

/** Ink-2 uses 3 credits/audio second; Sonic uses 1 credit/character.
 * The account's USD/credit is deployment-owned, just as on batch Cartesia STT.
 * https://www.cartesia.ai/pricing
 */
export async function reserveSpeechRelayAdmission(input: {
  caller: GenerativeRouteCaller;
  sessionId: string;
  usdPerCredit: number;
  executionCtx: { waitUntil(task: Promise<unknown>): void };
  onProgress?: (kind: "stt" | "tts", progress: SettlementProgress) => Promise<void>;
}): Promise<SpeechRelayCreditReservation> {
  const { caller, sessionId, usdPerCredit, executionCtx } = input;
  if (!Number.isFinite(usdPerCredit) || usdPerCredit <= 0)
    throw Error("Cartesia account pricing is unavailable");
  const seconds = SPEECH_RELAY_BUDGET.durationMs / 1000;
  const rates = { stt: usdPerCredit * 3, tts: usdPerCredit };
  const maxima = { stt: seconds, tts: SPEECH_RELAY_BUDGET.ttsCharacters };
  const admissions = new Map<
    "stt" | "tts",
    Awaited<ReturnType<typeof admitOrganizationInference>>
  >();
  const terminalReceiptMatches = (result: CreditReconciliationResult | null,
    admission: OrganizationInferenceAdmission, requestId: string, amount: number) => {
    const receipt = result?.terminalReceipt;
    return receipt?.version === 1 && receipt.status === "canonical_completed" &&
      receipt.organizationId === caller.user.organization_id && receipt.requestId === requestId &&
      receipt.amountUsd === amount.toFixed(6) && receipt.mode === admission.mode &&
      receipt.mode !== "durable_object_funded_budget";
  };
  let reservingKind: "stt" | "tts" | undefined;
  let refusedBeforeReservation = false;
  try {
    for (const kind of ["stt", "tts"] as const) {
      reservingKind = kind;
      const requestId = `speech:${sessionId}:${kind}`;
      await input.onProgress?.(kind, { state: "reserving", requestId });
      const base = rates[kind] * maxima[kind];
      const total = round(base * PLATFORM_MARKUP_MULTIPLIER);
      let admission: Awaited<ReturnType<typeof admitOrganizationInference>>;
      try {
        admission = await admitOrganizationInference({
          context: {
            organizationId: caller.user.organization_id,
            userId: caller.user.id,
            apiKeyId: caller.apiKeyId,
            requestId: `speech:${sessionId}:${kind}`,
            provider: "cartesia",
            billingSource: "cartesia",
            model: kind === "stt" ? "ink-2" : CARTESIA_SONIC_MODEL_ID,
            description: "Bounded streaming speech session",
          },
          apiKeyId: caller.apiKeyId,
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          flatCost: {
            baseTotalCost: round(base),
            totalCost: total,
            platformMarkup: round(total - base),
          },
          admissionSnapshot: caller.admissionSnapshot,
          credential: caller.credential,
          executionCtx,
          atomicProviderBoundary: true,
        });
      } catch (error) {
        refusedBeforeReservation = error instanceof InsufficientCreditsError || error instanceof InferenceBalanceCacheWarmingError;
        throw error;
      }
      admissions.set(kind, admission);
      await input.onProgress?.(kind, { state: "reserved", requestId });
      reservingKind = undefined;
    }
    // Arm both bounded leases once, before opening any provider. In the event
    // of a crash the existing admission alarm retains the full uncertain cost.
    // A live session can reconcile unused TTS to zero on confirmed cleanup.
    for (const admission of admissions.values())
      await admission.markProviderDispatched?.();
  } catch (error) {
    // Only a typed authoritative refusal proves this reservation never existed.
    // Generic transport/ack failures remain reserving and therefore unconfirmed.
    const proofFailures: unknown[] = [];
    if (reservingKind && !admissions.has(reservingKind) && refusedBeforeReservation) {
      try { await input.onProgress?.(reservingKind, { state: "not_reserved" }); }
      catch (proofError) { proofFailures.push(proofError); }
    }
    // Keep each successful zero settlement even if another rollback fails.
    const rollback = await Promise.allSettled([...admissions].map(async ([kind, admission]) => {
      const requestId = `speech:${sessionId}:${kind}`;
      const result = await admission.settle(0);
      const terminal = terminalReceiptMatches(result, admission, requestId, 0);
      await input.onProgress?.(kind, { state: terminal ? "settled_actual" : "unconfirmed", requestId, amountUsd: "0" });
      if (!terminal) throw Error("Speech reservation zero rollback receipt is unconfirmed");
    }));
    const failures = rollback.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failures.length || proofFailures.length) throw new AggregateError([error, ...proofFailures, ...failures.map(item => item.reason)], "Speech reservation rollback unconfirmed");
    throw error;
  }
  type Kind = "stt" | "tts";
  const choices = new Map<Kind, { state: "actual" | "conservative"; amount: number; basis?: "submitted_counter_provider_unconfirmed" }>();
  const outcomes: Partial<SpeechSettlementOutcome> = {};
  const fingerprints = new Map<Kind, string>();
  const pending = new Map<Kind, Promise<void>>();
  return {
    supportsPerKindSettlement: true,
    beforeProviderDispatch: async () => {},
    settle: async (details, kinds = ["stt", "tts"]) => {
      await Promise.all(kinds.map(kind => {
        const fingerprint = JSON.stringify([kind === "stt" ? details.pcmBytes : details.ttsCharacters,
          details.dispatched?.[kind], details.outcomes?.[kind], kind === "tts" ? details.ttsAccountingBasis : undefined]);
        const prior = fingerprints.get(kind);
        if (prior !== undefined && prior !== fingerprint) throw Error("Speech settlement target changed");
        fingerprints.set(kind, fingerprint);
        const existing = pending.get(kind);
        if (existing) return existing;
        const attempt = (async () => {
          const requestId = `speech:${sessionId}:${kind}`;
          if (!outcomes[kind]) {
            let choice = choices.get(kind);
            if (!choice) {
              if (details.dispatched?.[kind] !== true) choice = { state: "actual", amount: 0 };
              else if (kind === "stt" && details.outcomes?.stt !== "complete")
                choice = { state: "conservative", amount: round(maxima[kind] * rates[kind] * PLATFORM_MARKUP_MULTIPLIER) };
              else {
                const quantity = kind === "stt" ? details.pcmBytes / 32000 : details.ttsCharacters;
                if (!Number.isFinite(quantity) || quantity < 0 || quantity > maxima[kind])
                  throw Error("Speech usage exceeded its paid reservation");
                choice = { state: kind === "tts" && details.ttsAccountingBasis ? "conservative" : "actual",
                  amount: round(quantity * rates[kind] * PLATFORM_MARKUP_MULTIPLIER),
                  ...(kind === "tts" && details.ttsAccountingBasis ? { basis: details.ttsAccountingBasis } : {}) };
              }
              choices.set(kind, choice);
            }
            await input.onProgress?.(kind, { state: "settling", requestId, amountUsd: String(choice.amount), ...(choice.basis ? { basis: choice.basis } : {}) });
            const admission = admissions.get(kind)!;
            const reconciliation = choice.state === "conservative" && !choice.basis
              ? await admission.settleUnknown() : await admission.settle(choice.amount);
            const terminal = terminalReceiptMatches(reconciliation, admission, requestId, choice.amount);
            outcomes[kind] = { requestId, state: choice.state, amountUsd: String(choice.amount), ...(terminal ? { terminal: true as const } : {}), ...(choice.basis ? { basis: choice.basis } : {}) };
          }
          const outcome = outcomes[kind]!;
          await input.onProgress?.(kind, { state: outcome.state === "conservative" ? "settled_conservative" : outcome.terminal ? "settled_actual" : "unconfirmed",
            requestId, amountUsd: outcome.amountUsd, ...("basis" in outcome && outcome.basis ? { basis: outcome.basis } : {}) });
        })();
        pending.set(kind, attempt);
        void attempt.catch(() => { if (pending.get(kind) === attempt) pending.delete(kind); });
        return attempt;
      }));
      return { ...outcomes };
    },
  };
}
