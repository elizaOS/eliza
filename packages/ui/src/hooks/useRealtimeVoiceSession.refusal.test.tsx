// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  createVoiceSessionClient,
  type VoiceSessionClient,
  type VoiceWebSocketLike,
} from "../voice/voice-session-client-core";
import type { MicAudioContextLike } from "../voice/voice-session-mic-capture";
import type { PlaybackAudioContextLike } from "../voice/voice-session-playback";
import { useRealtimeVoiceSession } from "./useRealtimeVoiceSession";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
function fixture() {
  let mints = 0,
    captures = 0,
    batches = 0,
    notices = 0;
  let stopRefused = false;
  let flagEnabled = true;
  let conversationId = "conversation";
  const sockets: Socket[] = [],
    clients: VoiceSessionClient[] = [];
  class Socket implements VoiceWebSocketLike {
    readyState = 0;
    binaryType = "arraybuffer";
    listeners = new Map<string, ((event: any) => void)[]>();
    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open", {});
      });
    }
    addEventListener(type: string, listener: any) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    removeEventListener(type: string, listener: any) {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((x) => x !== listener),
      );
    }
    emit(type: string, event: any) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    frame(value: unknown) {
      this.emit("message", { data: JSON.stringify(value) });
    }
    send() {}
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close", {});
    }
  }
  const node = () => ({
    connect() {
      return this;
    },
    disconnect() {},
  });
  const audio = () => ({
    sampleRate: 16000,
    state: "running",
    destination: node(),
    createMediaStreamSource: () => node(),
    createScriptProcessor: () => ({ ...node(), onaudioprocess: null }),
    async resume() {},
    async close() {},
  });
  function useConsumer() {
    const voice = useRealtimeVoiceSession({
      agentId: "agent",
      conversationId,
      flagEnabled,
      getConsentNonce: async () => "nonce",
      createClient: (options) => {
        if (!options.fetch) throw Error("Missing isolated voice fixture fetch");
        const client = createVoiceSessionClient({
          ...options,
          fetch: options.fetch,
        });
        clients.push(client);
        return client;
      },
      clientOptions: {
        fetch: async () => {
          mints++;
          return Response.json({
            sessionId: `session-${mints}`,
            token: "token",
            wsUrl: "ws://localhost/voice",
            expiresAt: Date.now() + 60000,
            uplink: { codecs: ["pcm16"] },
            downlink: { codecs: ["pcm16"] },
          });
        },
        webSocketFactory: () => new Socket(),
        createMicAudioContext: audio as () => MicAudioContextLike,
        createPlaybackAudioContext: audio as () => PlaybackAudioContextLike,
        getUserMedia: async () => {
          captures++;
          let stopped = false;
          const track = {
            readyState: "live",
            stop() {
              if (stopRefused) throw Error("Injected microphone stop failure");
              if (!stopped) {
                stopped = true;
                track.readyState = "ended";
                captures--;
              }
            },
          };
          return {
            getTracks: () => [track],
            getAudioTracks: () => [],
          } as unknown as MediaStream;
        },
      },
    });
    const [wanted, setWanted] = useState(false),
      pending = useRef(false);
    const [mode, setMode] = useState("off");
    useEffect(() => {
      if (voice.refused) {
        pending.current = false;
        setWanted(false);
        return;
      }
      if (!wanted || voice.active || pending.current) return;
      pending.current = true;
      void voice.start().then((outcome) => {
        if (outcome.kind === "refused") {
          pending.current = false;
          setWanted(false);
        }
        if (outcome.kind === "fallback-to-batch") {
          batches++;
          setWanted(false);
        }
        if (outcome.kind === "error") notices++;
      });
    }, [wanted, voice.refused, voice.active, voice.start]);
    return {
      voice,
      wanted,
      mode,
      restoreMode: setMode,
      talk: () => {
        voice.resetRefusal();
        pending.current = false;
        setWanted(true);
      },
    };
  }
  const view = renderHook(useConsumer);
  return {
    view,
    sockets,
    clients,
    refuseStop() {
      stopRefused = true;
    },
    allowStop() {
      stopRefused = false;
    },
    disable() {
      flagEnabled = false;
      view.rerender();
    },
    changeConversation() {
      conversationId = "next-conversation";
      view.rerender();
    },
    get mints() {
      return mints;
    },
    get captures() {
      return captures;
    },
    get batches() {
      return batches;
    },
    get notices() {
      return notices;
    },
  };
}

