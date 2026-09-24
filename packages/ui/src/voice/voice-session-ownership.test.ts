/** Exercises real voice ownership and client lifecycle with browser lock/audio boundaries controlled deterministically. */
import { describe, expect, it } from "vitest";
import {
  FakeMicAudioContext,
  FakePlaybackAudioContext,
  fakeGetUserMedia,
  makeWsFactory,
} from "./__tests__/voice-session-fakes";
import { createVoiceSessionClient } from "./voice-session-client";
import { claimVoiceSession } from "./voice-session-ownership";

function locks(
  granted: boolean,
  wait: Promise<void> = Promise.resolve(),
): LockManager {
  return {
    request: async <T>(
      _name: string,
      optionsOrCallback: LockOptions | LockGrantedCallback<T>,
      callback?: LockGrantedCallback<T>,
    ): Promise<T> => {
      const run =
        typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      if (!run) throw new Error("Missing lock callback");
      expect(optionsOrCallback).toEqual({
        mode: "exclusive",
        ifAvailable: true,
      });
      await wait;
      return run(granted ? { name: "voice", mode: "exclusive" } : null);
    },
    query: async () => ({ held: [], pending: [] }),
  };
}

describe("voice session ownership", () => {
  it("excludes same-realm contenders without releasing the owner's lease", async () => {
    const owner = claimVoiceSession(new AbortController().signal, undefined);
    await owner.ready;
    try {
      expect(() =>
        claimVoiceSession(new AbortController().signal, undefined),
      ).toThrow("already active");
    } finally {
      await owner.release();
    }
    const next = claimVoiceSession(new AbortController().signal, undefined);
    await next.ready;
    await next.release();
  });
  it("rejects an unavailable browser lock instead of waiting for automatic capture", async () => {
    const lease = claimVoiceSession(new AbortController().signal, locks(false));
    await expect(lease.ready).rejects.toThrow("another tab");
    const next = claimVoiceSession(new AbortController().signal, undefined);
    await next.ready;
    await next.release();
  });
  it("holds acquired browser ownership through cancellation until explicit teardown release", async () => {
    const abort = new AbortController();
    const lease = claimVoiceSession(abort.signal, locks(true));
    await lease.ready;
    abort.abort();
    expect(() =>
      claimVoiceSession(new AbortController().signal, undefined),
    ).toThrow("already active");
    await lease.release();
  });
  it("cancels a pending browser grant without claiming its late lock", async () => {
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const abort = new AbortController();
    const lease = claimVoiceSession(abort.signal, locks(true, wait));
    abort.abort();
    await expect(lease.ready).rejects.toThrow("cancelled");
    const next = claimVoiceSession(new AbortController().signal);
    await next.ready;
    finish();
    await Promise.resolve();
    expect(() => claimVoiceSession(new AbortController().signal)).toThrow(
      "already active",
    );
    await next.release();
  });
  it("stops promptly during pending microphone permission and discards its late stream", async () => {
    const ws = makeWsFactory();
    let resolveMedia!: (stream: MediaStream) => void;
    let requested = false,
      tracksStopped = 0,
      mints = 0;
    const client = createVoiceSessionClient({
      agentId: "agent",
      conversationId: "room",
      getConsentNonce: async () => "nonce",
      fetch: async () => {
        mints++;
        return new Response(
          JSON.stringify({
            sessionId: "session",
            wsUrl: "wss://test/session",
            token: "token",
            expiresAt: Date.now() + 600000,
            uplink: { codecs: ["pcm16"] },
            downlink: { codecs: ["pcm16"] },
            iceServers: null,
          }),
          { status: 200 },
        );
      },
      webSocketFactory: ws.factory,
      getUserMedia: () => {
        requested = true;
        return new Promise((resolve) => {
          resolveMedia = resolve;
        });
      },
      createMicAudioContext: () => new FakeMicAudioContext(),
      createPlaybackAudioContext: () => new FakePlaybackAudioContext(),
    });
    await client.start();
    ws.last().emitOpen();
    ws.last().emitControl({
      t: "ready",
      sessionId: "session",
      traceId: "trace",
    });
    await expect.poll(() => requested).toBe(true);
    await client.stop();
    const next = claimVoiceSession(new AbortController().signal);
    await next.ready;
    const stream = await fakeGetUserMedia()({ audio: true });
    Object.defineProperty(stream, "getTracks", {
      value: () => [
        {
          stop: () => {
            tracksStopped++;
          },
        },
      ],
    });
    resolveMedia(stream);
    await expect.poll(() => tracksStopped).toBe(1);
    expect(ws.last().sentAudioCount()).toBe(0);
    expect(mints).toBe(1);
    await next.release();
    await client.start();
    expect(mints).toBe(2);
    await client.stop();
  });
  it("never mints for a losing client and keeps gesture unlock synchronous", async () => {
    let finishMint: (() => void) | undefined;
    let minted = 0;
    let resumed = 0;
    const errors: Error[] = [];
    const make = () =>
      createVoiceSessionClient({
        agentId: "agent",
        conversationId: "room",
        getConsentNonce: async () => "nonce",
        fetch: async () => {
          minted++;
          await new Promise<void>((resolve) => {
            finishMint = resolve;
          });
          throw new Error("controlled mint failure");
        },
        createPlaybackAudioContext: () => {
          const audio = new FakePlaybackAudioContext();
          const resume = audio.resume.bind(audio);
          audio.resume = () => {
            resumed++;
            return resume();
          };
          return audio;
        },
        onError: (error) => errors.push(error),
      });
    const first = make(),
      second = make();
    const started = first.start();
    expect(resumed).toBe(1);
    await second.start();
    expect(
      errors.some((error) => error.message.includes("already active")),
    ).toBe(true);
    await expect.poll(() => minted).toBe(1);
    await first.stop();
    finishMint?.();
    await started;
    await second.stop();
  });
});
