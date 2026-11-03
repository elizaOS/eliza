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
  type SpeechRelayRetirementHandle,
} from "@elizaos/host/voice/speech-relay-session";
import {
  encodeSpeechRelayAudio,
  parseSpeechRelayJson,
  readConfirmedSpeechRetirement,
} from "@elizaos/host/voice/speech-relay-wire";
import {
  createWorkerCartesiaFactory,
  createWorkerCartesiaInkFactory,
} from "../v1/voice/session/lib/provider-socket-factory";
import { parseCartesiaUsdPerCredit } from "../v1/voice/stt/cartesia-pricing";
import { resolveCartesiaVoiceId } from "../v1/voice/tts/provider-selection";
import type { GenerativeRouteCaller } from "./lib/generative-route-auth";
import { reserveSpeechRelayAdmission } from "./speech-relay-admission";
import { initializeSpeechRecord, claimSpeechOpening, markSpeechOwned, beginSpeechRetirement, recordSpeechSettlement, completeSpeechRetirement, type RetirementState, type SettlementProgress } from "./speech-retirement-state";
import { speechRelayInkFactory } from "./speech-relay-ink";
import { subscribeSpeechRevocation } from "./speech-revocation-subscription";

export interface SpeechRelayBootstrap {
  sessionId: string;
  tokenDigest: string;
  expiresAt: number;
  caller: GenerativeRouteCaller;
  proofVersion?: 1;
}
type Ledger = SpeechRelayBootstrap & {
  phase: "minted" | "starting" | "active" | "retiring" | "closed";
  retirement?: RetirementState;
};
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
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
  private readonly pendingPublicSockets = new Set<WebSocket>();
  private closeTask?: Promise<void>;
  private closeFailed = false;
  private openingTask?: Promise<void>;
  private openingOwner?: { claim: string; generation: number; settled: boolean };
  private retirementHandle?: SpeechRelayRetirementHandle;
  private tts?: CartesiaSonicTtsAdapter;
  private stopped = false;
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
  private async update(change: (record: Ledger | undefined) => Ledger): Promise<Ledger> {
    const ledger = await this.state.storage.transaction(async storage => {
      const current = await storage.get<Ledger>("session");
      const next = change(current);
      if (next !== current) await storage.put("session", next);
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
    const retryCompletedAttempt = retry && (!this.closeTask || this.closeFailed);
    this.stopped = true;
    this.closeFailed = false;
    const attempt = runWithCloudBindingsAsync(this.env as Record<string, unknown>, () => runWithDbCacheAsync(async () => {
      let admitted = true;
      const started = await this.update(record => {
        if (!record) throw Error("Speech session missing");
        // Check the actual stored generation/count in the same transaction
        // that advances it. A concurrent manual revoke cannot lend an alarm
        // an extra attempt after its earlier snapshot became stale.
        admitted = !(automatic && (record.phase === "retiring" || record.phase === "closed") &&
          (record.retirement?.proof?.state === "confirmed" ||
           !this.retirementHandle && !this.relay?.retirement ||
           (record.retirement?.attempt ?? 3) >= 3 ||
           Date.now() >= (record.retirement?.retryDeadlineAt ?? 0)));
        if (!admitted) return record;
        const next = beginSpeechRetirement(record, retryCompletedAttempt);
        if (!next.retirement || next.retirement.proof?.state === "confirmed") return next;
        return { ...next, retirement: { ...next.retirement,
          retryDeadlineAt: next.retirement.retryDeadlineAt ?? Date.now() + 10000 } };
      });
      if (!admitted) return;
      let failure: unknown;
      for (const pending of this.pendingPublicSockets) {
        try { pending.close(1000, "Speech session retired"); } catch (error) { failure ??= error; }
      }
      if (started.proofVersion === 1 && started.retirement?.proof?.state === "confirmed") return;
      const token = { generation: started.retirement?.generation, attempt: started.retirement?.attempt };
      await this.openingTask?.catch(() => {});
      const handle = this.retirementHandle ?? this.relay?.retirement;
      try {
        if (handle) await (retry ? handle.retryRetirement() : handle.close());
      } catch (error) { failure = error; }
      for (const stop of [() => this.unsubscribeRevocation?.(), () => this.tts?.close(), () => this.socket?.close(1000, "Speech session closed")]) {
        try { stop(); } catch (error) { failure ??= error; }
      }
      this.unsubscribeRevocation = undefined;
      const terminalRetry = (started.retirement?.attempt ?? 3) >= 3 ||
        Date.now() + 1000 >= (started.retirement?.retryDeadlineAt ?? 0);
      if (terminalRetry && handle?.evidence()?.tts === "unknown") {
        try { await handle.finalizeUnknownTtsAccounting?.(); }
        catch (error) { failure ??= error; }
      }
      let evidence = handle?.evidence();
      const liveOpening = this.openingOwner?.settled
        ? { claim: this.openingOwner.claim, generation: this.openingOwner.generation, settled: true as const }
        : undefined;
      if (!failure && !handle && liveOpening) {
        const stopped = this.tts ? await this.tts.closeAndConfirm(2000) : "not_dispatched";
        if (stopped === "not_dispatched") evidence = { stt: "not_dispatched", tts: "not_dispatched", accounting: "not_started" };
      }
      await this.update(record => {
        if (!record) throw Error("Speech session missing");
        return completeSpeechRetirement(record, token, evidence, Date.now(), !failure, liveOpening);
      });
      // Only the still-live holder can gain new transport evidence. Bound
      // these retries; an evicted holder or exhausted attempt stays unknown.
      if (handle && this.ledger?.retirement?.proof?.state === "unconfirmed" &&
          this.ledger.retirement.attempt < 3 &&
          Date.now() + 1000 < (this.ledger.retirement.retryDeadlineAt ?? 0)) {
        await this.state.storage.setAlarm(Date.now() + 1000);
      } else await this.state.storage.deleteAlarm();
      if (failure) throw failure;
    }));
    this.closeTask = attempt;
    void attempt.then(
      () => { if (this.closeTask === attempt && this.ledger?.retirement?.proof?.state === "unconfirmed") this.closeFailed = true; },
      () => { if (this.closeTask === attempt) this.closeFailed = true; },
    );
    this.state.waitUntil(attempt.catch(() => logger.error("[speech-relay] retirement remains unconfirmed")));
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
        if (this.env.VOICE_SPEECH_RELAY_ENABLED !== "true" && !(url.pathname === "/revoke" && request.method === "POST"))
          return response(404, "speech_unavailable");
        if (url.pathname === "/initialize" && request.method === "POST") {
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
          if (input.proofVersion !== undefined && input.proofVersion !== 1) return response(400, "invalid_proof_version");
          let created = false;
          try {
            await this.update(record => {
              created = record === undefined;
              return initializeSpeechRecord(record, { sessionId: input.sessionId, tokenDigest: input.tokenDigest, expiresAt: input.expiresAt, caller: input.caller, ...(input.proofVersion ? { proofVersion: input.proofVersion } : {}), phase: "minted" }, Date.now());
            });
          } catch { return response(409, "session_exists"); }
          if (created) await this.state.storage.setAlarm(input.expiresAt);
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
          if (ledger.proofVersion === 1 && owner.proofVersion !== 1) return response(409, "proof_version_mismatch");
          try { await this.close(true); }
          catch (error) { if (owner.proofVersion !== 1) throw error; }
          if (owner.proofVersion === 1) {
            const proof = ledger.proofVersion === 1 ? this.ledger?.retirement?.proof : undefined;
            const confirmed = readConfirmedSpeechRetirement({ revoked: true, retirement: proof }, ledger.sessionId);
            if (confirmed) return Response.json({ revoked: true, retirement: confirmed });
            const unconfirmed = proof?.state === "unconfirmed" ? proof : { version: 1, sessionId: ledger.sessionId, state: "unconfirmed", reason: ledger.proofVersion === 1 ? "provider_unconfirmed" : "legacy_state" };
            return Response.json({ revoked: false, retirement: unconfirmed }, { status: 409 });
          }
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
        this.pendingPublicSockets.add(server);
        let authenticated = false,
          opening = false,
          queued = 0,
          queuedCharacters = 0,
          errorReasons = false;
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
          clearTimeout(deadline);
          // Always close this socket, even if coordinator close is already cached.
          try { server.close(1008, "Speech refused"); } catch {}
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
          if (this.stopped) { fail(undefined, "unauthorized"); return; }
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
              opening = true;
              clearTimeout(deadline);
              this.socket = server;
              // The durable claim precedes admission/provider creation. A crash or
              // a second socket can never reuse the consumed session capability.
              const task = this.open(ledger);
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
              if (queuedCharacters > SPEECH_RELAY_BUDGET.ttsCharacters)
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

  private async open(ledger: Ledger) {
    const startedAt = performance.now();
    const claim = crypto.randomUUID();
    ledger = await this.update(record => {
      if (!record) throw Error("Speech session missing");
      return claimSpeechOpening(record, claim);
    });
    const generation = ledger.retirement?.generation;
    const openingOwner = generation === undefined ? undefined : { claim, generation, settled: false };
    this.openingOwner = openingOwner;
    try {
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
        this.unsubscribeRevocation = await subscribeSpeechRevocation(
          this.env,
          ledger.caller,
          ledger.expiresAt,
          () => {
            try {
              this.send({ t: "error", code: "unauthorized" });
            } catch {}
            retireSpeech();
          },
        );
        if (this.stopped) { this.unsubscribeRevocation?.(); this.unsubscribeRevocation = undefined; throw Error("Speech opening retired"); }
        this.current();
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
        this.relay = await createSpeechRelaySession(
          {
            organizationId: ledger.caller.user.organization_id,
            userId: ledger.caller.user.id,
            cloudSessionId: ledger.sessionId,
          },
          "bootstrap-consent-consumed",
          {
            enabled: true,
            registerRetirement: handle => { this.retirementHandle = handle; },
            confirmTtsTransportStopped: () => this.tts!.closeAndConfirm(2000),
            assertCurrent: () => this.current(),
            consumeConsent: async () => true,
            usageStore,
            usageLimits: resolveVoiceUsageLimits(this.env),
            reserveCredits: async () => {
              const reservation = await reserveSpeechRelayAdmission({
                caller: ledger.caller,
                sessionId: ledger.sessionId,
                usdPerCredit: price,
                executionCtx: {
                  waitUntil: (task) => this.state.waitUntil(task),
                },
                onProgress: ledger.proofVersion === 1 ? (kind, progress: SettlementProgress) => this.update(record => {
                  if (!record) throw Error("Speech session missing");
                  return recordSpeechSettlement(record, kind, progress);
                }).then(() => {}) : undefined,
              });
              return {
                ...reservation,
                // Provider/socket callbacks can close the relay after its opening
                // request context has ended. Settlement needs this DO's bindings
                // and a fresh request-scoped DB cache at its invocation boundary.
                settle: (details, kinds) =>
                  runWithCloudBindingsAsync(
                    this.env as Record<string, unknown>,
                    () =>
                      runWithDbCacheAsync(() => reservation.settle(details, kinds)),
                  ),
              };
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
        this.current();
        await this.update(record => {
          if (!record) throw Error("Speech session missing");
          const owned = markSpeechOwned(record, claim, generation);
          if (!owned) throw Error("Speech opening was retired");
          return owned;
        });
        ready = true;
        this.send({
          t: "ready",
          version: 1,
          sampleRate: 16000,
          channels: 1,
          expiresAt: new Date(ledger.expiresAt).toISOString(),
        });
        logger.info("[SpeechRelay] bootstrap ready", {
          durationMs: Math.round(performance.now() - startedAt),
          budgetMs: SPEECH_RELAY_BUDGET.durationMs,
        });
        for (const event of events) this.send(event);
      }),
    );
    } finally {
      if (openingOwner) openingOwner.settled = true;
    }
  }
}