test("real hook/client refusal survives rerenders without automatic mint, batch or error text", async () => {
  const f = fixture();
  await act(async () => {
    f.view.result.current.talk();
    await flush();
  });
  await act(async () => {
    f.sockets[0].frame({
      t: "error",
      code: "voice_retirement_unconfirmed",
      retryable: false,
    });
    await flush();
  });
  expect(f.view.result.current.voice.refused).toBe(true);
  expect(f.view.result.current.wanted).toBe(false);
  expect(f.view.result.current.voice.error).toBeNull();
  expect(f.captures).toBe(0);
  await act(async () => {
    f.view.result.current.restoreMode("always-on");
    await flush();
  });
  f.view.rerender();
  await act(flush);
  expect(f.view.result.current.voice.refused).toBe(true);
  expect(f.mints).toBe(1);
  expect(f.batches).toBe(0);
  expect(f.notices).toBe(0);
  await act(async () => {
    f.view.result.current.talk();
    await flush();
  });
  expect(f.mints).toBe(2);
  expect(f.sockets).toHaveLength(2);
  await act(async () => {
    await f.view.result.current.voice.stop();
  });
});

test("Stop cancels a restart that is still releasing a retained capture", async () => {
  const f = fixture();
  let started!: ReturnType<typeof f.view.result.current.voice.start>;
  await act(async () => {
    started = f.view.result.current.voice.start();
    await flush();
    f.sockets[0].frame({
      t: "ready",
      sessionId: "session-1",
      traceId: "ready-1",
    });
    await flush();
  });
  expect((await started).kind).toBe("live");
  f.refuseStop();
  await act(async () => {
    await expect(f.view.result.current.voice.stop()).rejects.toMatchObject({
      code: "release_unconfirmed",
    });
  });
  f.allowStop();
  await act(async () => {
    const restart = f.view.result.current.voice.start();
    await f.view.result.current.voice.stop();
    expect((await restart).kind).toBe("unavailable");
  });
  expect(f.mints).toBe(1);
  expect(f.captures).toBe(0);
});

test.each(["unmount", "disable", "changeConversation"] as const)(
  "%s retries a retained release without starting a new capture",
  async (retire) => {
    const f = fixture();
    let started!: ReturnType<typeof f.view.result.current.voice.start>;
    await act(async () => {
      started = f.view.result.current.voice.start();
      await flush();
      f.sockets[0].frame({
        t: "ready",
        sessionId: "session-1",
        traceId: "ready-1",
      });
      await flush();
    });
    expect((await started).kind).toBe("live");
    f.refuseStop();
    await act(async () => {
      await expect(f.view.result.current.voice.stop()).rejects.toMatchObject({
        code: "release_unconfirmed",
      });
    });
    expect(f.captures).toBe(1);
    f.allowStop();
    await act(async () => {
      if (retire === "unmount") f.view.unmount();
      else f[retire]();
      await flush();
    });
    expect(f.captures).toBe(0);
    expect(f.mints).toBe(1);
  },
);

test("the real hook retains failed Stop across retry and starts only after release", async () => {
  const f = fixture();
  let started!: ReturnType<typeof f.view.result.current.voice.start>;
  await act(async () => {
    started = f.view.result.current.voice.start();
    await flush();
    f.sockets[0].frame({
      t: "ready",
      sessionId: "session-1",
      traceId: "ready-1",
    });
    await flush();
  });
  expect((await started).kind).toBe("live");
  expect(f.captures).toBe(1);
  f.refuseStop();
  await act(async () => {
    await expect(f.view.result.current.voice.stop()).rejects.toMatchObject({
      code: "release_unconfirmed",
    });
  });
  expect(f.view.result.current.voice.error?.kind).toBe("release");
  expect(f.captures).toBe(1);
  await act(async () => {
    expect((await f.view.result.current.voice.start()).kind).toBe("error");
  });
  expect(f.mints).toBe(1);
  expect(f.batches).toBe(0);
  f.allowStop();
  await act(async () => {
    await f.view.result.current.voice.stop();
  });
  expect(f.captures).toBe(0);
  expect(f.view.result.current.voice.error).toBeNull();
  await act(async () => {
    started = f.view.result.current.voice.start();
    await flush();
    f.sockets[1].frame({
      t: "ready",
      sessionId: "session-2",
      traceId: "ready-2",
    });
    await flush();
  });
  expect((await started).kind).toBe("live");
  expect(f.captures).toBe(1);
  expect(f.mints).toBe(2);
  await act(async () => {
    await f.view.result.current.voice.stop();
  });
  expect(f.captures).toBe(0);
});

test.each(["quota_exhausted", "insufficient_credits", "revoked"])(
  "%s retains the previous chat dictation fallback policy",
  async (code) => {
    const f = fixture();
    await act(async () => {
      f.view.result.current.talk();
      await flush();
    });
    await act(async () => {
      f.sockets[0].frame({ t: "error", code, retryable: false });
      await flush();
    });
    expect(f.view.result.current.voice.refused).toBe(false);
    expect(f.batches).toBe(1);
    await act(async () => {
      await f.view.result.current.voice.stop();
    });
  },
);
