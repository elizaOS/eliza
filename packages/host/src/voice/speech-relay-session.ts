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
export interface SpeechRelayIdentity extends VoiceUsageIdentity {
  cloudSessionId: string;
}
export type SpeechRelayControl =
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
  | { t: "complete"; id: string };
/** Reservation is for the fixed worst-case server-enforced budget, not client usage reports.
 * Settlement must durably retain ambiguous provider dispatch. Never automatically replay.
 */
export interface SpeechRelayCreditReservation {
  /** Present on atomic Cloud admission. Await before the matching provider factory. */
  beforeProviderDispatch(kind: "stt" | "tts"): Promise<void>;
  settle(input: {
    pcmBytes: number;
    ttsCharacters: number;
    providerMayHaveStarted: boolean;
    /** Omitted is unknown. Only a trusted provider acknowledgement may mark complete. */
    outcome?: "complete" | "unknown";
    outcomes?: { stt: "complete" | "unknown"; tts: "complete" | "unknown" };
    sttDrain?: CartesiaInkDrainReceipt;
    dispatched?: { stt: boolean; tts: boolean };
  }): Promise<void>;
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
  subscribeRevoked(
    identity: Readonly<SpeechRelayIdentity>,
    revoke: () => void,
  ): () => void;
  /** Applies public-TTS safety policy before every paid phrase dispatch. */
  assertTtsAllowed(text: string): Promise<void>;
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
  /** Trusted provider drain acknowledgement; socket-close dispatch alone is insufficient. */
  confirmProviderStopped?: () => Promise<"complete" | "unknown">;
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
  if ((value.t === "cancel" || value.t === "finish") && keys.length === 2)
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
    started = now();
  const dispatched = { stt: false, tts: false };
  let ttsUncertain = false;
  let closed = false,
    providerMayHaveStarted = false,
    pcmBytes = 0,
    ttsCharacters = 0,
    admittedTtsCharacters = 0,
    moderationText = "",
    outputBytes = 0,
    quota = false;
  let credits: SpeechRelayCreditReservation | undefined,
    stt: ReturnType<SpeechRelayPorts["openStt"]> | undefined,
    unsubscribe: (() => void) | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    closing: Promise<void> | undefined;
  const streams = new Map<string, ReturnType<SpeechRelayPorts["openTts"]>>(),
    usedIds = new Set<string>(),
    finishedIds = new Set<string>();
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    if (streams.size) ttsUncertain = true;
    if (timer) clearTimeout(timer);
    closing = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
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
      if (stt?.drain) {
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
      try {
        if (credits)
          await credits.settle({
            pcmBytes,
            ttsCharacters,
            providerMayHaveStarted,
            dispatched,
            ...(sttDrain ? { sttDrain } : {}),
            outcome,
            outcomes: {
              stt: outcome,
              tts: ttsUncertain ? "unknown" : "complete",
            },
          });
      } catch (error) {
        failures.push(error);
      }
      // Once provider work might have started, retain the admitted quota. A failed
      // transport is not proof of zero billable work; credit settlement owns reconciliation.
      try {
        if (quota && !providerMayHaveStarted)
          await ports.usageStore.release(scope, 1);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "Speech relay cleanup was not confirmed",
        );
    });
    return closing;
  };
  const retire = () => {
    ports.onClosed(close());
  };
  const current = () => {
    if (closed) throw new SpeechRelayError("closed", "Speech relay is closed");
    if (now() - started >= SPEECH_RELAY_BUDGET.durationMs) {
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
  try {
    current();
    if (!(await ports.consumeConsent(scope, consentNonce)))
      throw new SpeechRelayError("consent", "Speech consent was not verified");
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
    current();
    unsubscribe = ports.subscribeRevoked(scope, retire);
    current();
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
    timer = setTimeout(
      retire,
      Math.max(1, SPEECH_RELAY_BUDGET.durationMs - (now() - started)),
    );
    timer.unref?.();
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
      const next = pcmBytes + bytes.byteLength;
      if (
        !bytes.byteLength ||
        bytes.byteLength % 2 ||
        bytes.byteLength > SPEECH_RELAY_BUDGET.chunkBytes ||
        next > SPEECH_RELAY_BUDGET.pcmBytesPerSecond * 60 ||
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
      pcmBytes = next;
      try {
        if (!stt)
          throw new SpeechRelayError("closed", "Speech input is not ready");
        stt.sendAudioChunk(bytes);
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
            if (usedIds.size >= 64)
              throw new SpeechRelayError("payload", "Too many speech contexts");
            usedIds.add(frame.id);
          }
          finishedIds.add(frame.id);
          if (streams.has(frame.id)) ttsUncertain = true;
          streams.get(frame.id)?.cancel("speech-relay-cancelled");
          streams.delete(frame.id);
        } catch (error) {
          retire();
          throw error;
        }
        return;
      }
      if (
        finishedIds.has(frame.id) ||
        (usedIds.has(frame.id) && !streams.has(frame.id)) ||
        (!usedIds.has(frame.id) && usedIds.size >= 64) ||
        admittedTtsCharacters + frame.text.length >
          SPEECH_RELAY_BUDGET.ttsCharacters
      ) {
        retire();
        throw new SpeechRelayError(
          "payload",
          "Speech text exceeds the admitted budget",
        );
      }
      usedIds.add(frame.id);
      admittedTtsCharacters += frame.text.length;
      // Total text is bounded by the 4096-character session admission. Preserve
      // prior phrases/contexts so splitting text cannot evade the safety policy.
      moderationText += frame.text;
      try {
        await ports.assertTtsAllowed(moderationText);
        current();
        if (finishedIds.has(frame.id)) return;
        if (!credits)
          throw new SpeechRelayError(
            "closed",
            "Speech credits were not reserved",
          );
        await credits.beforeProviderDispatch("tts");
        current();
        ttsCharacters += frame.text.length;
        dispatched.tts = true;
        let stream = streams.get(frame.id);
        if (!stream)
          stream = ports.openTts(frame.id, {
            audio: (bytes) => {
              if (closed || !streams.has(frame.id)) return;
              if (
                !(bytes instanceof Uint8Array) ||
                bytes.byteLength > 65_536 ||
                outputBytes + bytes.byteLength > SPEECH_RELAY_BUDGET.outputBytes
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
        stream.sendPhrase({
          text: frame.text,
          continueContext: true,
          maxBufferDelayMs: 250,
          ...(frame.flush !== undefined ? { flush: frame.flush } : {}),
        });
      } catch (error) {
        ttsUncertain = true;
        retire();
        throw error;
      }
    },
    close,
  };
}
