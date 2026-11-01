/** Canonical subscription/usage admission for one bounded speech session.
 * Provider USD estimates do not require prepaid user credits: the common
 * admission service uses monthly subscription allowance first when applicable.
 * No per-frame database or funding work occurs.
 */
import { PLATFORM_MARKUP_MULTIPLIER } from "@elizaos/cloud-shared/lib/pricing-constants";
import { admitOrganizationInference } from "@elizaos/cloud-shared/lib/services/organization-inference-admission";
import { CARTESIA_SONIC_MODEL_ID } from "@elizaos/host/voice/cartesia-sonic-tts";
import type { SpeechRelayCreditReservation } from "@elizaos/host/voice/speech-relay-session";
import { SPEECH_RELAY_BUDGET } from "@elizaos/host/voice/speech-relay-session";
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
  try {
    // STT and TTS are independent leases on one organization authority. Admit
    // them concurrently so bootstrap pays one admission round trip, not two.
    // Every lease that succeeded is still released below if any one fails.
    const results = await Promise.allSettled(
      (["stt", "tts"] as const).map(async (kind) => {
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
      }),
    );
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
    // Arm both bounded leases once, before opening any provider. In the event
    // of a crash the existing admission alarm retains the full uncertain cost.
    // A live session can reconcile unused TTS to zero on confirmed cleanup.
    const armed = await Promise.allSettled(
      [...admissions.values()].map((admission) =>
        admission.markProviderDispatched?.(),
      ),
    );
    for (const result of armed)
      if (result.status === "rejected") throw result.reason;
  } catch (error) {
    // No provider has opened yet. Do not keep a reservation for failed bootstrap.
    await Promise.all(
      [...admissions.values()].map((admission) => admission.settle(0)),
    );
    throw error;
  }
  let settlement: Promise<void> | undefined;
  return {
    beforeProviderDispatch: async () => {},
    settle: (details) =>
      (settlement ??= (async () => {
        for (const kind of ["stt", "tts"] as const) {
          const admission = admissions.get(kind)!;
          if (details.dispatched?.[kind] !== true) {
            await admission.settle(0);
            continue;
          }
          // Cartesia TTS charges input characters. The trusted live counter is
          // an upper bound even if playback is interrupted or the provider ACK
          // is lost. Only actor loss (which skips this settlement) retains the
          // full durable reservation. STT still requires its drain receipt.
          if (kind === "stt" && details.outcomes?.stt !== "complete") {
            await admission.settleUnknown();
            continue;
          }
          const quantity =
            kind === "stt" ? details.pcmBytes / 32000 : details.ttsCharacters;
          if (
            !Number.isFinite(quantity) ||
            quantity < 0 ||
            quantity > maxima[kind]
          )
            throw Error("Speech usage exceeded its paid reservation");
          await admission.settle(
            round(quantity * rates[kind] * PLATFORM_MARKUP_MULTIPLIER),
          );
        }
      })()),
  };
}
