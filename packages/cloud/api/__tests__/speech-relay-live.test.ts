/** Protected provider proof. No user text, token, or credential is logged. */
import { test } from "bun:test";
import {
  reportedSpeechRelayTest,
  speechRelayRefusal,
} from "../test/speech-relay-live-report";

const environment = process.env.ELIZA_VOICE_CLOUD_ENVIRONMENT;
const target =
  environment === "staging"
    ? {
        api: "https://api-staging.eliza.app",
        socket: "wss://api-staging.eliza.app",
      }
    : environment === "production"
      ? { api: "https://api.eliza.app", socket: "wss://api.eliza.app" }
      : undefined;
const live =
  process.env.ELIZA_VOICE_LIVE_CLOUDFLARE === "1" && target !== undefined;
const maybe = live ? test : test.skip;
function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Event failures can arrive before this phase is awaited.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function bounded<T>(
  promise: Promise<T>,
  code: string,
  ms = 20_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

maybe(
  "deployed speech relays provider PCM, final Ink text, and owner revocation",
  reportedSpeechRelayTest(async (stage) => {
    check(target, "SPEECH_CONFIGURATION_INVALID");
    const base = process.env.ELIZA_VOICE_CLOUD_API_URL;
    const key = process.env.ELIZAOS_CLOUD_API_KEY;
    const commit = process.env.ELIZA_VOICE_CLOUD_COMMIT;
    check(
      base === target.api && key && /^[a-f0-9]{40}$/.test(commit ?? ""),
      "SPEECH_CONFIGURATION_INVALID",
    );
    const headers = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
    async function json(path: string, body?: unknown) {
      let response: Response | undefined;
      // Like the shipped client, retry the structured warming refusal a cold
      // auth or billing cache answers with while it hydrates; nothing else.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await fetch(`${base}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(20_000),
          });
        } catch {
          throw new Error("SPEECH_HTTP_UNAVAILABLE");
        }
        if (response.status !== 503) break;
        const refusal = (await response
          .clone()
          .json()
          .catch(() => null)) as Record<string, unknown> | null;
        const nested = refusal?.error as Record<string, unknown> | undefined;
        const details = refusal?.details as Record<string, unknown> | undefined;
        const warming =
          (typeof nested?.code === "string" &&
            nested.code.endsWith("_cache_warming")) ||
          refusal?.code === "auth_cache_warming" ||
          (refusal?.code === "service_unavailable" &&
            details?.retryable === true);
        if (!warming) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (!response) throw new Error("SPEECH_HTTP_UNAVAILABLE");
      check(response.ok, `SPEECH_HTTP_STATUS_${response.status}`);
      try {
        return (await response.json()) as Record<string, unknown>;
      } catch {
        throw new Error("SPEECH_HTTP_JSON_INVALID");
      }
    }
    stage("health");
    const health = await json("/api/health");
    check(
      health.commit === commit && health.environment === environment,
      "SPEECH_RELEASE_MISMATCH",
    );
    const started = performance.now();
    stage("consent");
    const consent = await json("/api/v1/voice/speech/consent", {});
    const consentAt = performance.now();
    stage("session");
    const minted = await json("/api/v1/voice/speech/session", {
      consentNonce: consent.consentNonce,
    });
    const sessionAt = performance.now();
    check(
      typeof minted.wsUrl === "string" &&
        typeof minted.token === "string" &&
        typeof minted.sessionId === "string",
      "SPEECH_MINT_INVALID",
    );
    const url = new URL(minted.wsUrl);
    check(
      url.origin === target.socket &&
        url.pathname === "/api/v1/voice/speech/ws",
      "SPEECH_SOCKET_ORIGIN_INVALID",
    );
    stage("websocket");
    const socketStartedAt = performance.now();
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const ready = deferred<void>(),
      complete = deferred<void>(),
      final = deferred<void>(),
      closed = deferred<void>();
    const chunks: Uint8Array[] = [];
    let firstPcmAt = 0,
      completeAt = 0,
      finalAt = 0,
      readyAt = 0,
      ttsRequestedAt = 0,
      speechInputEndedAt = 0,
      frameCount = 0,
      totalBytes = 0,
      revoked = false;
    const fail = (code: string) => {
      const error = new Error(code);
      ready.reject(error);
      complete.reject(error);
      final.reject(error);
    };
    socket.addEventListener("open", () => {
      stage("ready");
      socket.send(
        JSON.stringify({
          t: "hello",
          token: minted.token,
          errorReasons: true,
        }),
      );
    });
    socket.addEventListener("error", () => fail("SPEECH_SOCKET_FAILED"));
    socket.addEventListener("close", () => {
      closed.resolve();
      if (!revoked) fail("SPEECH_SOCKET_CLOSED");
    });
    socket.addEventListener("message", (event) => {
      try {
        if (event.data instanceof ArrayBuffer) {
          // Read the v1 envelope independently; the protected workflow only needs Bun.
          const frame = new Uint8Array(event.data);
          check(
            frame[0] === 1 && frame[1] === 5 && frame.length > 7,
            "SPEECH_AUDIO_ENVELOPE_INVALID",
          );
          check(
            new TextDecoder().decode(frame.subarray(2, 7)) === "proof",
            "SPEECH_AUDIO_CONTEXT_INVALID",
          );
          const audio = { pcm: frame.subarray(7) };
          check(
            audio.pcm.length % 2 === 0 && audio.pcm.length <= 65536,
            "SPEECH_AUDIO_FORMAT_INVALID",
          );
          if (!firstPcmAt) firstPcmAt = performance.now();
          totalBytes += audio.pcm.byteLength;
          check(totalBytes <= 1024 * 1024, "SPEECH_AUDIO_BOUND_EXCEEDED");
          frameCount++;
          chunks.push(audio.pcm);
          return;
        }
        check(typeof event.data === "string", "SPEECH_FRAME_INVALID");
        const message = JSON.parse(event.data) as Record<string, any>;
        if (message.t === "error") {
          fail(speechRelayRefusal(message.code, message.reason));
          return;
        }
        if (message.t === "ready") {
          readyAt = performance.now();
          ready.resolve();
        }
        if (message.t === "complete" && message.id === "proof") {
          completeAt = performance.now();
          complete.resolve();
        }
        if (message.t === "stt" && message.event?.type === "end-of-turn") {
          const transcript = String(message.event.transcript).toLowerCase();
          if (transcript.includes("blue") && transcript.includes("bird")) {
            finalAt = performance.now();
            final.resolve();
          }
        }
      } catch {
        fail("SPEECH_PROVIDER_CONTRACT_INVALID");
      }
    });
    try {
      await bounded(ready.promise, "SPEECH_READY_TIMEOUT");
      stage("tts");
      ttsRequestedAt = performance.now();
      socket.send(
        JSON.stringify({
          t: "tts",
          id: "proof",
          text: "Hello. The blue bird sings beside the quiet river.",
          flush: true,
        }),
      );
      socket.send(JSON.stringify({ t: "finish", id: "proof" }));
      await bounded(complete.promise, "SPEECH_TTS_TIMEOUT");
      check(
        frameCount > 1 && firstPcmAt > 0 && firstPcmAt < completeAt,
        "SPEECH_NOT_INCREMENTAL",
      );
      // Feed the generated PCM at microphone speed, then enough silence for Ink's
      // bounded final-turn timer. This proves the two provider streams, not Android playback.
      stage("stt");
      for (const [index, chunk] of [
        ...chunks,
        new Uint8Array(64_000),
      ].entries()) {
        for (let offset = 0; offset < chunk.length; offset += 1024) {
          const frame = chunk.slice(offset, offset + 1024);
          socket.send(frame);
          await new Promise((resolve) =>
            setTimeout(resolve, frame.length / 32),
          );
        }
        // End of the paced generated-audio replay, before the added silence.
        if (index === chunks.length - 1) speechInputEndedAt = performance.now();
      }
      await bounded(final.promise, "SPEECH_STT_FINAL_TIMEOUT", 5000);
      stage("revocation");
      const revokeAt = performance.now();
      revoked = true;
      await json(`/api/v1/voice/speech/session/${minted.sessionId}/revoke`, {});
      await bounded(closed.promise, "SPEECH_REVOKE_TIMEOUT", 5000);
      console.info(
        JSON.stringify({
          phase: "speech-relay-live",
          status: "passed",
          consentMs: Math.round(consentAt - started),
          sessionMs: Math.round(sessionAt - consentAt),
          wsReadyMs: Math.round(readyAt - socketStartedAt),
          bootstrapMs: Math.round(readyAt - started),
          ttsStartupMs: Math.round(firstPcmAt - ttsRequestedAt),
          firstPcmMs: Math.round(firstPcmAt - started),
          ttsCompleteMs: Math.round(completeAt - started),
          sttFinalMs: Math.round(finalAt - started),
          // An early final has no nonnegative tail; do not fabricate zero.
          ...(finalAt >= speechInputEndedAt
            ? { sttTailMs: Math.round(finalAt - speechInputEndedAt) }
            : {}),
          revokeMs: Math.round(performance.now() - revokeAt),
          pcmFrames: frameCount,
          pcmBytes: totalBytes,
        }),
      );
    } finally {
      if (!revoked) {
        revoked = true;
        try {
          await json(
            `/api/v1/voice/speech/session/${minted.sessionId}/revoke`,
            {},
          );
        } catch {}
      }
      socket.close();
    }
  }),
  60_000,
);
