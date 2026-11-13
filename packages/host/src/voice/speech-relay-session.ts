/** Speech-only transport seam. No route, token mint, model, agent or storage is installed here.
 * Activation is off by default. Cloud must supply qualified durable credit settlement before
 * registering a route; the existing minute quota is not a substitute for paid admission.
 */
import type {
  CartesiaInkDrainReceipt,
  CartesiaInkRealtimeEvent,
  CartesiaInkRealtimeSession,
} from "./cartesia-ink";
import type { CartesiaSonicTtsStream } from "./cartesia-sonic-tts";
import type {
  SpeechRetirementEvidence,
  SpeechSettlementOutcome,
} from "./speech-relay-wire";
import { speechWindowShare } from "./speech-window-share";
import { UplinkReframer } from "./uplink-reframer";
import {
  checkVoiceByteRate,
  type VoiceUsageIdentity,
  type VoiceUsageLimits,
  type VoiceUsageStore,
} from "./usage";

export const SPEECH_RELAY_BUDGET = Object.freeze({
  durationMs: 60_000,
  pcmBytesPerSecond: 32_000,
  chunkBytes: 3_200,
  ttsCharacters: 4_096,
  phraseCharacters: 1_024,
  outputBytes: 8 * 1024 * 1024,
});
export type SpeechRelayBudget = typeof SPEECH_RELAY_BUDGET;
/** A window is renewed this long before it ends, so the next fence and
 * reservation are in place before the current one lapses. */
export const SPEECH_RELAY_RENEW_LEAD_MS = 10_000;
/** Settlement of a reservation no provider could have used. */
const UNGRANTED_SETTLEMENT = Object.freeze({
  pcmBytes: 0,
  ttsCharacters: 0,
  providerMayHaveStarted: false,
  dispatched: Object.freeze({ stt: false, tts: false }),
});
export interface SpeechRelayIdentity extends VoiceUsageIdentity {
  cloudSessionId: string;
}
/** Supplied only from the owning coordinator's acknowledged per-kind ledger. */
export interface SpeechRelayNoDispatchMoneyProof extends SpeechRelayIdentity {
  version: 1;
  stt: { requestId: string; state: "not_reserved" | "settled_actual_zero" };
  tts: { requestId: string; state: "not_reserved" | "settled_actual_zero" };
}
export type SpeechRelayControl =
  | { t: "prepare"; id: string }
  | { t: "tts"; id: string; text: string; flush?: boolean }
  | { t: "finish"; id: string }
  | { t: "cancel"; id: string }
  | { t: "stop" };
export type SpeechRelayInkEvent =
  | { type: "connected"; requestId?: string }
  | {
      type:
        | "start-of-turn"
        | "transcript-update"
        | "eager-end-of-turn"
        | "turn-resumed"
        | "end-of-turn";
      transcript: string;
      requestId?: string;
    };
export type SpeechRelayEvent =
  | { t: "tts_prepared"; id: string }
  | { t: "stt"; event: SpeechRelayInkEvent }
  | { t: "flush_complete"; id: string; flushId?: number }
  | { t: "audio"; id: string; bytes: Uint8Array }
  | { t: "complete"; id: string }
  | { t: "extended"; expiresAt: string };
/** Reservation is for the fixed worst-case server-enforced budget, not client usage reports.
 * Settlement must durably retain ambiguous provider dispatch. Never automatically replay.
 */
