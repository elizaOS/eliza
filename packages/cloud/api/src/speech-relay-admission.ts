/** Canonical subscription/usage admission for one bounded speech session.
 * Provider USD estimates do not require prepaid user credits: the common
 * admission service uses monthly subscription allowance first when applicable.
 * No per-frame database or funding work occurs.
 */
import { PLATFORM_MARKUP_MULTIPLIER } from "@elizaos/cloud-shared/lib/pricing-constants";
import { InsufficientCreditsError } from "@elizaos/cloud-shared/lib/services/credits";
import { admitOrganizationInference } from "@elizaos/cloud-shared/lib/services/organization-inference-admission";
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
  let reservingKind: "stt" | "tts" | undefined;
  try {
    for (const kind of ["stt", "tts"] as const) {
      reservingKind = kind;
      const requestId = `speech:${sessionId}:${kind}`;
      await input.onProgress?.(kind, { state: "reserving", requestId });
      const base = rates[kind] * maxima[kind];
      const total = round(base * PLATFORM_MARKUP_MULTIPLIER);
      admissions.set(
        kind,
        await admitOrganizationInference({
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
        }),
      );
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
    if (reservingKind && !admissions.has(reservingKind) && error instanceof InsufficientCreditsError)
      await input.onProgress?.(reservingKind, { state: "not_reserved" });
    // Keep each successful zero settlement even if another rollback fails.
    const rollback = await Promise.allSettled([...admissions].map(async ([kind, admission]) => {
      const requestId = `speech:${sessionId}:${kind}`;
      await admission.settle(0);
      await input.onProgress?.(kind, { state: "settled_actual", requestId, amountUsd: "0" });
    }));
    const failures = rollback.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failures.length) throw new AggregateError([error, ...failures.map(item => item.reason)], "Speech reservation rollback unconfirmed");
    throw error;
  }
  let settlement: Promise<SpeechSettlementOutcome> | undefined;
  const choices = new Map<"stt" | "tts", { state: "actual" | "conservative"; amount: number }>();
  const outcomes: Partial<SpeechSettlementOutcome> = {};
  let settlementInput: string | undefined;
  return {
    beforeProviderDispatch: async () => {},
    settle: (details) => {
      const fingerprint = JSON.stringify([details.pcmBytes, details.ttsCharacters, details.dispatched?.stt, details.dispatched?.tts, details.outcomes?.stt, details.outcomes?.tts]);
      if (settlementInput !== undefined && settlementInput !== fingerprint) return Promise.reject(Error("Speech settlement target changed"));
      settlementInput = fingerprint;
      if (settlement) return settlement;
      const attempt = (async (): Promise<SpeechSettlementOutcome> => {
        for (const kind of ["stt", "tts"] as const) {
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
                choice = { state: "actual", amount: round(quantity * rates[kind] * PLATFORM_MARKUP_MULTIPLIER) };
              }
              choices.set(kind, choice);
            }
            await input.onProgress?.(kind, { state: "settling", requestId, amountUsd: String(choice.amount) });
            const admission = admissions.get(kind)!;
            if (choice.state === "conservative") await admission.settleUnknown();
            else await admission.settle(choice.amount);
            // Cache before persisting progress: a failed proof write retries only that write.
            outcomes[kind] = { requestId, state: choice.state, amountUsd: String(choice.amount) };
          }
          const outcome = outcomes[kind]!;
          await input.onProgress?.(kind, { state: outcome.state === "actual" ? "settled_actual" : "settled_conservative",
            requestId, amountUsd: outcome.amountUsd });
        }
        return { stt: outcomes.stt!, tts: outcomes.tts! };
      })();
      settlement = attempt;
      void attempt.catch(() => { if (settlement === attempt) settlement = undefined; });
      return attempt;
    },
  };
}
