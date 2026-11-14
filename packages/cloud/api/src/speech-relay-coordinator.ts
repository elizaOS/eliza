/** Speech-only Durable Object. The caller's agent, history and tools stay on its device. */

import { createHash, timingSafeEqual } from "node:crypto";
import { getCloudDeployment } from "@elizaos/cloud-shared/lib/deployment/cloud-deployment";
import { runWithCloudBindingsAsync } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import { resolveVoiceUsageLimits } from "@elizaos/cloud-shared/lib/voice-session/config";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { createCartesiaInkRealtimeSession } from "@elizaos/host/voice/cartesia-ink";
import { CartesiaSonicTtsAdapter } from "@elizaos/host/voice/cartesia-sonic-tts";
import {
  createSpeechRelaySession,
  SPEECH_RELAY_BUDGET,
  type SpeechRelayRetirementHandle,
} from "@elizaos/host/voice/speech-relay-session";
import {
  encodeSpeechRelayAudio,
  parseSpeechRelayJson,
  readConfirmedSpeechRetirement,
} from "@elizaos/host/voice/speech-relay-wire";
import { v5 as uuidv5 } from "uuid";
import {
  createWorkerCartesiaFactory,
  createWorkerCartesiaInkFactory,
} from "../v1/voice/session/lib/provider-socket-factory";
import { parseCartesiaUsdPerCredit } from "../v1/voice/stt/cartesia-pricing";
import { resolveCartesiaVoiceId } from "../v1/voice/tts/provider-selection";
import type { GenerativeRouteCaller } from "./lib/generative-route-auth";
import {
  beginSpeechRetirement,
  claimSpeechOpening,
  completeSpeechRetirement,
  initializeSpeechRecord,
  markSpeechOwned,
  type RetirementState,
  recordSpeechSettlement,
  type SettlementProgress,
} from "./speech-retirement-state";
import { subscribeSpeechRevocation } from "./speech-revocation-subscription";