export interface SpeechRelayCreditReservation {
  /** Present on atomic Cloud admission. Await before the matching provider factory. */
  beforeProviderDispatch(kind: "stt" | "tts"): Promise<void>;
  /** Explicit capability: legacy reservations consume the full receipt once. */
  supportsPerKindSettlement?: true;
  settle(
    input: {
      pcmBytes: number;
      ttsCharacters: number;
      providerMayHaveStarted: boolean;
      /** Omitted is unknown. Only a trusted provider acknowledgement may mark complete. */
      outcome?: "complete" | "unknown";
      outcomes?: { stt: "complete" | "unknown"; tts: "complete" | "unknown" };
      sttDrain?: CartesiaInkDrainReceipt;
      ttsAccountingBasis?: "submitted_counter_provider_unconfirmed";
      dispatched?: { stt: boolean; tts: boolean };
    },
    kinds?: readonly ("stt" | "tts")[],
  ): Promise<void | Partial<SpeechSettlementOutcome>>;
}
export interface SpeechRelayRetirementHandle {
  close(): Promise<void>;
  retryRetirement(): Promise<void>;
  /** Live frozen counter only; settles money without asserting provider closure. */
  finalizeUnknownTtsAccounting?(): Promise<void>;
  evidence(): SpeechRetirementEvidence | undefined;
}
export interface SpeechRelayPorts {
  enabled?: boolean;
  assertCurrent(identity: Readonly<SpeechRelayIdentity>): void;
  consumeConsent(
    identity: Readonly<SpeechRelayIdentity>,
    nonce: string,
  ): Promise<boolean>;
  usageStore: VoiceUsageStore;
  usageLimits: VoiceUsageLimits;
  reserveCredits(
    identity: Readonly<SpeechRelayIdentity>,
    budget: typeof SPEECH_RELAY_BUDGET,
  ): Promise<SpeechRelayCreditReservation>;
  noDispatchMoneyProof?(
    identity: Readonly<SpeechRelayIdentity>,
  ): SpeechRelayNoDispatchMoneyProof | undefined;
  subscribeRevoked(
    identity: Readonly<SpeechRelayIdentity>,
    revoke: () => void,
  ): () => void;
  /** Factories hold provider credentials server-side and clean partial acquisitions on failure. */
  openStt(onEvent: (event: CartesiaInkRealtimeEvent) => void): Pick<
    CartesiaInkRealtimeSession,
    "sendAudioChunk" | "cancel"
  > & {
    drain?: (timeoutMs?: number) => Promise<CartesiaInkDrainReceipt>;
  };
  openTts(
    id: string,
    callbacks: {
      audio: (bytes: Uint8Array) => void;
      complete: () => void;
      flushComplete: (flushId?: number) => void;
    },
  ): Pick<CartesiaSonicTtsStream, "sendPhrase" | "finish" | "cancel">;
  emit(event: SpeechRelayEvent): void;
  onClosed(result: Promise<void>): void;
  registerRetirement?: (handle: SpeechRelayRetirementHandle) => void;
  confirmTtsTransportStopped?: () => Promise<
    "not_dispatched" | "transport_closed" | "unknown"
  >;
  /** Trusted provider drain acknowledgement; socket-close dispatch alone is insufficient. */
  confirmProviderStopped?: () => Promise<"complete" | "unknown">;
  /** Absolute end of the first window; defaults to one budget from creation. */
  expiresAt?: number;
  /**
   * Budget windows this session may hold (default 1). Each later window takes
   * another usage minute and its own full reservation before `extend` moves
   * the session's authoritative end; nothing is renewed without both.
   */
  maxWindows?: number;
  /**
   * Moves the authoritative end (revocation fence, ledger, alarm) to at most
   * `expiresAt` and returns the end it accepted. Required when `maxWindows > 1`.
   */
  extend?: (
    identity: Readonly<SpeechRelayIdentity>,
    expiresAt: number,
  ) => Promise<number>;
  now?: () => number;
}
export class SpeechRelayError extends Error {
  constructor(
    readonly code:
      | "disabled"
      | "identity"
      | "consent"
      | "quota"
      | "payload"
      | "closed"
      | "expired",
    message: string,
  ) {
    super(message);
    this.name = "SpeechRelayError";
  }
}
const object = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new SpeechRelayError("payload", "Invalid speech control");
  return input as Record<string, unknown>;
};
export function parseSpeechRelayControl(input: unknown): SpeechRelayControl {
  const value = object(input),
    keys = Object.keys(value);
  if (value.t === "stop" && keys.length === 1) return { t: "stop" };
  if (typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id))
    throw new SpeechRelayError("payload", "Invalid speech context");
  if (
    (value.t === "prepare" || value.t === "cancel" || value.t === "finish") &&
    keys.length === 2
  )
    return { t: value.t, id: value.id };
  if (
    value.t === "tts" &&
    (keys.length === 3 ||
      (keys.length === 4 &&
        typeof value.flush === "boolean" &&
        keys.includes("flush"))) &&
    typeof value.text === "string" &&
    value.text.trim() &&
    value.text.length <= SPEECH_RELAY_BUDGET.phraseCharacters
  )
    return {
      t: "tts",
      id: value.id,
      text: value.text,
      ...(typeof value.flush === "boolean" ? { flush: value.flush } : {}),
    };
  throw new SpeechRelayError("payload", "Unsupported speech control");
}
/** Construct only from authenticated server claims. Client controls contain no account,
 * provider URL/key, callback URL, agent ID, model or conversation execution parameters.
 */
