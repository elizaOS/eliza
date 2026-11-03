/** Speech-only Durable Object. The caller's agent, history and tools stay on its device. */
import { createHash, timingSafeEqual } from "node:crypto";
import { runWithDbCacheAsync } from "@elizaos/cloud-shared/db/client";
import { runWithCloudBindingsAsync } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import { InsufficientCreditsError } from "@elizaos/cloud-shared/lib/services/credits";
import { createDurableVoiceUsageStore } from "@elizaos/cloud-shared/lib/services/voice-usage-meter";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import { resolveVoiceUsageLimits } from "@elizaos/cloud-shared/lib/voice-session/config";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { createCartesiaInkRealtimeSession } from "@elizaos/host/voice/cartesia-ink";
import { CartesiaSonicTtsAdapter } from "@elizaos/host/voice/cartesia-sonic-tts";
import {
  createSpeechRelaySession,
  SPEECH_RELAY_BUDGET,
} from "@elizaos/host/voice/speech-relay-session";
import {
  encodeSpeechRelayAudio,
  parseSpeechRelayJson,
} from "@elizaos/host/voice/speech-relay-wire";
import {
  createWorkerCartesiaFactory,
  createWorkerCartesiaInkFactory,
} from "../v1/voice/session/lib/provider-socket-factory";
import { parseCartesiaUsdPerCredit } from "../v1/voice/stt/cartesia-pricing";
import { resolveCartesiaVoiceId } from "../v1/voice/tts/provider-selection";
import type { GenerativeRouteCaller } from "./lib/generative-route-auth";
import { reserveSpeechRelayAdmission } from "./speech-relay-admission";
import { speechRelayInkFactory } from "./speech-relay-ink";
import { subscribeSpeechRevocation } from "./speech-revocation-subscription";

export interface SpeechRelayBootstrap {
  sessionId: string;
  tokenDigest: string;
  expiresAt: number;
  caller: GenerativeRouteCaller;
}
/** Server-side bootstrap spans. Workers clocks advance on I/O, so these are I/O waits. */
type SpeechRelayBootstrapPhase =
  | "claimMs"
  | "revocationMs"
  | "admissionMs"
  | "relayMs"
  | "activateMs"
  | "openMs";
type Ledger = SpeechRelayBootstrap & {
  phase: "minted" | "starting" | "active" | "closed";
};
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** Default renewable windows for a client that accepts `extended` frames. */
const DEFAULT_MAX_WINDOWS = 10;
/** Validates VOICE_SPEECH_RELAY_MAX_WINDOWS: an integer 1-120, default 10. */
export function resolveSpeechRelayMaxWindows(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_WINDOWS;
  const trimmed = raw.trim();
  const value = /^[0-9]+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > 120)
    throw Error("VOICE_SPEECH_RELAY_MAX_WINDOWS must be an integer 1-120");
  return value;
}
/** Windows a session may hold; a misconfigured bound disables renewal, not speech. */
export function speechRelayMaxWindows(
  env: Pick<AppEnv["Bindings"], "VOICE_SPEECH_RELAY_MAX_WINDOWS">,
): number {
  try {
    return resolveSpeechRelayMaxWindows(env.VOICE_SPEECH_RELAY_MAX_WINDOWS);
  } catch {
    logger.error("[SpeechRelay] invalid VOICE_SPEECH_RELAY_MAX_WINDOWS");
    return 1;
  }
}
export function speechTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
const response = (status: number, code: string) =>
  Response.json({ error: code }, { status });

export class SpeechRelayCoordinator {
  private ledger?: Ledger;
  private relay?: Awaited<ReturnType<typeof createSpeechRelaySession>>;
  private socket?: WebSocket;
  private pendingSocket = false;
  private closeTask?: Promise<void>;
  private tts?: CartesiaSonicTtsAdapter;
  private stopped = false;
  /** Granted budget windows; the queued-text pre-check scales with it. */
  private windows = 1;
  /** Admissions taken so far; each window has its own request IDs. */
  private reservations = 0;
  private unsubscribeRevocation?: () => void;
  constructor(
    private state: DurableObjectState,
    private env: AppEnv["Bindings"],
  ) {}

