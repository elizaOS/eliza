/**
 * TEST-HARNESS-ONLY reference implementation of the section-7 voice-session
 * WebSocket contract (VOICE-INTEGRATION-DECISION-2026-07-10.md §7). It exists so
 * the provider legs can be proven REAL *now*, before the production
 * `feat/voice-session-ws-phase1` server branch is assembled.
 *
 * THIS IS NOT A SECOND PRODUCTION VOICE SERVICE. It:
 *   - speaks the exact §7 wire protocol (hello, ready, stt events, llm_first_text,
 *     speaking_start/end, interrupted, error, binary uplink+downlink PCM),
 *   - drives the REAL merged adapters:
 *       packages/cloud/api/v1/voice/stt/providers/deepgram-flux.ts  (LIVE Deepgram)
 *       packages/cloud/shared/src/lib/services/cartesia-sonic-tts.ts (LIVE Cartesia)
 *   - bridges the STT final -> a REAL streaming LLM -> Cartesia,
 *   - implements the §7.5 interruption pipeline (cancel TTS, abort LLM, flush
 *     downlink, assert zero post-interrupt frames).
 *
 * It owns NO production auth/billing/history. The mint here issues a local
 * short-lived HMAC token purely to exercise the auth handshake shape (§7.1);
 * it is not the production JWT/JWKS. Marked loudly as harness-only.
 */

import { createHmac, randomUUID } from "node:crypto";
import {
  CartesiaSonicTtsAdapter,
  type CartesiaSonicTtsStream,
} from "@harness-adapters/cartesia-sonic-tts.ts";

import {
  createDeepgramFluxRealtimeSession,
  DEEPGRAM_FLUX_CHUNK_BYTES,
  type DeepgramFluxRealtimeEvent,
  type DeepgramFluxRealtimeSession,
} from "@harness-adapters/deepgram-flux.ts";
import type { ServerWebSocket } from "bun";

import { makeCartesiaFactory, makeDeepgramFactory } from "../ws-factories.ts";
import { type LlmStreamConfig, streamLlmReply } from "./llm-bridge.ts";

const HARNESS_MINT_SECRET = `harness-only-not-production-${randomUUID()}`;
const TOKEN_TTL_MS = 120_000;

export interface ProviderConfig {
  deepgramApiKey: string;
  cartesiaApiKey: string;
  cartesiaVoiceId: string;
  llm: LlmStreamConfig;
}

export interface ServerHooks {
  /** structured server-side log sink (evidence). */
  log: (
    level: "info" | "warn" | "error",
    msg: string,
    data?: Record<string, unknown>,
  ) => void;
  /** record an s2c control/audio event as it leaves the server (evidence). */
  onServerEmit?: (
    kind: "json" | "binary",
    payload: Record<string, unknown>,
  ) => void;
  /** the domain-artifact sink: session + transcript rows the server "persists". */
  onDomainRow?: (row: DomainRow) => void;
}

export type DomainRow =
  | {
      table: "voice_sessions";
      id: string;
      agentId: string;
      conversationId: string;
      createdAtMs: number;
      endedAtMs?: number;
      status: string;
    }
  | {
      table: "voice_transcripts";
      sessionId: string;
      role: "user" | "assistant";
      text: string;
      committedAtMs: number;
      traceId: string;
    };

interface SessionState {
  sessionId: string;
  agentId: string;
  conversationId: string;
  traceId: string;
  createdAtMs: number;
  flux?: DeepgramFluxRealtimeSession;
  tts?: CartesiaSonicTtsStream;
  llmAbort?: AbortController;
  speaking: boolean;
  interrupted: boolean;
  postInterruptFrameCount: number;
  ttsFrameCount: number;
  finalCommitted: boolean;
  assistantText: string;
}

// ---- §7.1 mint (HARNESS token, not production JWT) ----
export function mintHarnessToken(
  agentId: string,
  conversationId: string,
): {
  sessionId: string;
  token: string;
  expiresAt: number;
} {
  const sessionId = randomUUID();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = JSON.stringify({
    sessionId,
    agentId,
    conversationId,
    aud: "voice-session",
    exp: expiresAt,
  });
  const sig = createHmac("sha256", HARNESS_MINT_SECRET)
    .update(payload)
    .digest("base64url");
  const token = `${Buffer.from(payload).toString("base64url")}.${sig}`;
  return { sessionId, token, expiresAt };
}