export async function createSpeechRelaySession(
  identity: SpeechRelayIdentity,
  consentNonce: string,
  ports: SpeechRelayPorts,
) {
  if (ports.enabled !== true)
    throw new SpeechRelayError("disabled", "Speech-only relay is not enabled");
  const scope = Object.freeze({ ...identity });
  if (
    Object.keys(scope).length !== 3 ||
    !["organizationId", "userId", "cloudSessionId"].every((key) =>
      Object.hasOwn(scope, key),
    ) ||
    Object.values(scope).some(
      (value) =>
        typeof value !== "string" || !value.trim() || value.length > 256,
    )
  )
    throw new SpeechRelayError("identity", "Invalid speech account binding");
  if (
    typeof consentNonce !== "string" ||
    !consentNonce.trim() ||
    consentNonce.length > 256
  )
    throw new SpeechRelayError("consent", "Speech consent required");
  const now = ports.now ?? Date.now,
    started = now(),
    maxWindows = ports.maxWindows ?? 1;
  const requireRetirementProof = ports.registerRetirement !== undefined;
  if (
    !Number.isSafeInteger(maxWindows) ||
    maxWindows < 1 ||
    (maxWindows > 1 && !ports.extend)
  )
    throw new SpeechRelayError("identity", "Invalid speech window budget");
  let deadline = Math.min(
      started + SPEECH_RELAY_BUDGET.durationMs,
      ports.expiresAt ?? Number.POSITIVE_INFINITY,
    ),
    windows = 1;
  const dispatched = { stt: false, tts: false };
  let ttsUncertain = false;
  let closed = false,
    providerMayHaveStarted = false,
    receivedPcmBytes = 0,
    attemptedPcmBytes = 0,
    pcmBytes = 0,
    ttsCharacters = 0,
    admittedTtsCharacters = 0,
    outputBytes = 0,
    quota = false;
  const uplink = new UplinkReframer();
  let credits: SpeechRelayCreditReservation | undefined,
    stt: ReturnType<SpeechRelayPorts["openStt"]> | undefined,
    unsubscribe: (() => void) | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    renewTimer: ReturnType<typeof setTimeout> | undefined,
    closing: Promise<void> | undefined;
  // Every window's reservation, oldest first. Settlement fills each to its
  // own budget in order, so no reservation is charged above what it admitted.
  const reservations: SpeechRelayCreditReservation[] = [];
  const legacySettlements = new Map<
    SpeechRelayCreditReservation,
    Promise<void | Partial<SpeechSettlementOutcome>>
  >();
  const ungrantedSettlements = new Map<
    SpeechRelayCreditReservation,
    ReturnType<SpeechRelayCreditReservation["settle"]>
  >();
  let preparation: Promise<void> | undefined;
  let renewal: Promise<void> | undefined;
  let closeFailed = false;
  let closingSettled = false;
  let retirementEvidence: SpeechRetirementEvidence | undefined;
  let confirmedSttDrain: CartesiaInkDrainReceipt | undefined;
  let quotaRelease: Promise<void> | undefined;
  let renewalQuotaRelease: Promise<void> | undefined;
  const completedAccounting: Partial<SpeechSettlementOutcome> = {};
  const windowAccounting = new Map<number, Partial<SpeechSettlementOutcome>>([
    [0, completedAccounting],
  ]);
  let lastSettlementDetails:
    | Parameters<SpeechRelayCreditReservation["settle"]>[0]
    | undefined;
  let finalTtsAccounting: Promise<void> | undefined;
  const settlementInputs = new Map<
    string,
    Parameters<SpeechRelayCreditReservation["settle"]>[0]
  >();
  function windowDetails(
    details: Parameters<SpeechRelayCreditReservation["settle"]>[0],
    index: number,
  ): Parameters<SpeechRelayCreditReservation["settle"]>[0] {
    if (index >= windows) return UNGRANTED_SETTLEMENT;
    const pcmWindow =
      (SPEECH_RELAY_BUDGET.pcmBytesPerSecond * SPEECH_RELAY_BUDGET.durationMs) /
      1000;
    const share = (total: number, size: number) =>
      speechWindowShare(total, size, index, windows);
    return {
      ...details,
      pcmBytes: share(details.pcmBytes, pcmWindow),
      ttsCharacters: share(
        details.ttsCharacters,
        SPEECH_RELAY_BUDGET.ttsCharacters,
      ),
      dispatched: {
        stt:
          details.dispatched?.stt === true &&
          (index === 0 || share(attemptedPcmBytes, pcmWindow) > 0),
        tts:
          details.dispatched?.tts === true &&
          (index === 0 ||
            share(details.ttsCharacters, SPEECH_RELAY_BUDGET.ttsCharacters) >
              0),
      },
    };
  }
  function recordSettlement(
    index: number,
    kind: "stt" | "tts",
    outcome: SpeechSettlementOutcome["stt" | "tts"] | undefined,
  ) {
    if (
      index >= windows &&
      (outcome?.terminal !== true ||
        outcome.state !== "actual" ||
        outcome.amountUsd !== "0" ||
        outcome.requestId !== `speech:${scope.cloudSessionId}:${kind}:${index}`)
    )
      throw Error("Unused speech reservation settlement is unconfirmed");
    const accounting = windowAccounting.get(index) ?? {};
    windowAccounting.set(index, accounting);
    if (outcome) accounting[kind] = outcome;
  }
  async function settleKind(
    index: number,
    reservation: SpeechRelayCreditReservation,
    details: Parameters<SpeechRelayCreditReservation["settle"]>[0],
    kind: "stt" | "tts",
  ) {
    const accounting = windowAccounting.get(index) ?? {};
    windowAccounting.set(index, accounting);
    if (accounting[kind]) return;
    const key = `${index}:${kind}`;
    const fixed = settlementInputs.get(key) ?? details;
    settlementInputs.set(key, fixed);
    const result = await reservation.settle(fixed, [kind]);
    recordSettlement(index, kind, result?.[kind]);
  }
  function settleOnce(
    reservation: SpeechRelayCreditReservation,
    details: Parameters<SpeechRelayCreditReservation["settle"]>[0],
  ) {
    let settlement = legacySettlements.get(reservation);
    if (!settlement) {
      settlement = Promise.resolve().then(() => reservation.settle(details));
      legacySettlements.set(reservation, settlement);
    }
    return settlement;
  }
  async function settleUngranted(
    index: number,
    reservation: SpeechRelayCreditReservation,
  ) {
    if (!requireRetirementProof || !reservation.supportsPerKindSettlement)
      return settleOnce(reservation, UNGRANTED_SETTLEMENT);
    const failures: unknown[] = [];
    for (const kind of ["stt", "tts"] as const)
      try {
        await settleKind(index, reservation, UNGRANTED_SETTLEMENT, kind);
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Unused speech renewal was not settled",
      );
  }
  const streams = new Map<string, ReturnType<SpeechRelayPorts["openTts"]>>(),
    usedIds = new Set<string>(),
    finishedIds = new Set<string>(),
    cancelledIds = new Set<string>();
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    // Stop/revocation cannot dispatch more audio. Normal microphone silence
    // carries speech tails into complete frames before an end-of-turn event.
    uplink.flush();
    if (streams.size) ttsUncertain = true;
    if (timer) clearTimeout(timer);
    if (renewTimer) clearTimeout(renewTimer);
    closingSettled = false;
    closing = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      // Admission can still be returning a reservation when shutdown wins.
      await preparation?.catch(() => {});
      const ttsClosing = dispatched.tts
        ? Promise.resolve()
            .then(
              () =>
                ports.confirmTtsTransportStopped?.() ?? ("unknown" as const),
            )
            .catch((error) => {
              failures.push(error);
              return "unknown" as const;
            })
        : Promise.resolve("not_dispatched" as const);
      for (const cancel of [
        () => unsubscribe?.(),
        ...Array.from(
          streams.values(),
          (stream) => () => stream.cancel("speech-relay-closed"),
        ),
      ])
        try {
          cancel();
        } catch (error) {
          failures.push(error);
        }
      streams.clear();
      let sttDrained = false;
      let sttDrain: CartesiaInkDrainReceipt | undefined;
      if (confirmedSttDrain) {
        sttDrained = true;
        sttDrain = confirmedSttDrain;
      } else if (stt?.drain) {
        try {
          const receipt = await stt.drain(2000);
          sttDrained =
            receipt.source === "provider-graceful-close" &&
            receipt.audioBytes === pcmBytes &&
            receipt.sampleRate === 16000 &&
            receipt.channels === 1 &&
            receipt.encoding === "pcm_s16le";
          if (!sttDrained)
            throw Error("STT drain receipt does not match admitted audio");
          sttDrain = receipt;
          confirmedSttDrain = receipt;
        } catch (error) {
          failures.push(error);
          try {
            stt.cancel("speech-relay-drain-unconfirmed");
          } catch (cancelError) {
            failures.push(cancelError);
          }
        }
      } else
        try {
          stt?.cancel("speech-relay-closed");
        } catch (error) {
          failures.push(error);
        }
      let outcome: "complete" | "unknown" = sttDrained ? "complete" : "unknown";
      if (!stt?.drain && !failures.length && ports.confirmProviderStopped)
        try {
          outcome = await ports.confirmProviderStopped();
        } catch (error) {
          failures.push(error);
        }
      const ttsStopped = await ttsClosing;
      if (
        (requireRetirementProof || ports.confirmTtsTransportStopped) &&
        ttsStopped === "unknown"
      )
        failures.push(Error("TTS transport retirement remains unconfirmed"));
      // Stop providers before joining a slow renewal, then retain every returned
      // reservation until its settlement is acknowledged.
      await renewal?.catch((error) => failures.push(error));
      const failedUngranted = new Set<SpeechRelayCreditReservation>();
      for (const [reservation, settlement] of ungrantedSettlements) {
        try {
          await settlement;
        } catch (error) {
          failures.push(error);
          failedUngranted.add(reservation);
        }
        ungrantedSettlements.delete(reservation);
      }
      let renewalQuotaError: unknown,
        renewalQuotaFailed = false;
      if (renewalQuotaRelease)
        try {
          await renewalQuotaRelease;
        } catch (error) {
          renewalQuotaFailed = true;
          renewalQuotaError = error;
        }
      const details = {
        pcmBytes,
        ttsCharacters: ttsStopped === "not_dispatched" ? 0 : ttsCharacters,
        providerMayHaveStarted,
        dispatched: {
          ...dispatched,
          tts: ttsStopped !== "not_dispatched" && dispatched.tts,
        },
        ...(sttDrain ? { sttDrain } : {}),
        outcome,
        outcomes: {
          stt: outcome,
          tts: ttsUncertain ? ("unknown" as const) : ("complete" as const),
        },
      };
      lastSettlementDetails = details;
      if (!requireRetirementProof) {
        const pcmWindow =
            (SPEECH_RELAY_BUDGET.pcmBytesPerSecond *
              SPEECH_RELAY_BUDGET.durationMs) /
            1000,
          ttsWindow = SPEECH_RELAY_BUDGET.ttsCharacters;
        // Only the first `windows` reservations were granted; usage is capped to
        // them. A reservation taken for a renewal that was never granted cannot
        // have carried any usage, so it is released whatever the drain outcome.
        const granted = windows;
        for (const [index, reservation] of reservations.entries()) {
          if (failedUngranted.has(reservation)) continue;
          const share = (total: number, size: number) =>
            speechWindowShare(total, size, index, granted);
          try {
            let settlement = legacySettlements.get(reservation);
            if (!settlement) {
              settlement = Promise.resolve().then(() =>
                reservation.settle(
                  index < granted
                    ? {
                        pcmBytes: share(pcmBytes, pcmWindow),
                        ttsCharacters: share(ttsCharacters, ttsWindow),
                        providerMayHaveStarted,
                        dispatched: {
                          ...dispatched,
                          stt:
                            dispatched.stt &&
                            (index === 0 ||
                              share(attemptedPcmBytes, pcmWindow) > 0),
                        },
                        ...(sttDrain ? { sttDrain } : {}),
                        outcome,
                        outcomes: {
                          stt: outcome,
                          tts: ttsUncertain ? "unknown" : "complete",
                        },
                      }
                    : UNGRANTED_SETTLEMENT,
                ),
              );
              legacySettlements.set(reservation, settlement);
            }
            await settlement;
          } catch (error) {
            failures.push(error);
          }
        }
      } else if (credits) {
        for (const [index, reservation] of reservations.entries()) {
          if (failedUngranted.has(reservation)) continue;
          const accounting = windowAccounting.get(index) ?? {};
          windowAccounting.set(index, accounting);
          if (!reservation.supportsPerKindSettlement) {
            // Generic consumers retain one immutable full-receipt attempt.
            try {
              const result = await settleOnce(
                reservation,
                windowDetails(details, index),
              );
              for (const kind of ["stt", "tts"] as const)
                recordSettlement(index, kind, result?.[kind]);
            } catch (error) {
              failures.push(error);
            }
            continue;
          }
          for (const kind of ["stt", "tts"] as const) {
            if (
              accounting[kind] ||
              (kind === "tts" &&
                ttsStopped === "unknown" &&
                windowDetails(details, index).dispatched?.tts === true)
            )
              continue;
            try {
              // Freeze each window independently before the first settlement attempt.
              await settleKind(
                index,
                reservation,
                windowDetails(details, index),
                kind,
              );
            } catch (error) {
              failures.push(error);
            }
          }
        }
      }
      const canonicalActualMoney =
        requireRetirementProof &&
        reservations.length >= windows &&
        reservations.every((_, index) => {
          const accounting = windowAccounting.get(index);
          const suffix = index ? `:${index}` : "";
          return (
            accounting?.stt?.terminal === true &&
            accounting.tts?.terminal === true &&
            accounting.stt.requestId ===
              `speech:${scope.cloudSessionId}:stt${suffix}` &&
            accounting.tts.requestId ===
              `speech:${scope.cloudSessionId}:tts${suffix}` &&
            accounting.stt.state === "actual" &&
            (accounting.tts.state === "actual" ||
              (accounting.tts.state === "conservative" &&
                accounting.tts.basis ===
                  "submitted_counter_provider_unconfirmed" &&
                ttsStopped === "transport_closed"))
          );
        });
      const noDispatchProof =
        !credits && !providerMayHaveStarted
          ? ports.noDispatchMoneyProof?.(scope)
          : undefined;
      const neverDispatchedMoneyTerminal =
        noDispatchProof?.version === 1 &&
        noDispatchProof.organizationId === scope.organizationId &&
        noDispatchProof.userId === scope.userId &&
        noDispatchProof.cloudSessionId === scope.cloudSessionId &&
        (["stt", "tts"] as const).every(
          (kind) =>
            noDispatchProof[kind]?.requestId ===
              `speech:${scope.cloudSessionId}:${kind}` &&
            (noDispatchProof[kind].state === "not_reserved" ||
              noDispatchProof[kind].state === "settled_actual_zero"),
        );
      const canonicalMoneyTerminal =
        canonicalActualMoney || neverDispatchedMoneyTerminal;
      retirementEvidence = {
        ...(quotaRelease || renewalQuotaRelease
          ? {
              quotaRelease:
                renewalQuotaRelease && !renewalQuotaFailed
                  ? ("released" as const)
                  : ("unknown" as const),
            }
          : {}),
        stt: !dispatched.stt
          ? "not_dispatched"
          : sttDrained
            ? "gracefully_drained"
            : "unknown",
        tts:
          !dispatched.tts || ttsStopped === "not_dispatched"
            ? "not_dispatched"
            : ttsStopped === "transport_closed"
              ? "transport_closed"
              : "unknown",
        accounting: canonicalActualMoney
          ? "settled_actual"
          : !credits && !providerMayHaveStarted
            ? "not_started"
            : "unknown",
        ...(canonicalMoneyTerminal ? { moneyTerminal: true as const } : {}),
      };
      if (
        renewalQuotaFailed &&
        (retirementEvidence.stt === "unknown" ||
          retirementEvidence.tts === "unknown" ||
          !canonicalMoneyTerminal)
      )
        failures.push(renewalQuotaError);
      // Once provider work might have started, retain the admitted quota. A failed
      // transport is not proof of zero billable work; credit settlement owns reconciliation.
      try {
        if (quota && !providerMayHaveStarted) {
          // The additive release is not replay-safe after a lost response.
          // Retain the first promise, including rejection, across cleanup retries.
          quotaRelease ??= Promise.resolve().then(() =>
            ports.usageStore.release(scope, 1),
          );
          await quotaRelease;
          if (retirementEvidence) retirementEvidence.quotaRelease = "released";
        }
      } catch (error) {
        if (retirementEvidence) retirementEvidence.quotaRelease = "unknown";
        const providerTerminal =
          retirementEvidence &&
          retirementEvidence.stt !== "unknown" &&
          retirementEvidence.tts !== "unknown";
        const moneyTerminal = retirementEvidence?.moneyTerminal === true;
        // Keep quota possibly consumed and never repeat the additive release.
        // It cannot replace independent provider or canonical money evidence.
        if (!providerTerminal || !moneyTerminal) failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "Speech relay cleanup was not confirmed",
        );
    });
    const attempt = closing;
    void attempt.then(
      () => {
        if (closing === attempt) closingSettled = true;
      },
      () => {
        if (closing === attempt) {
          closingSettled = true;
          closeFailed = true;
        }
      },
    );
    return attempt;
  };
  const retirement: SpeechRelayRetirementHandle = {
    close,
    retryRetirement() {
      if (!requireRetirementProof) return close();
      if (closing && !closingSettled) return closing;
      if (
        closing &&
        closingSettled &&
        (closeFailed ||
          !retirementEvidence ||
          retirementEvidence.stt === "unknown" ||
          retirementEvidence.tts === "unknown" ||
          retirementEvidence.accounting === "unknown")
      ) {
        closeFailed = false;
        closing = undefined;
      }
      return close();
    },
    finalizeUnknownTtsAccounting() {
      if (
        !requireRetirementProof ||
        !closed ||
        !closingSettled ||
        !credits?.supportsPerKindSettlement ||
        !lastSettlementDetails ||
        retirementEvidence?.tts !== "unknown"
      )
        return Promise.resolve();
      if (finalTtsAccounting) return finalTtsAccounting;
      const details = lastSettlementDetails;
      const attempt = (async () => {
        for (const [index, reservation] of reservations.entries()) {
          if (!reservation.supportsPerKindSettlement) continue;
          const accounting = windowAccounting.get(index) ?? {};
          windowAccounting.set(index, accounting);
          if (accounting.tts) continue;
          const key = `${index}:tts`;
          const fixed = settlementInputs.get(key) ?? {
            ...windowDetails(details, index),
            ttsAccountingBasis:
              "submitted_counter_provider_unconfirmed" as const,
          };
          settlementInputs.set(key, fixed);
          await settleKind(index, reservation, fixed, "tts");
        }
      })();
      finalTtsAccounting = attempt;
      void attempt.catch(() => {
        if (finalTtsAccounting === attempt) finalTtsAccounting = undefined;
      });
      return attempt;
    },
    evidence: () => retirementEvidence,
  };
  const retire = () => {
    ports.onClosed(close());
  };
  const current = () => {
    if (closed) throw new SpeechRelayError("closed", "Speech relay is closed");
    if (now() >= deadline) {
      retire();
      throw new SpeechRelayError("expired", "Speech relay expired");
    }
    try {
      ports.assertCurrent(scope);
    } catch (error) {
      retire();
      throw error;
    }
  };
  const emit = (event: SpeechRelayEvent) => {
    if (closed) return;
    try {
      current();
      ports.emit(event);
    } catch {
      retire();
    }
  };
  function arm() {
    if (timer) clearTimeout(timer);
    if (renewTimer) clearTimeout(renewTimer);
    timer = setTimeout(retire, Math.max(1, deadline - now()));
    timer.unref?.();
    if (windows >= maxWindows) return;
    renewTimer = setTimeout(
      () => {
        renewal = renew();
      },
      Math.max(1, deadline - SPEECH_RELAY_RENEW_LEAD_MS - now()),
    );
    renewTimer.unref?.();
  }
  /** Failure to renew is not an error: the session still ends at `deadline`. */
  async function renew() {
    const extend = ports.extend;
    if (closed || windows >= maxWindows || !extend) return;
    // The renewal's quota minute and reservation belong to a window only once
    // `extend` has moved the authoritative end. Until then a refusal returns
    // both; the current end and every granted window's settlement are unchanged.
    let recorded = false,
      held: SpeechRelayCreditReservation | undefined;
    try {
      const usage = await ports.usageStore.checkAndRecord(
        scope,
        1,
        ports.usageLimits,
      );
      if (!usage.allowed) return;
      recorded = true;
      if (closed) return;
      held = await ports.reserveCredits(scope, SPEECH_RELAY_BUDGET);
      if (closed) return;
      if (requireRetirementProof && !held.supportsPerKindSettlement)
        throw new SpeechRelayError(
          "identity",
          "Speech renewal requires per-kind settlement",
        );
      await held.beforeProviderDispatch("stt");
      await held.beforeProviderDispatch("tts");
      if (closed || now() >= deadline) return;
      // From here closing owns this reservation (and settles it to zero
      // unless the window was granted first).
      reservations.push(held);
      const reservation = held;
      held = undefined;
      const accepted = await extend(
        scope,
        // One window past the current end at most, even if renewal ran late.
        Math.min(
          now() + SPEECH_RELAY_BUDGET.durationMs,
          deadline + SPEECH_RELAY_BUDGET.durationMs,
        ),
      );
      if (closed) return;
      if (!Number.isFinite(accepted) || accepted <= deadline) {
        reservations.splice(reservations.indexOf(reservation), 1);
        held = reservation;
        return;
      }
      deadline = accepted;
      windows++;
      recorded = false;
      arm();
      emit({ t: "extended", expiresAt: new Date(deadline).toISOString() });
    } catch {
      // Refused or failed: the current window still ends at `deadline`.
      if (!closed) {
        const index = reservations.length - 1;
        if (index >= windows) held = reservations.splice(index, 1)[0];
      }
    } finally {
      if (held) {
        const index = reservations.push(held) - 1;
        if (!closed) {
          const settlement = settleUngranted(index, held);
          ungrantedSettlements.set(held, settlement);
          // Close observes this exact attempt; only an explicit per-kind retry
          // may repeat failed credit settlement.
          await settlement.catch(() => {});
        }
      }
      if (recorded) {
        // The additive quota refund cannot be replayed after a lost response.
        renewalQuotaRelease ??= Promise.resolve().then(() =>
          ports.usageStore.release(scope, 1),
        );
        await renewalQuotaRelease.catch(() => {});
      }
    }
  }
  ports.registerRetirement?.(retirement);
  try {
    preparation = (async () => {
      current();
      if (!(await ports.consumeConsent(scope, consentNonce)))
        throw new SpeechRelayError(
          "consent",
          "Speech consent was not verified",
        );
      current();
      const admission = await ports.usageStore.checkAndRecord(
        scope,
        1,
        ports.usageLimits,
      );
      if (!admission.allowed)
        throw new SpeechRelayError("quota", "Speech quota exhausted");
      quota = true;
      current();
      credits = await ports.reserveCredits(scope, SPEECH_RELAY_BUDGET);
      reservations.push(credits);
    })();
    await preparation;
    current();
    unsubscribe = ports.subscribeRevoked(scope, retire);
    current();
    if (!credits)
      throw new SpeechRelayError(
        "closed",
        "Speech admission did not return a reservation",
      );
    await credits.beforeProviderDispatch("stt");
    current();
    providerMayHaveStarted = true;
    dispatched.stt = true;
    stt = ports.openStt((event) => {
      if (closed) return;
      if (event.type === "error" || event.type === "close") {
        retire();
        return;
      }
      if (event.type === "connected") {
        emit({
          t: "stt",
          event: {
            type: event.type,
            ...(typeof event.requestId === "string" &&
            event.requestId.length <= 256
              ? { requestId: event.requestId }
              : {}),
          },
        });
        return;
      }
      if (
        typeof event.transcript !== "string" ||
        event.transcript.length > 16384
      ) {
        retire();
        return;
      }
      emit({
        t: "stt",
        event: {
          type: event.type,
          transcript: event.transcript,
          ...(typeof event.requestId === "string" &&
          event.requestId.length <= 256
            ? { requestId: event.requestId }
            : {}),
        },
      });
    });
    current();
    arm();
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Speech relay admission failed with uncertain cleanup",
      );
    }
    throw error;
  }
  return {
    sendPcm(bytes: Uint8Array) {
      current();
      if (!(bytes instanceof Uint8Array)) {
        retire();
        throw new SpeechRelayError("payload", "Speech audio must be PCM bytes");
      }
      const next = receivedPcmBytes + bytes.byteLength;
      if (
        !bytes.byteLength ||
        bytes.byteLength % 2 ||
        bytes.byteLength > SPEECH_RELAY_BUDGET.chunkBytes ||
        next >
          (SPEECH_RELAY_BUDGET.pcmBytesPerSecond *
            SPEECH_RELAY_BUDGET.durationMs *
            windows) /
            1000 ||
        !checkVoiceByteRate({
          observedBytes: next,
          elapsedMs: now() - started,
          maxBytesPerSecond: SPEECH_RELAY_BUDGET.pcmBytesPerSecond,
        }).allowed
      ) {
        retire();
        throw new SpeechRelayError(
          "payload",
          "Speech audio exceeds the admitted format or rate",
        );
      }
      receivedPcmBytes = next;
      try {
        if (!stt)
          throw new SpeechRelayError("closed", "Speech input is not ready");
        // Native microphone packets need not align to Ink's 100 ms frames.
        // Keep admission on received bytes and settlement on actual dispatch.
        for (const frame of uplink.push(bytes)) {
          // A provider send can throw after dispatch; retain that window's risk.
          attemptedPcmBytes += frame.byteLength;
          stt.sendAudioChunk(frame);
          pcmBytes += frame.byteLength;
        }
      } catch (error) {
        retire();
        throw error;
      }
    },
    async control(input: unknown) {
      current();
      let frame: SpeechRelayControl;
      try {
        frame = parseSpeechRelayControl(input);
      } catch (error) {
        retire();
        throw error;
      }
      if (frame.t === "stop") {
        retire();
        return;
      }
      // A cancel may overtake queued phrases and finish for the same context.
      if (cancelledIds.has(frame.id)) return false;
      if (frame.t === "finish") {
        const stream = streams.get(frame.id);
        if (!stream || finishedIds.has(frame.id)) {
          retire();
          throw new SpeechRelayError("payload", "Speech context is not active");
        }
        finishedIds.add(frame.id);
        try {
          stream.finish();
        } catch (error) {
          retire();
          throw error;
        }
        return;
      }
      if (frame.t === "cancel") {
        try {
          if (!usedIds.has(frame.id)) {
            if (usedIds.size >= 64 * windows)
              throw new SpeechRelayError("payload", "Too many speech contexts");
            usedIds.add(frame.id);
          }
          finishedIds.add(frame.id);
          cancelledIds.add(frame.id);
          if (streams.has(frame.id)) ttsUncertain = true;
          streams.get(frame.id)?.cancel("speech-relay-cancelled");
          streams.delete(frame.id);
        } catch (error) {
          retire();
          throw error;
        }
        return;
      }
      // A prepare opens the context ahead of its first phrase and carries no text.
      const text = frame.t === "tts" ? frame.text : "";
      if (
        finishedIds.has(frame.id) ||
        (usedIds.has(frame.id) && !streams.has(frame.id)) ||
        (!usedIds.has(frame.id) && usedIds.size >= 64 * windows) ||
        admittedTtsCharacters + text.length >
          SPEECH_RELAY_BUDGET.ttsCharacters * windows
      ) {
        retire();
        throw new SpeechRelayError(
          "payload",
          "Speech text exceeds the admitted budget",
        );
      }
      usedIds.add(frame.id);
      admittedTtsCharacters += text.length;
      // No content review on the speech path: the phrase goes straight to
      // provider dispatch once the session's admission and budget allow it.
      let attemptedProviderForFrame = false;
      try {
        if (!credits)
          throw new SpeechRelayError(
            "closed",
            "Speech credits were not reserved",
          );
        await credits.beforeProviderDispatch("tts");
        current();
        if (cancelledIds.has(frame.id)) return false;
        attemptedProviderForFrame = true;
        ttsCharacters += text.length;
        dispatched.tts = true;
        let stream = streams.get(frame.id);
        if (!stream)
          stream = ports.openTts(frame.id, {
            audio: (bytes) => {
              if (closed || !streams.has(frame.id)) return;
              if (
                !(bytes instanceof Uint8Array) ||
                bytes.byteLength > 65_536 ||
                outputBytes + bytes.byteLength >
                  SPEECH_RELAY_BUDGET.outputBytes * windows
              ) {
                retire();
                return;
              }
              outputBytes += bytes.byteLength;
              emit({ t: "audio", id: frame.id, bytes });
            },
            flushComplete: (flushId) => {
              if (!closed && streams.has(frame.id))
                emit({
                  t: "flush_complete",
                  id: frame.id,
                  ...(typeof flushId === "number" &&
                  Number.isSafeInteger(flushId) &&
                  flushId >= 0
                    ? { flushId }
                    : {}),
                });
            },
            complete: () => {
              if (closed || !streams.delete(frame.id)) return;
              if (!finishedIds.has(frame.id)) ttsUncertain = true;
              emit({ t: "complete", id: frame.id });
            },
          });
        streams.set(frame.id, stream);
        current();
        if (frame.t === "tts")
          stream.sendPhrase({
            text: frame.text,
            continueContext: true,
            maxBufferDelayMs: 250,
            ...(frame.flush !== undefined ? { flush: frame.flush } : {}),
          });
      } catch (error) {
        // Revocation while awaiting the admission marker cannot have reached
        // this frame's provider boundary. Preserve existing uncertainty, but
        // do not invent it for text that was never submitted to a provider.
        if (attemptedProviderForFrame) ttsUncertain = true;
        retire();
        throw error;
      }
    },
    close,
    retirement,
  };
}
