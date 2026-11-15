/** Controlled zero-price providers around the production relay and retirement transitions. */
import { randomUUID } from "node:crypto";
import {
  beginSpeechRetirement,
  claimSpeechOpening,
  completeSpeechRetirement,
  initializeSpeechRecord,
  markSpeechOwned,
  recordSpeechSettlement,
  type SpeechLifecycleRecord,
} from "../../../cloud/api/src/speech-retirement-state";
import {
  createSpeechRelaySession,
  type SpeechRelayPorts,
  type SpeechRelayRetirementHandle,
} from "../../../host/src/voice/speech-relay-session";
import {
  encodeSpeechRelayAudio,
  type SpeechSettlementOutcome,
} from "../../../host/src/voice/speech-relay-wire";
import { InMemoryVoiceUsageStore } from "../../../host/src/voice/usage";
import { listenLoopbackWebSocket } from "./loopback-server";

export async function createVoiceRenewalRelay() {
  const sessionId = randomUUID(),
    nonce = randomUUID(),
    token = randomUUID();
  let record: SpeechLifecycleRecord | undefined;
  let handle: SpeechRelayRetirementHandle | undefined;
  let relay: Awaited<ReturnType<typeof createSpeechRelaySession>> | undefined;
  let retirement: Promise<void> | undefined;
  let consentUsed = false,
    windows = 0,
    pcmBytes = 0,
    turns = 0,
    nextTurnAt = 0;
  const events: { event: string; at: number; [key: string]: unknown }[] = [];
  const log = (event: string, detail: Record<string, unknown> = {}) =>
    events.push({ event, at: Date.now(), ...detail });
  const errors: unknown[] = [];
  const retire = () =>
    (retirement ??= (async () => {
      if (!record) throw Error("No controlled session to retire");
      record = beginSpeechRetirement(record);
      await handle?.close();
      record = completeSpeechRetirement(
        record,
        {
          generation: record.retirement?.generation,
          attempt: record.retirement?.attempt,
        },
        handle?.evidence(),
        Date.now(),
      );
      if (record.retirement?.proof?.state !== "confirmed")
        throw Error("Controlled retirement is unconfirmed");
      log("retired", { proof: record.retirement.proof, windows });
    })());
  const server = await listenLoopbackWebSocket(
    async (request) => {
      const url = new URL(request.url);
      if (
        request.headers.get("authorization") !== "Bearer controlled-cloud-owner"
      )
        return new Response(null, { status: 403 });
      if (url.pathname.endsWith("/consent")) {
        log("consent");
        return Response.json({
          consentNonce: nonce,
          recoverySessionId: sessionId,
          retirementProofVersion: 1,
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        });
      }
      if (url.pathname.endsWith("/revoke")) {
        await retire();
        return Response.json({
          revoked: true,
          retirement: record?.retirement?.proof,
        });
      }
      if (url.pathname.endsWith("/session")) {
        const body = (await request.json()) as {
          consentNonce?: string;
          recoverySessionId?: string;
        };
        if (
          body.consentNonce !== nonce ||
          body.recoverySessionId !== sessionId ||
          consentUsed
        )
          return new Response(null, { status: 403 });
        consentUsed = true;
        const expiresAt = Date.now() + 60000;
        record = initializeSpeechRecord(
          undefined,
          {
            sessionId,
            tokenDigest: "controlled-token-digest",
            expiresAt,
            caller: {
              user: {
                id: "controlled-owner",
                organization_id: "controlled-org",
              },
            },
            proofVersion: 1,
            phase: "minted",
          },
          Date.now(),
        );
        log("mint");
        return Response.json(
          {
            sessionId,
            token,
            expiresAt: new Date(expiresAt).toISOString(),
            version: 1,
            retirementProofVersion: 1,
            wsUrl: `${server.url.origin.replace("http:", "ws:")}/api/v1/voice/speech/ws?sessionId=${sessionId}`,
          },
          { headers: { "X-Eliza-Speech-Extend": "1" } },
        );
      }
      return new Response(null, { status: 404 });
    },
    (request) =>
      new URL(request.url).searchParams.get("sessionId") === sessionId,
  );
  server.sockets.on("connection", (socket) => {
    log("relay_socket");
    let sequence = Promise.resolve();
    socket.on("message", (data, binary) => {
      sequence = sequence
        .then(async () => {
          if (binary) {
            if (!relay) throw Error("PCM before relay admission");
            relay.sendPcm(
              new Uint8Array(
                Buffer.concat(
                  Array.isArray(data) ? data : [Buffer.from(data as Buffer)],
                ),
              ),
            );
            return;
          }
          const frame = JSON.parse(String(data));
          if (frame.t === "hello") {
            if (frame.token !== token || frame.extend !== true || !record)
              throw Error("Invalid controlled relay hello");
            record = claimSpeechOpening(record, "controlled-opening");
            const openingGeneration = record.retirement?.generation;
            const identity = {
              organizationId: "controlled-org",
              userId: "controlled-owner",
              cloudSessionId: sessionId,
            };
            const ports: SpeechRelayPorts = {
              enabled: true,
              expiresAt: record.expiresAt,
              maxWindows: 3,
              assertCurrent(scope) {
                if (
                  scope.cloudSessionId !== sessionId ||
                  record?.phase === "closed"
                )
                  throw Error("Controlled owner closed");
              },
              consumeConsent: async () => true,
              usageStore: new InMemoryVoiceUsageStore(),
              usageLimits: {
                organizationDailyMinutes: 10,
                userDailyMinutes: 10,
              },
              reserveCredits: async () => {
                const window = windows++;
                if (!record) throw Error("Missing controlled ledger");
                for (const kind of ["stt", "tts"] as const)
                  record = recordSpeechSettlement(
                    record,
                    kind,
                    {
                      state: "reserved",
                      requestId: `speech:${sessionId}:${kind}${window ? `:${window}` : ""}`,
                    },
                    window,
                  );
                log("reserve", {
                  window,
                  priceUsd: "0",
                  provider: "controlled",
                });
                return {
                  supportsPerKindSettlement: true,
                  beforeProviderDispatch: async () => {},
                  settle: async (input, kinds = ["stt", "tts"]) => {
                    const result: Partial<SpeechSettlementOutcome> = {};
                    for (const kind of kinds) {
                      const requestId = `speech:${sessionId}:${kind}${window ? `:${window}` : ""}`;
                      if (!record) throw Error("Missing controlled ledger");
                      record = recordSpeechSettlement(
                        record,
                        kind,
                        { state: "settled_actual", requestId, amountUsd: "0" },
                        window,
                      );
                      result[kind] = {
                        requestId,
                        state: "actual",
                        amountUsd: "0",
                        terminal: true,
                      };
                      log("settle", {
                        window,
                        kind,
                        pcmBytes: input.pcmBytes,
                        priceUsd: "0",
                      });
                    }
                    return result;
                  },
                };
              },
              subscribeRevoked: () => () => {},
              extend: async (_scope, expiresAt) => {
                if (record?.phase !== "active")
                  throw Error("Cannot renew a retired session");
                record = { ...record, expiresAt };
                log("extend", { expiresAt });
                return expiresAt;
              },
              openStt: (onEvent) => {
                let active = true;
                setTimeout(() => {
                  if (active) onEvent({ type: "connected", raw: {} });
                }, 0);
                return {
                  sendAudioChunk(bytes) {
                    if (!active) throw Error("Controlled STT is closed");
                    pcmBytes += bytes.byteLength;
                    if (Date.now() < nextTurnAt) return;
                    nextTurnAt = Date.now() + 52000;
                    turns++;
                    log("synthetic_turn", { turns, pcmBytes });
                    onEvent({ type: "start-of-turn", transcript: "", raw: {} });
                    onEvent({
                      type: "transcript-update",
                      transcript: "Read the controlled voice check.",
                      raw: {},
                    });
                    onEvent({
                      type: "end-of-turn",
                      transcript: "Read the controlled voice check.",
                      raw: {},
                    });
                  },
                  cancel() {
                    active = false;
                  },
                  async drain() {
                    active = false;
                    return {
                      source: "provider-graceful-close" as const,
                      audioBytes: pcmBytes,
                      sampleRate: 16000,
                      channels: 1,
                      encoding: "pcm_s16le" as const,
                    };
                  },
                };
              },
              openTts: (_id, callbacks) => {
                let active = true;
                return {
                  sendPhrase() {
                    if (!active) throw Error("Controlled TTS is closed");
                    const audio = new Uint8Array(16000);
                    const view = new DataView(audio.buffer);
                    for (let n = 0; n < audio.length / 2; n++)
                      view.setInt16(
                        n * 2,
                        Math.round(
                          1400 * Math.sin((2 * Math.PI * 523.25 * n) / 16000),
                        ),
                        true,
                      );
                    callbacks.audio(audio);
                    callbacks.flushComplete(1);
                  },
                  finish() {
                    if (active) {
                      active = false;
                      callbacks.complete();
                    }
                  },
                  cancel() {
                    active = false;
                  },
                };
              },
              emit(event) {
                if (socket.readyState !== 1) return;
                if (event.t === "audio")
                  socket.send(encodeSpeechRelayAudio(event.id, event.bytes));
                else socket.send(JSON.stringify(event));
              },
              onClosed(pending) {
                void pending.catch((error) => errors.push(error));
              },
              registerRetirement(value) {
                handle = value;
              },
              confirmTtsTransportStopped: async () => "transport_closed",
            };
            relay = await createSpeechRelaySession(identity, nonce, ports);
            const owned = markSpeechOwned(
              record,
              "controlled-opening",
              openingGeneration,
            );
            if (!owned) throw Error("Lost controlled opening");
            record = owned;
            socket.send(
              JSON.stringify({
                t: "ready",
                version: 1,
                sampleRate: 16000,
                channels: 1,
                expiresAt: new Date(record.expiresAt).toISOString(),
              }),
            );
          } else {
            if (!relay) throw Error("Control before relay admission");
            await relay.control(frame);
          }
        })
        .catch((error) => {
          errors.push(error);
          socket.close(1011, "controlled-relay-failed");
        });
    });
    socket.on("close", () => {
      if (relay) void retire().catch((error) => errors.push(error));
    });
  });
  return {
    origin: server.url.origin,
    events,
    errors,
    snapshot: () => ({ windows, pcmBytes, turns, record }),
    async close() {
      if (record) await retire();
      await server.close();
    },
  };
}