  private async load() {
    if (!this.ledger)
      this.ledger = await this.state.storage.get<Ledger>("session");
    return this.ledger;
  }
  private async save(ledger: Ledger) {
    await this.state.storage.put("session", ledger);
    this.ledger = ledger;
  }
  private current() {
    if (
      this.stopped ||
      !this.ledger ||
      (this.ledger.phase !== "active" && this.ledger.phase !== "starting") ||
      Date.now() >= this.ledger.expiresAt
    )
      throw Error("Speech session is closed");
  }
  private send(value: unknown) {
    this.current();
    if (!this.socket) throw Error("Speech socket is closed");
    this.socket.send(
      typeof value === "string" || value instanceof Uint8Array
        ? value
        : JSON.stringify(value),
    );
  }
  private close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.stopped = true;
    this.closeTask = runWithCloudBindingsAsync(
      this.env as Record<string, unknown>,
      () =>
        runWithDbCacheAsync(async () => {
          try {
            await this.relay?.close();
          } finally {
            this.unsubscribeRevocation?.();
            this.unsubscribeRevocation = undefined;
            this.tts?.close();
            this.socket?.close(1000, "Speech session closed");
            const ledger = await this.load();
            if (ledger) await this.save({ ...ledger, phase: "closed" });
            await this.state.storage.deleteAlarm();
          }
        }),
    );
    this.state.waitUntil(
      this.closeTask.catch(() =>
        logger.error("[speech-relay] settlement retained for recovery"),
      ),
    );
    return this.closeTask;
  }
  async alarm() {
    await this.close();
  }

  async fetch(request: Request): Promise<Response> {
    return runWithCloudBindingsAsync(
      this.env as Record<string, unknown>,
      async () => {
        const url = new URL(request.url);
        if (this.env.VOICE_SPEECH_RELAY_ENABLED !== "true")
          return response(404, "speech_unavailable");
        if (url.pathname === "/initialize" && request.method === "POST") {
          if (await this.load()) return response(409, "session_exists");
          const input = (await request.json()) as SpeechRelayBootstrap;
          if (
            !UUID.test(input.sessionId) ||
            !/^[0-9a-f]{64}$/.test(input.tokenDigest) ||
            !Number.isFinite(input.expiresAt) ||
            input.expiresAt <= Date.now() ||
            input.expiresAt > Date.now() + 65000 ||
            !UUID.test(input.caller?.user?.id) ||
            !UUID.test(input.caller?.user?.organization_id)
          )
            return response(400, "invalid_session");
          await this.save({ ...input, phase: "minted" });
          await this.state.storage.setAlarm(input.expiresAt);
          return Response.json({ initialized: true });
        }
        const ledger = await this.load();
        if (!ledger) return response(404, "session_not_found");
        if (url.pathname === "/revoke" && request.method === "POST") {
          const owner = (await request.json()) as {
            userId: string;
            organizationId: string;
          };
          if (
            owner.userId !== ledger.caller.user.id ||
            owner.organizationId !== ledger.caller.user.organization_id
          )
            return response(404, "session_not_found");
          await this.close();
          return Response.json({ revoked: true });
        }
        if (
          url.pathname !== "/ws" ||
          request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
        )
          return response(400, "websocket_required");
        if (
          Date.now() >= ledger.expiresAt ||
          ledger.phase !== "minted" ||
          this.pendingSocket
        )
          return response(410, "session_closed");
        this.pendingSocket = true;
        const pair = new WebSocketPair(),
          server = pair[1];
        server.binaryType = "arraybuffer";
        server.accept();
        let authenticated = false,
          opening = false,
          queued = 0,
          queuedCharacters = 0,
          errorReasons = false,
          extendable = false;
        let control = Promise.resolve();
        const prepared = new Set<string>();
        const deadline = setTimeout(
          () => server.close(1008, "Hello required"),
          5000,
        );
        const fail = (
          error?: unknown,
          code: "unavailable" | "unauthorized" = "unavailable",
        ) => {
          try {
            server.send(
              JSON.stringify({
                t: "error",
                code,
                ...(errorReasons && error instanceof InsufficientCreditsError
                  ? { reason: "insufficient_credits" }
                  : {}),
              }),
            );
          } catch {}
          if (authenticated || opening) void this.close();
          else server.close(1008, "Speech refused");
        };
        server.addEventListener("close", () => {
          clearTimeout(deadline);
          this.pendingSocket = false;
          if (authenticated || opening) void this.close();
        });
        server.addEventListener("error", fail);
        server.addEventListener("message", (event) => {
          if (!authenticated) {
            if (opening || typeof event.data !== "string") {
              fail();
              return;
            }
            try {
              const hello = parseSpeechRelayJson(event.data);
              if (
                hello.t !== "hello" ||
                !timingSafeEqual(
                  Buffer.from(speechTokenDigest(hello.token), "hex"),
                  Buffer.from(ledger.tokenDigest, "hex"),
                )
              )
                throw Error("Invalid hello");
              errorReasons = hello.errorReasons === true;
              extendable = hello.extend === true;
              opening = true;
              clearTimeout(deadline);
              this.socket = server;
              // The durable claim precedes admission/provider creation. A crash or
              // a second socket can never reuse the consumed session capability.
              void this.open(ledger, {
                reportTimings: hello.timings === true,
                extendable,
              }).then(() => {
                authenticated = true;
                opening = false;
              }, fail);
            } catch {
              fail(undefined, "unauthorized");
            }
            return;
          }
          try {
            this.current();
            if (event.data instanceof ArrayBuffer) {
              this.relay!.sendPcm(new Uint8Array(event.data));
              return;
            }
            if (typeof event.data !== "string")
              throw Error("Invalid speech frame");
            const frame = parseSpeechRelayJson(event.data);
            if (frame.t === "hello") throw Error("Repeated hello");
            // Stop/cancel preempts an in-flight moderation call. Audio never
            // queues behind text moderation or account/billing work.
            if (frame.t === "stop" || frame.t === "cancel") {
              void this.relay!.control(frame).catch(fail);
              return;
            }
            if (++queued > 64) throw Error("Speech control queue exceeded");
            if (frame.t === "tts") {
              queuedCharacters += frame.text.length;
              if (
                queuedCharacters >
                SPEECH_RELAY_BUDGET.ttsCharacters * this.windows
              )
                throw Error("Speech text budget exceeded");
            }
            control = control
              .then(() =>
                runWithCloudBindingsAsync(
                  this.env as Record<string, unknown>,
                  async () => {
                    const dispatched = await this.relay!.control(frame);
                    if (
                      (frame.t === "prepare" || frame.t === "tts") &&
                      dispatched !== false &&
                      !prepared.has(frame.id)
                    ) {
                      prepared.add(frame.id);
                      this.send({ t: "tts_prepared", id: frame.id });
                    }
                  },
                ),
              )
              .catch(fail)
              .finally(() => {
                queued--;
              });
          } catch {
            fail();
          }
        });
        return new Response(null, { status: 101, webSocket: pair[0] });
      },
    );
  }

  /** Opens the revocation fence for `expiresAt`; a revocation retires speech. */
  private subscribeFence(
    ledger: Ledger,
    expiresAt: number,
    retire: () => void,
  ) {
    return subscribeSpeechRevocation(this.env, ledger.caller, expiresAt, () => {
      try {
        this.send({ t: "error", code: "unauthorized" });
      } catch {}
      retire();
    });
  }

  /**
   * Moves the authoritative end once the relay holds the next window's quota
   * and reservation. Returns the end in force: unchanged on any refusal.
   */
  private async extend(ledger: Ledger, requested: number, retire: () => void) {
    this.current();
    const credentialEnd =
      ledger.caller.credential?.kind === "api_key" &&
      ledger.caller.credential.expiresAt != null
        ? ledger.caller.credential.expiresAt
        : Number.POSITIVE_INFINITY;
    const previousEnd = this.ledger!.expiresAt;
    const expiresAt = Math.min(requested, credentialEnd);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= previousEnd)
      return previousEnd;
    // The new fence is live before the old one is released, so revocation is
    // never unobserved; releasing the old fence never retires this session.
    const unsubscribe = await this.subscribeFence(ledger, expiresAt, retire);
    if (this.stopped) {
      unsubscribe();
      return previousEnd;
    }
    const previous = this.unsubscribeRevocation;
    this.unsubscribeRevocation = unsubscribe;
    previous?.();
    await this.save({ ...this.ledger!, expiresAt });
    await this.state.storage.setAlarm(expiresAt);
    this.windows++;
    return expiresAt;
  }

  private async open(
    ledger: Ledger,
    {
      reportTimings = false,
      extendable = false,
    }: { reportTimings?: boolean; extendable?: boolean } = {},
  ) {
    const startedAt = performance.now();
    const elapsed = (from: number) => Math.round(performance.now() - from);
    const phases: Partial<Record<SpeechRelayBootstrapPhase, number>> = {};
    await this.save({ ...ledger, phase: "starting" });
    phases.claimMs = elapsed(startedAt);
    await runWithCloudBindingsAsync(this.env as Record<string, unknown>, () =>
      runWithDbCacheAsync(async () => {
        const key = this.env.CARTESIA_API_KEY?.trim(),
          voiceId =
            this.env.VOICE_REALTIME_CARTESIA_VOICE_ID?.trim() ||
            resolveCartesiaVoiceId(this.env);
        if (!key || !voiceId)
          throw Error("Speech provider configuration unavailable");
        const price = parseCartesiaUsdPerCredit(
          this.env.CARTESIA_STT_USD_PER_CREDIT,
        );
        const usageStore = createDurableVoiceUsageStore(this.env);
        if (!usageStore) throw Error("Durable voice quota unavailable");
        let retireSpeech = () => {
          void this.close();
        };
        const retire = () => retireSpeech();
        const maxWindows = extendable ? speechRelayMaxWindows(this.env) : 1;
        // The revocation fence and paid admission are independent round trips.
        // Start the fence now and join it before any provider opens, so a
        // provider still never starts without a live revocation subscription.
        const fenceStartedAt = performance.now();
        const fence = this.subscribeFence(
          ledger,
          ledger.expiresAt,
          retire,
        ).then((unsubscribe) => {
          phases.revocationMs = elapsed(fenceStartedAt);
          if (this.stopped) unsubscribe();
          else this.unsubscribeRevocation = unsubscribe;
        });
        // A fence failure is observed when it is joined below.
        void fence.catch(() => {});
        let ready = false;
        const events: unknown[] = [];
        this.tts = new CartesiaSonicTtsAdapter({
          apiKey: key,
          voiceId,
          websocketFactory: createWorkerCartesiaFactory(),
          sampleRate: 16000,
          encoding: "pcm_s16le",
        });
        const emit = (value: unknown) => {
          if (ready) this.send(value);
          else {
            if (events.length >= 64)
              throw Error("Speech startup event budget exceeded");
            events.push(value);
          }
        };
        const relayStartedAt = performance.now();
        this.relay = await createSpeechRelaySession(
          {
            organizationId: ledger.caller.user.organization_id,
            userId: ledger.caller.user.id,
            cloudSessionId: ledger.sessionId,
          },
          "bootstrap-consent-consumed",
          {
            enabled: true,
            assertCurrent: () => this.current(),
            consumeConsent: async () => true,
            usageStore,
            usageLimits: resolveVoiceUsageLimits(this.env),
            expiresAt: ledger.expiresAt,
            maxWindows,
            ...(maxWindows > 1
              ? {
                  extend: (_identity, expiresAt) =>
                    this.extend(ledger, expiresAt, retire),
                }
              : {}),
            reserveCredits: async () => {
              const budgetWindow = this.reservations++;
              // A renewal: the session's fence is already live.
              if (budgetWindow > 0)
                return reserveSpeechRelayAdmission({
                  caller: ledger.caller,
                  sessionId: ledger.sessionId,
                  window: budgetWindow,
                  usdPerCredit: price,
                  executionCtx: {
                    waitUntil: (task) => this.state.waitUntil(task),
                  },
                });
              const admissionStartedAt = performance.now();
              const [fenced, reserved] = await Promise.allSettled([
                fence,
                reserveSpeechRelayAdmission({
                  caller: ledger.caller,
                  sessionId: ledger.sessionId,
                  usdPerCredit: price,
                  executionCtx: {
                    waitUntil: (task) => this.state.waitUntil(task),
                  },
                }).finally(() => {
                  phases.admissionMs = elapsed(admissionStartedAt);
                }),
              ]);
              if (fenced.status === "rejected") {
                // No provider opened: release any lease this bootstrap took.
                if (reserved.status === "fulfilled")
                  await reserved.value.settle({
                    pcmBytes: 0,
                    ttsCharacters: 0,
                    providerMayHaveStarted: false,
                    dispatched: { stt: false, tts: false },
                  });
                throw fenced.reason;
              }
              if (reserved.status === "rejected") throw reserved.reason;
              return reserved.value;
            },
            // The internal organization-DO socket closes on revocation or loss.
            // Its callback stops this session; no per-frame identity read occurs.
            subscribeRevoked: (_identity, revoke) => {
              retireSpeech = revoke;
              return () => this.unsubscribeRevocation?.();
            },
            openStt: (onEvent) =>
              createCartesiaInkRealtimeSession({
                cartesiaApiKey: key,
                webSocketFactory: speechRelayInkFactory(
                  createWorkerCartesiaInkFactory(),
                  this.env.VOICE_SPEECH_END_TIMEOUT_MS,
                ),
                onEvent,
              }),
            openTts: (id, callbacks) =>
              this.tts!.createStream(
                { contextId: id },
                {
                  onAudioFrame: (event) => callbacks.audio(event.bytes),
                  onComplete: callbacks.complete,
                  onFlushComplete: (event) =>
                    callbacks.flushComplete(event.flushId),
                  onProviderError: () => {
                    void this.close();
                  },
                },
              ),
            emit: (event) =>
              emit(
                event.t === "audio"
                  ? encodeSpeechRelayAudio(event.id, event.bytes)
                  : event,
              ),
            onClosed: (result) => {
              this.state.waitUntil(
                result
                  .catch(() =>
                    logger.error("[speech-relay] provider cleanup unconfirmed"),
                  )
                  .finally(() => this.close()),
              );
            },
          },
        );
        phases.relayMs = elapsed(relayStartedAt);
        this.current();
        const activeStartedAt = performance.now();
        await this.save({ ...this.ledger!, phase: "active" });
        phases.activateMs = elapsed(activeStartedAt);
        phases.openMs = elapsed(startedAt);
        ready = true;
        this.send({
          t: "ready",
          version: 1,
          sampleRate: 16000,
          channels: 1,
          expiresAt: new Date(ledger.expiresAt).toISOString(),
        });
        // Durations only, and only for a staging client that asked in hello.
        if (reportTimings && this.env.ENVIRONMENT === "staging")
          this.send({ t: "timings", ...phases });
        logger.info("[SpeechRelay] bootstrap ready", {
          durationMs: phases.openMs,
          budgetMs: SPEECH_RELAY_BUDGET.durationMs,
          maxWindows,
          ...phases,
        });
        for (const event of events) this.send(event);
      }),
    );
  }
}