export interface SpeechRelayBootstrap {
  sessionId: string;
  tokenDigest: string;
  expiresAt: number;
  caller: GenerativeRouteCaller;
  proofVersion?: 1;
  consentDigest?: string;
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
  phase: "prepared" | "minted" | "starting" | "active" | "retiring" | "closed";
  retirement?: RetirementState;
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
/**
 * The session object name for one consent. /consent warms this object while
 * the client asks for /session, so the first-touch wait of a new object in
 * this Worker overlaps the client round trip instead of following it. The
 * nonce is single-use and secret to its user, and the token still gates the
 * socket, so a predictable name grants nothing. A replayed nonce reaches the
 * existing ledger, whose identity check refuses a second initialization.
 */
export function speechSessionIdForConsent(
  userId: string,
  consentNonce: string,
): string {
  const hex = createHash("sha256")
    .update(`speech-session:v1:${userId}:${consentNonce}`)
    .digest("hex");
  // RFC 9562 version 8 (custom) with the RFC variant bits.
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Stable recovery identity with a UUID version supported by existing speech clients. */
export function preparedSpeechSessionIdForConsent(
  userId: string,
  consentNonce: string,
): string {
  return uuidv5(
    `${getCloudDeployment().speechConsentOrigin}/voice/consent/${userId}/${consentNonce}`,
    uuidv5.URL,
  );
}
const response = (status: number, code: string) =>
  Response.json({ error: code }, { status });

export class SpeechRelayCoordinator {
  private ledger?: Ledger;
  private relay?: Awaited<ReturnType<typeof createSpeechRelaySession>>;
  private socket?: WebSocket;
  private pendingSocket = false;
  private readonly pendingPublicSockets = new Set<WebSocket>();
  private closeTask?: Promise<void>;
  private closeFailed = false;
  private openingTask?: Promise<void>;
  private openingOwner?: {
    claim: string;
    generation: number;
    settled: boolean;
  };
  private retirementHandle?: SpeechRelayRetirementHandle;
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
  private async update(
    change: (record: Ledger | undefined) => Ledger,
    bootstrapExpiry?: number,
  ): Promise<Ledger> {
    const ledger = await this.state.storage.transaction(async (storage) => {
      const current = await storage.get<Ledger>("session");
      const next = change(current);
      if (next !== current) {
        await storage.put("session", next);
        // SQLite storage includes this alarm in the same transaction. A
        // prepared session and its expiry must become durable together.
        if (bootstrapExpiry !== undefined)
          await this.state.storage.setAlarm(bootstrapExpiry);
      }
      return next;
    });
    this.ledger = ledger;
    return ledger;
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
  private close(retry = false, automatic = false): Promise<void> {
    if (this.closeTask && (!retry || !this.closeFailed)) return this.closeTask;
    const retryCompletedAttempt =
      retry && (!this.closeTask || this.closeFailed);
    this.stopped = true;
    this.closeFailed = false;
    const attempt = runWithCloudBindingsAsync(
      this.env as Record<string, unknown>,
      async () => {
        const { runWithDbCacheAsync } = await import(
          "@elizaos/cloud-shared/db/client"
        );
        return runWithDbCacheAsync(async () => {
          let admitted = true;
          const started = await this.update((record) => {
            if (!record) throw Error("Speech session missing");
            // Check the actual stored generation/count in the same transaction
            // that advances it. A concurrent manual revoke cannot lend an alarm
            // an extra attempt after its earlier snapshot became stale.
            admitted = !(
              automatic &&
              (record.phase === "retiring" || record.phase === "closed") &&
              (record.retirement?.proof?.state === "confirmed" ||
                (!this.retirementHandle && !this.relay?.retirement) ||
                (record.retirement?.attempt ?? 3) >= 3 ||
                Date.now() >= (record.retirement?.retryDeadlineAt ?? 0))
            );
            if (!admitted) return record;
            const next = beginSpeechRetirement(record, retryCompletedAttempt);
            if (
              !next.retirement ||
              next.retirement.proof?.state === "confirmed"
            )
              return next;
            return {
              ...next,
              retirement: {
                ...next.retirement,
                retryDeadlineAt:
                  next.retirement.retryDeadlineAt ?? Date.now() + 10000,
              },
            };
          });
          if (!admitted) {
            const handle = this.retirementHandle ?? this.relay?.retirement;
            try {
              if (
                started.retirement?.proof?.state !== "confirmed" &&
                handle?.evidence()?.tts === "unknown"
              )
                await handle.finalizeUnknownTtsAccounting?.();
            } finally {
              // A terminal automatic attempt must not silently skip its frozen-counter finalizer.
              // No new provider attempt or retry alarm is admitted here.
              await this.state.storage.deleteAlarm();
            }
            return;
          }
          let failure: unknown;
          for (const pending of this.pendingPublicSockets) {
            try {
              pending.close(1000, "Speech session retired");
            } catch (error) {
              failure ??= error;
            }
          }
          if (
            started.proofVersion === 1 &&
            started.retirement?.proof?.state === "confirmed"
          )
            return;
          const token = {
            generation: started.retirement?.generation,
            attempt: started.retirement?.attempt,
          };
          await this.openingTask?.catch(() => {});
          const handle = this.retirementHandle ?? this.relay?.retirement;
          try {
            if (handle)
              await (retry ? handle.retryRetirement() : handle.close());
          } catch (error) {
            failure = error;
          }
          for (const stop of [
            () => this.unsubscribeRevocation?.(),
            () => this.tts?.close(),
            () => this.socket?.close(1000, "Speech session closed"),
          ]) {
            try {
              stop();
            } catch (error) {
              failure ??= error;
            }
          }
          this.unsubscribeRevocation = undefined;
          const terminalRetry =
            (started.retirement?.attempt ?? 3) >= 3 ||
            Date.now() + 1000 >= (started.retirement?.retryDeadlineAt ?? 0);
          if (terminalRetry && handle?.evidence()?.tts === "unknown") {
            try {
              await handle.finalizeUnknownTtsAccounting?.();
            } catch (error) {
              failure ??= error;
            }
          }
          let evidence = handle?.evidence();
          const liveOpening = this.openingOwner?.settled
            ? {
                claim: this.openingOwner.claim,
                generation: this.openingOwner.generation,
                settled: true as const,
              }
            : undefined;
          if (!failure && !handle && liveOpening) {
            const stopped = this.tts
              ? await this.tts.closeAndConfirm(2000)
              : "not_dispatched";
            if (stopped === "not_dispatched")
              evidence = {
                stt: "not_dispatched",
                tts: "not_dispatched",
                accounting: "not_started",
              };
          }
          await this.update((record) => {
            if (!record) throw Error("Speech session missing");
            return completeSpeechRetirement(
              record,
              token,
              evidence,
              Date.now(),
              !failure,
              liveOpening,
            );
          });
          // Only the still-live holder can gain new transport evidence. Bound
          // these retries; an evicted holder or exhausted attempt stays unknown.
          if (
            handle &&
            this.ledger?.retirement?.proof?.state === "unconfirmed" &&
            this.ledger.retirement.attempt < 3 &&
            Date.now() + 1000 < (this.ledger.retirement.retryDeadlineAt ?? 0)
          ) {
            await this.state.storage.setAlarm(Date.now() + 1000);
          } else await this.state.storage.deleteAlarm();
          if (failure) throw failure;
        });
      },
    );
    this.closeTask = attempt;
    void attempt.then(
      () => {
        if (
          this.closeTask === attempt &&
          this.ledger?.retirement?.proof?.state === "unconfirmed"
        )
          this.closeFailed = true;
      },
      () => {
        if (this.closeTask === attempt) this.closeFailed = true;
      },
    );
    this.state.waitUntil(
      attempt.catch(() =>
        logger.error("[speech-relay] retirement remains unconfirmed"),
      ),
    );
    return attempt;
  }
  async alarm() {
    await this.close(true, true);
  }

  async fetch(request: Request): Promise<Response> {
    return runWithCloudBindingsAsync(
      this.env as Record<string, unknown>,
      async () => {
        const url = new URL(request.url);
        if (
          this.env.VOICE_SPEECH_RELAY_ENABLED !== "true" &&
          !(url.pathname === "/revoke" && request.method === "POST")
        )
          return response(404, "speech_unavailable");
        // Warm speech code ahead of /initialize without reserving credits or
        // opening a provider. Keep its billing graph out of Worker startup.
        if (url.pathname === "/warm" && request.method === "POST") {
          await import("./speech-relay-admission");
          return new Response(null, { status: 200 });
        }
        if (
          (url.pathname === "/prepare" || url.pathname === "/initialize") &&
          request.method === "POST"
        ) {
          const preparing = url.pathname === "/prepare";
          const input = (await request.json()) as SpeechRelayBootstrap;
          if (
            !UUID.test(input.sessionId) ||
            !/^[0-9a-f]{64}$/.test(input.tokenDigest) ||
            !Number.isFinite(input.expiresAt) ||
            input.expiresAt <= Date.now() ||
            input.expiresAt > Date.now() + (preparing ? 305000 : 65000) ||
            !UUID.test(input.caller?.user?.id) ||
            !UUID.test(input.caller?.user?.organization_id)
          )
            return response(400, "invalid_session");
          if (input.proofVersion !== undefined && input.proofVersion !== 1)
            return response(400, "invalid_proof_version");
          if (
            preparing &&
            (input.proofVersion !== 1 || input.consentDigest !== undefined)
          )
            return response(400, "invalid_preparation");
          if (
            input.consentDigest !== undefined &&
            (input.proofVersion !== 1 ||
              !/^[0-9a-f]{64}$/.test(input.consentDigest))
          )
            return response(400, "invalid_preparation");
          try {
            await this.update((record) => {
              if (input.consentDigest !== undefined) {
                if (
                  !record ||
                  record.phase !== "prepared" ||
                  record.expiresAt <= Date.now() ||
                  record.sessionId !== input.sessionId ||
                  record.tokenDigest !== input.consentDigest ||
                  record.caller.user.id !== input.caller.user.id ||
                  record.caller.user.organization_id !==
                    input.caller.user.organization_id
                )
                  throw Error("Speech preparation is absent or retired");
                return {
                  ...record,
                  phase: "minted",
                  tokenDigest: input.tokenDigest,
                  expiresAt: input.expiresAt,
                  caller: input.caller,
                };
              }
              if (record?.phase === "prepared" && !preparing)
                throw Error("Prepared speech requires its original consent");
              return initializeSpeechRecord(
                record,
                {
                  sessionId: input.sessionId,
                  tokenDigest: input.tokenDigest,
                  expiresAt: input.expiresAt,
                  caller: input.caller,
                  ...(input.proofVersion
                    ? { proofVersion: input.proofVersion }
                    : {}),
                  phase: preparing ? "prepared" : "minted",
                },
                Date.now(),
              );
            }, input.expiresAt);
          } catch {
            return response(409, "session_exists");
          }
          return Response.json({ initialized: true });
        }
        const ledger = await this.load();
        if (!ledger) return response(404, "session_not_found");
        if (url.pathname === "/revoke" && request.method === "POST") {
          const owner = (await request.json()) as {
            userId: string;
            organizationId: string;
            proofVersion?: 1;
          };
          if (
            owner.userId !== ledger.caller.user.id ||
            owner.organizationId !== ledger.caller.user.organization_id
          )
            return response(404, "session_not_found");
          if (ledger.proofVersion === 1 && owner.proofVersion !== 1)
            return response(409, "proof_version_mismatch");
          try {
            await this.close(true);
          } catch (error) {
            if (owner.proofVersion !== 1) throw error;
          }
          if (owner.proofVersion === 1) {
            const proof =
              ledger.proofVersion === 1
                ? this.ledger?.retirement?.proof
                : undefined;
            const confirmed = readConfirmedSpeechRetirement(
              { revoked: true, retirement: proof },
              ledger.sessionId,
            );
            if (confirmed)
              return Response.json({ revoked: true, retirement: confirmed });
            const unconfirmed =
              proof?.state === "unconfirmed"
                ? proof
                : {
                    version: 1,
                    sessionId: ledger.sessionId,
                    state: "unconfirmed",
                    reason:
                      ledger.proofVersion === 1
                        ? "provider_unconfirmed"
                        : "legacy_state",
                  };
            return Response.json(
              { revoked: false, retirement: unconfirmed },
              { status: 409 },
            );
          }
          return Response.json({ revoked: true });
        }
        if (
          url.pathname !== "/ws" ||
          request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
        )
          return response(400, "websocket_required");
        const { InsufficientCreditsError } = await import(
          "@elizaos/cloud-shared/lib/services/credits"
        );
        if (
          this.stopped ||
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
        this.pendingPublicSockets.add(server);
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
          if (error instanceof InsufficientCreditsError) {
            logger.error("[SpeechRelay] credit admission refused", {
              organizationId: ledger.caller.user.organization_id,
              sessionId: ledger.sessionId,
              requiredUsd: error.required,
              availableUsd: error.available,
              reason: error.reason,
            });
          }
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
          clearTimeout(deadline);
          // Always close this socket, even if coordinator close is already cached.
          try {
            server.close(1008, "Speech refused");
          } catch {}
          if (authenticated || opening) void this.close();
        };
        server.addEventListener("close", () => {
          this.pendingPublicSockets.delete(server);
          clearTimeout(deadline);
          this.pendingSocket = false;
          if (authenticated || opening) void this.close();
        });
        server.addEventListener("error", fail);
        server.addEventListener("message", (event) => {
          if (this.stopped) {
            fail(undefined, "unauthorized");
            return;
          }
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
              const task = this.open(ledger, {
                reportTimings: hello.timings === true,
                extendable: hello.extend === true,
              });
              this.openingTask = task;
              void task.then(() => {
                this.pendingPublicSockets.delete(server);
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
    let updated: Ledger;
    try {
      updated = await this.update((record) => {
        if (!record) throw Error("Speech session missing");
        if (
          this.stopped ||
          record.sessionId !== ledger.sessionId ||
          record.expiresAt !== previousEnd ||
          Date.now() >= record.expiresAt ||
          (record.phase !== "starting" && record.phase !== "active")
        )
          return record;
        return { ...record, expiresAt };
      });
    } catch (error) {
      unsubscribe();
      throw error;
    }
    if (this.stopped || updated.expiresAt !== expiresAt) {
      unsubscribe();
      return previousEnd;
    }
    const previous = this.unsubscribeRevocation;
    this.unsubscribeRevocation = unsubscribe;
    previous?.();
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
    const claim = crypto.randomUUID();
    ledger = await this.update((record) => {
      if (!record) throw Error("Speech session missing");
      return claimSpeechOpening(record, claim);
    });
    const generation = ledger.retirement?.generation;
    const openingOwner =
      generation === undefined
        ? undefined
        : { claim, generation, settled: false };
    this.openingOwner = openingOwner;
    try {
      phases.claimMs = elapsed(startedAt);
      const [
        { runWithDbCacheAsync },
        { createDurableVoiceUsageStore },
        { reserveSpeechRelayAdmission },
      ] = await Promise.all([
        import("@elizaos/cloud-shared/db/client"),
        import("@elizaos/cloud-shared/lib/services/voice-usage-meter"),
        import("./speech-relay-admission"),
      ]);
      this.current();
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
          const fence = this.subscribeFence(ledger, ledger.expiresAt, () => {
            try {
              this.send({ t: "error", code: "unauthorized" });
            } catch {}
            retireSpeech();
          }).then((unsubscribe) => {
            phases.revocationMs = elapsed(fenceStartedAt);
            if (this.stopped) {
              unsubscribe();
              throw Error("Speech opening retired");
            }
            this.unsubscribeRevocation = unsubscribe;
          });
          void fence.catch(() => {});
          if (ledger.proofVersion === 1) {
            await fence;
            this.current();
          }
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
              ...(ledger.proofVersion === 1
                ? {
                    registerRetirement: (
                      handle: SpeechRelayRetirementHandle,
                    ) => {
                      this.retirementHandle = handle;
                    },
                  }
                : {}),
              confirmTtsTransportStopped: () => this.tts!.closeAndConfirm(2000),
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
              noDispatchMoneyProof: (identity) => {
                const current = this.ledger;
                if (
                  !current?.retirement ||
                  current.sessionId !== identity.cloudSessionId ||
                  current.caller.user.id !== identity.userId ||
                  current.caller.user.organization_id !==
                    identity.organizationId
                )
                  return undefined;
                const progressByKind = current.retirement.progress;
                const terminal = (kind: "stt" | "tts") => {
                  const progress = progressByKind[kind];
                  // Initial never-attempted state or a typed pre-reservation refusal is terminal.
                  // A reserving/lost-ack/unconfirmed state is never promoted from absence.
                  if (progress.state === "not_reserved")
                    return {
                      requestId: `speech:${current.sessionId}:${kind}`,
                      state: "not_reserved" as const,
                    };
                  if (
                    progress.state === "settled_actual" &&
                    progress.requestId ===
                      `speech:${current.sessionId}:${kind}` &&
                    progress.amountUsd === "0"
                  )
                    return {
                      requestId: progress.requestId,
                      state: "settled_actual_zero" as const,
                    };
                  return undefined;
                };
                const stt = terminal("stt"),
                  tts = terminal("tts");
                return stt && tts
                  ? { version: 1 as const, ...identity, stt, tts }
                  : undefined;
              },
              reserveCredits: async () => {
                const budgetWindow = this.reservations++;
                const reserve = async () => {
                  const reservation = await reserveSpeechRelayAdmission({
                    caller: ledger.caller,
                    sessionId: ledger.sessionId,
                    window: budgetWindow,
                    usdPerCredit: price,
                    executionCtx: {
                      waitUntil: (task) => this.state.waitUntil(task),
                    },
                    onProgress:
                      ledger.proofVersion === 1
                        ? (kind, progress: SettlementProgress) =>
                            this.update((record) => {
                              if (!record)
                                throw Error("Speech session missing");
                              return recordSpeechSettlement(
                                record,
                                kind,
                                progress,
                                budgetWindow,
                              );
                            }).then(() => {})
                        : undefined,
                  });
                  // Cleanup can run from a socket callback after the opening
                  // request ended. Rebind the Worker and start a fresh DB cache.
                  return {
                    ...reservation,
                    settle: (
                      details: Parameters<typeof reservation.settle>[0],
                      kinds?: Parameters<typeof reservation.settle>[1],
                    ) =>
                      runWithCloudBindingsAsync(
                        this.env as Record<string, unknown>,
                        () =>
                          runWithDbCacheAsync(() =>
                            reservation.settle(details, kinds),
                          ),
                      ),
                  };
                };
                let reservation: Awaited<ReturnType<typeof reserve>>;
                if (budgetWindow > 0) reservation = await reserve();
                else {
                  const admissionStartedAt = performance.now();
                  const [fenced, reserved] = await Promise.allSettled([
                    fence,
                    reserve().finally(() => {
                      phases.admissionMs = elapsed(admissionStartedAt);
                    }),
                  ]);
                  if (fenced.status === "rejected") {
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
                  reservation = reserved.value;
                }
                return reservation;
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
                  webSocketFactory: createWorkerCartesiaInkFactory(),
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
                      logger.error(
                        "[speech-relay] provider cleanup unconfirmed",
                      ),
                    )
                    .finally(() => this.close()),
                );
              },
            },
          );
          phases.relayMs = elapsed(relayStartedAt);
          this.current();
          const activeStartedAt = performance.now();
          await this.update((record) => {
            if (!record) throw Error("Speech session missing");
            const owned = markSpeechOwned(record, claim, generation);
            if (!owned) throw Error("Speech opening was retired");
            return owned;
          });
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
    } finally {
      if (openingOwner) openingOwner.settled = true;
    }
  }
}