function verifyHarnessToken(
  token: string,
): { sessionId: string; agentId: string; conversationId: string } | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const payload = Buffer.from(body, "base64url").toString("utf8");
  const expect = createHmac("sha256", HARNESS_MINT_SECRET)
    .update(payload)
    .digest("base64url");
  if (sig !== expect) return null;
  const j = JSON.parse(payload);
  if (
    j.aud !== "voice-session" ||
    typeof j.exp !== "number" ||
    Date.now() > j.exp
  )
    return null;
  return {
    sessionId: j.sessionId,
    agentId: j.agentId,
    conversationId: j.conversationId,
  };
}

interface WsData {
  session?: SessionState;
  faultInjection?: "deepgram-auth-fail" | "mid-stream-disconnect";
}

export interface StartServerOptions {
  providers: ProviderConfig;
  hooks: ServerHooks;
  port?: number;
  /**
   * Force a provider auth failure for the error-path scenario by overriding the
   * Deepgram key with a deliberately-bad one on this server instance.
   */
  faultInjection?: "deepgram-auth-fail" | "mid-stream-disconnect";
}

export interface RunningServer {
  port: number;
  wsUrl: string;
  mint(
    agentId: string,
    conversationId: string,
  ): { sessionId: string; token: string; wsUrl: string; expiresAt: number };
  stop(): void;
}

