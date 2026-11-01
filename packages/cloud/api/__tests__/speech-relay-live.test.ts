/** Protected staging provider proof. No user text, token, or credential is logged. */
import { test } from "bun:test";

const live =
  process.env.ELIZA_VOICE_LIVE_CLOUDFLARE === "1" &&
  process.env.ELIZA_VOICE_CLOUD_ENVIRONMENT === "staging";
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
  "staging speech relays provider PCM, final Ink text, and owner revocation",
  async () => {
    const base = process.env.ELIZA_VOICE_CLOUD_API_URL;
    const key = process.env.ELIZAOS_CLOUD_API_KEY;
    const commit = process.env.ELIZA_VOICE_CLOUD_COMMIT;
    check(
      base === "https://api-staging.eliza.app" &&
        key &&
        /^[a-f0-9]{40}$/.test(commit ?? ""),
      "SPEECH_CONFIGURATION_INVALID",
    );
    const headers = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };
    async function json(path: string, body?: unknown) {
      let response: Response;
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
      check(response.ok, `SPEECH_HTTP_STATUS_${response.status}`);
      try {
        return (await response.json()) as Record<string, unknown>;
      } catch {
        throw new Error("SPEECH_HTTP_JSON_INVALID");
      }
    }
    const health = await json("/api/health");
    check(
      health.commit === commit && health.environment === "staging",
      "SPEECH_RELEASE_MISMATCH",
    );
    const started = performance.now();
    const consent = await json("/api/v1/voice/speech/consent", {});
    const minted = await json("/api/v1/voice/speech/session", {
      consentNonce: consent.consentNonce,
    });
    check(
      typeof minted.wsUrl === "string" &&
        typeof minted.token === "string" &&
        typeof minted.sessionId === "string",
      "SPEECH_MINT_INVALID",
    );
    const url = new URL(minted.wsUrl);
    check(
      url.origin === "wss://api-staging.eliza.app" &&
        url.pathname === "/api/v1/voice/speech/ws",
      "SPEECH_SOCKET_ORIGIN_INVALID",
    );
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
      frameCount = 0,
      totalBytes = 0,
      revoked = false;
    const fail = (code: string) => {
      const error = new Error(code);
      ready.reject(error);
      complete.reject(error);
      final.reject(error);
    };
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({ t: "hello", token: minted.token, errorReasons: true }),
      ),
    );
    socket.addEventListener("error", () => fail("SPEECH_SOCKET_FAILED"));
    socket.addEventListener("close", () => {
      closed.resolve();
      if (!revoked) fail("SPEECH_SOCKET_CLOSED");
    });
    socket.addEventListener("message", (event) => {
      try {
        if (event.data instanceof ArrayBuffer) {
          const audio = decodeSpeechRelayAudio(new Uint8Array(event.data));
          check(audio.id === "proof", "SPEECH_AUDIO_CONTEXT_INVALID");
          if (!firstPcmAt) firstPcmAt = performance.now();
          totalBytes += audio.pcm.byteLength;
          check(totalBytes <= 1024 * 1024, "SPEECH_AUDIO_BOUND_EXCEEDED");
          frameCount++;
          chunks.push(audio.pcm);
          return;
        }
        check(typeof event.data === "string", "SPEECH_FRAME_INVALID");
        const message = JSON.parse(event.data) as Record<string, any>;
        if (message.t === "error") throw new Error("SPEECH_PROVIDER_REFUSED");
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
      for (const chunk of [...chunks, new Uint8Array(64_000)]) {
        for (let offset = 0; offset < chunk.length; offset += 3200) {
          socket.send(chunk.slice(offset, offset + 3200));
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      await bounded(final.promise, "SPEECH_STT_FINAL_TIMEOUT", 10_000);
      const revokeAt = performance.now();
      revoked = true;
      await json(`/api/v1/voice/speech/session/${minted.sessionId}/revoke`, {});
      await bounded(closed.promise, "SPEECH_REVOKE_TIMEOUT", 5000);
      console.info(
        JSON.stringify({
          phase: "speech-relay-live",
          status: "passed",
          bootstrapMs: Math.round(readyAt - started),
          firstPcmMs: Math.round(firstPcmAt - started),
          ttsCompleteMs: Math.round(completeAt - started),
          sttFinalMs: Math.round(finalAt - started),
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
  },
  60_000,
);