export function startReferenceServer(opts: StartServerOptions): RunningServer {
  const { providers, hooks } = opts;
  const port = opts.port ?? 0;

  const emit = (ws: ServerWebSocket<WsData>, obj: Record<string, unknown>) => {
    hooks.onServerEmit?.("json", obj);
    ws.send(JSON.stringify(obj));
  };
  const emitBinary = (
    ws: ServerWebSocket<WsData>,
    bytes: Uint8Array,
    meta: Record<string, unknown>,
  ) => {
    hooks.onServerEmit?.("binary", { ...meta, byteLength: bytes.byteLength });
    ws.send(bytes);
  };

  const server = Bun.serve<WsData>({
    port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/voice/session/ws") {
        const ok = srv.upgrade(req, {
          data: { faultInjection: opts.faultInjection },
        });
        if (ok) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      async message(ws, message) {
        const data = ws.data;
        // Binary frame => uplink audio
        if (message instanceof Buffer || message instanceof Uint8Array) {
          handleUplinkAudio(ws, message as Uint8Array);
          return;
        }
        // Text frame => JSON control
        let ctrl: Record<string, unknown>;
        try {
          ctrl = JSON.parse(String(message));
        } catch (ignoredError) {
          void ignoredError;
          emit(ws, { t: "error", code: "bad_json", retryable: false });
          return;
        }
        const t = ctrl.t;
        if (t === "hello") {
          await handleHello(ws, ctrl);
        } else if (t === "barge_in") {
          handleBargeIn(ws, "explicit");
        } else if (t === "bye") {
          teardown(ws, "client-bye");
        } else if (t === "end_audio") {
          // harness signal: uplink finished, ask Flux to finalize
          data.session?.flux?.close("client-end");
        }
      },
      close(ws) {
        teardown(ws, "socket-close");
      },
    },
  });

  async function handleHello(
    ws: ServerWebSocket<WsData>,
    ctrl: Record<string, unknown>,
  ) {
    const token = String(ctrl.token ?? "");
    const claims = verifyHarnessToken(token);
    if (!claims) {
      hooks.log("warn", "hello rejected: bad token");
      emit(ws, { t: "error", code: "auth_failed", retryable: false });
      ws.close(1008, "auth");
      return;
    }
    const traceId = randomUUID();
    const state: SessionState = {
      sessionId: claims.sessionId,
      agentId: claims.agentId,
      conversationId: claims.conversationId,
      traceId,
      createdAtMs: Date.now(),
      speaking: false,
      interrupted: false,
      postInterruptFrameCount: 0,
      ttsFrameCount: 0,
      finalCommitted: false,
      assistantText: "",
    };
    ws.data.session = state;
    hooks.onDomainRow?.({
      table: "voice_sessions",
      id: state.sessionId,
      agentId: state.agentId,
      conversationId: state.conversationId,
      createdAtMs: state.createdAtMs,
      status: "open",
    });

    // Build the REAL Deepgram Flux session (LIVE provider, unless fault-injected).
    const deepgramKey =
      ws.data.faultInjection === "deepgram-auth-fail"
        ? "dg_intentionally_invalid_key_for_error_path"
        : providers.deepgramApiKey;

    let fluxConnected = false;
    let resolveFluxOpen!: () => void;
    const fluxOpen = new Promise<void>((r) => (resolveFluxOpen = r));
    try {
      state.flux = createDeepgramFluxRealtimeSession({
        deepgramApiKey: deepgramKey,
        webSocketFactory: makeDeepgramFactory({
          log: (msg, data) => hooks.log("info", msg, data),
        }),
        hooks: {
          onMetric: (m) => {
            if (m.name === "deepgram_flux_connected") {
              fluxConnected = true;
              resolveFluxOpen();
            }
          },
        },
        onEvent: (ev) => onFluxEvent(ws, ev),
      });
      hooks.log("info", "deepgram flux session created", {
        url: state.flux.url,
      });
    } catch (err) {
      hooks.log("error", "flux session create failed", { error: String(err) });
      emit(ws, { t: "error", code: "stt_init_failed", retryable: false });
      return;
    }

    // §7.4: only signal `ready` (client starts uplink) once the STT provider
    // socket is actually open, so no audio is dropped pre-upgrade.
    const readyTimeout = setTimeout(() => {
      if (!fluxConnected) resolveFluxOpen();
    }, 5_000);
    await fluxOpen;
    clearTimeout(readyTimeout);
    if (!fluxConnected) {
      hooks.log("error", "flux failed to connect before ready timeout");
      emit(ws, { t: "error", code: "stt_connect_timeout", retryable: true });
      return;
    }

    emit(ws, { t: "ready", sessionId: state.sessionId, traceId });
    hooks.log("info", "session ready", { sessionId: state.sessionId, traceId });
  }

  function onFluxEvent(
    ws: ServerWebSocket<WsData>,
    ev: DeepgramFluxRealtimeEvent,
  ) {
    const state = ws.data.session;
    if (!state) return;
    switch (ev.type) {
      case "start-of-turn":
        hooks.log("info", "flux start-of-turn");
        break;
      case "transcript-update":
        emit(ws, {
          t: "stt_partial",
          text: ev.transcript,
          traceId: state.traceId,
        });
        break;
      case "eager-end-of-turn":
        emit(ws, { t: "stt_eager_eot", traceId: state.traceId });
        break;
      case "end-of-turn":
        commitFinalAndReply(ws, ev.transcript);
        break;
      case "error": {
        // The merged adapter (#15950) does not model Flux's benign `Connected`
        // handshake frame and surfaces it as a malformed_event. That is a
        // NON-FATAL adapter gap: log it, but do NOT tear the session down over a
        // handshake ack. Real provider/transport errors still propagate.
        const benignHandshake =
          ev.code === "malformed_event" && /Connected/.test(ev.message);
        if (benignHandshake) {
          hooks.log(
            "warn",
            "flux benign Connected frame not modeled by adapter (#15950 gap)",
            {
              message: ev.message,
            },
          );
          break;
        }
        hooks.log("error", "flux provider error", {
          code: ev.code,
          message: ev.message,
        });
        emit(ws, { t: "error", code: `stt_${ev.code}`, retryable: false });
        break;
      }
      case "close":
        hooks.log("info", "flux closed", { code: ev.code, reason: ev.reason });
        break;
    }
  }

  function handleUplinkAudio(ws: ServerWebSocket<WsData>, bytes: Uint8Array) {
    const state = ws.data.session;
    if (!state?.flux) return;
    // §7.2: service re-frames to Deepgram's exact 2560-byte chunk boundary.
    // The harness client already sends exact chunks, but re-assert the invariant.
    if (bytes.byteLength !== DEEPGRAM_FLUX_CHUNK_BYTES) {
      hooks.log("warn", "uplink chunk wrong size (dropping)", {
        byteLength: bytes.byteLength,
      });
      return;
    }
    try {
      state.flux.sendAudioChunk(bytes);
      // mid-stream-disconnect fault: after some audio, kill the flux socket
      if (
        ws.data.faultInjection === "mid-stream-disconnect" &&
        Math.random() < 0.02
      ) {
        hooks.log("warn", "fault: forcing mid-stream flux disconnect");
        state.flux.cancel("fault-injection-disconnect");
      }
    } catch (err) {
      hooks.log("error", "uplink send failed", { error: String(err) });
    }
  }

  async function commitFinalAndReply(
    ws: ServerWebSocket<WsData>,
    transcript: string,
  ) {
    const state = ws.data.session;
    if (!state || state.finalCommitted) return;
    state.finalCommitted = true;
    emit(ws, { t: "stt_final", text: transcript, traceId: state.traceId });
    hooks.onDomainRow?.({
      table: "voice_transcripts",
      sessionId: state.sessionId,
      role: "user",
      text: transcript,
      committedAtMs: Date.now(),
      traceId: state.traceId,
    });
    hooks.log("info", "stt_final committed", { chars: transcript.length });

    // ---- LLM leg (real streaming) ----
    state.llmAbort = new AbortController();
    const tts = new CartesiaSonicTtsAdapter({
      apiKey: providers.cartesiaApiKey,
      voiceId: providers.cartesiaVoiceId,
      websocketFactory: makeCartesiaFactory({
        log: (msg, data) => hooks.log("info", msg, data),
      }),
      sampleRate: 16000,
      encoding: "pcm_s16le",
    }).createStream(
      { traceId: state.traceId },
      {
        onFirstAudio: (e) => {
          state.speaking = true;
          emit(ws, { t: "speaking_start", traceId: state.traceId });
          hooks.log("info", "cartesia first audio", { elapsedMs: e.elapsedMs });
        },
        onAudioFrame: (f) => {
          if (state.interrupted) {
            // §7.5 correctness assertion: NO downlink frames after interrupt.
            state.postInterruptFrameCount++;
            hooks.log("error", "POST-INTERRUPT FRAME LEAKED", {
              sequence: f.sequence,
            });
            return;
          }
          state.ttsFrameCount++;
          emitBinary(ws, f.bytes, {
            t: "audio",
            codec: "pcm16",
            sequence: f.sequence,
          });
        },
        onComplete: (c) => {
          emit(ws, { t: "speaking_end", traceId: state.traceId });
          hooks.log("info", "cartesia complete", { frameCount: c.frameCount });
        },
        onProviderError: (e) => {
          hooks.log("error", "cartesia provider error", {
            code: e.code,
            message: e.message,
          });
          emit(ws, {
            t: "error",
            code: `tts_${e.code ?? "provider_error"}`,
            retryable: false,
          });
        },
        onCancelled: () => {
          hooks.log("info", "cartesia cancelled");
        },
      },
    );
    state.tts = tts;

    await tts.opened.catch((err) => {
      hooks.log("error", "cartesia stream open failed", { error: String(err) });
    });

    // §10 phrase aggregation: a SINGLE policy. Stream each completed sentence as
    // a Cartesia phrase with `continueContext` so audio starts before the LLM is
    // done, and mark the LAST phrase so we close the context exactly once via
    // that phrase's completion (never send an empty trailing phrase into an
    // already-completing context -> that races into "Context closed").
    let sentenceBuf = "";
    let phrasesSent = 0;
    const sendPhraseSafe = (text: string, last: boolean) => {
      if (state.interrupted || !text.trim()) return;
      try {
        // `continue:false` on the final phrase tells Cartesia this context is
        // complete after synthesizing it -> yields onComplete, no empty finish.
        tts.sendPhrase({ text, continueContext: !last });
        phrasesSent++;
      } catch (ignoredError) {
        void ignoredError;
        /* stream may be cancelled by interrupt */
      }
    };
    await streamLlmReply(transcript, providers.llm, state.llmAbort.signal, {
      onFirstText: () => {
        emit(ws, { t: "llm_first_text", traceId: state.traceId });
        hooks.log("info", "llm first text");
      },
      onDelta: (text) => {
        if (state.interrupted) return;
        state.assistantText += text;
        sentenceBuf += text;
        // flush a phrase to TTS at each sentence boundary (not the last one; we
        // don't yet know if more sentences follow, so keep the context open)
        const match = sentenceBuf.match(/^(.*?[.!?])(\s+)([\s\S]*)$/);
        if (match) {
          sendPhraseSafe(match[1] + match[2], false);
          sentenceBuf = match[3];
        }
      },
      onDone: (full) => {
        if (!state.interrupted) {
          // The trailing text (or, if no sentence ever flushed, the whole reply)
          // is the LAST phrase: send it with continue:false to close the context
          // cleanly. If everything already flushed, send a final continue:false
          // empty marker only when at least one phrase went out.
          const tail = sentenceBuf.trim();
          if (tail) {
            sendPhraseSafe(sentenceBuf, true);
          } else if (phrasesSent > 0) {
            try {
              tts.finish();
            } catch (ignoredError) {
              void ignoredError;
              /* already closing */
            }
          }
          if (full) {
            hooks.onDomainRow?.({
              table: "voice_transcripts",
              sessionId: state.sessionId,
              role: "assistant",
              text: full,
              committedAtMs: Date.now(),
              traceId: state.traceId,
            });
          }
        }
        hooks.log("info", "llm done", {
          chars: full.length,
          interrupted: state.interrupted,
        });
      },
      onError: (err) => {
        hooks.log("error", "llm error", { error: String(err) });
        emit(ws, { t: "error", code: "llm_error", retryable: true });
      },
    });
  }

  function handleBargeIn(
    ws: ServerWebSocket<WsData>,
    reason: "acoustic" | "explicit",
  ) {
    const state = ws.data.session;
    if (!state || state.interrupted) return;
    state.interrupted = true;
    hooks.log("info", "barge-in: interrupting", { reason });
    // §7.5 atomic interruption:
    // 1. cancel Cartesia (adapter guarantees no post-cancel frames)
    try {
      state.tts?.cancel("barge-in");
    } catch (ignoredError) {
      void ignoredError;
      /* noop */
    }
    // 2. abort in-flight LLM
    try {
      state.llmAbort?.abort();
    } catch (ignoredError) {
      void ignoredError;
      /* noop */
    }
    // 3+4. downlink flush + drop pending phrase are implicit: interrupted gate
    //      blocks all further emitBinary.
    // 5. emit interrupted, return to listening
    emit(ws, { t: "interrupted", reason, traceId: state.traceId });
  }

  function teardown(ws: ServerWebSocket<WsData>, reason: string) {
    const state = ws.data.session;
    if (!state) return;
    try {
      state.tts?.cancel(reason);
    } catch (ignoredError) {
      void ignoredError;
      /* noop */
    }
    try {
      state.flux?.close(reason);
    } catch (ignoredError) {
      void ignoredError;
      /* noop */
    }
    try {
      state.llmAbort?.abort();
    } catch (ignoredError) {
      void ignoredError;
      /* noop */
    }
    hooks.onDomainRow?.({
      table: "voice_sessions",
      id: state.sessionId,
      agentId: state.agentId,
      conversationId: state.conversationId,
      createdAtMs: state.createdAtMs,
      endedAtMs: Date.now(),
      status: "closed",
    });
    hooks.log("info", "session torn down", {
      reason,
      ttsFrames: state.ttsFrameCount,
      postInterruptFrames: state.postInterruptFrameCount,
    });
    ws.data.session = undefined;
  }

  const actualPort = server.port;
  if (typeof actualPort !== "number") {
    server.stop(true);
    throw new Error("voice reference server did not bind a TCP port");
  }
  const wsUrl = `ws://127.0.0.1:${actualPort}/api/v1/voice/session/ws`;
  return {
    port: actualPort,
    wsUrl,
    mint(agentId, conversationId) {
      const m = mintHarnessToken(agentId, conversationId);
      return { ...m, wsUrl };
    },
    stop() {
      server.stop(true);
    },
  };
}

/** Expose the per-session interrupt counter for the harness assertion. */
export function serverPostInterruptFrameCount(state: SessionState): number {
  return state.postInterruptFrameCount;
}
