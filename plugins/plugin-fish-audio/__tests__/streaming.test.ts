/**
 * Fish Audio plugin TTS tests with an in-memory WebSocket.
 *
 * Live Fish Audio coverage runs only with explicitly supplied credentials:
 * `ELIZA_TTS_FISH_ENABLED=true FISH_AUDIO_API_KEY=... FISH_AUDIO_REFERENCE_ID=... \
 * bun run --cwd plugins/plugin-fish-audio test -- \
 * --testNamePattern "live Fish Audio"`.
 */

import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { decode, encode } from "@msgpack/msgpack";
import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import {
  configureFishAudioWebSocketFactory,
  fishAudioPlugin,
  handleFishAudioTextToSpeech,
} from "../src/index";

class FakeFishSocket {
  static instances: FakeFishSocket[] = [];
  static respondToText = true;
  static finishReason: "stop" | "error" = "stop";
  static calls: Array<{
    url: string;
    protocols?: string | string[];
    options?: { headers?: Record<string, string> };
  }> = [];
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  sent: Uint8Array[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(
    url: string,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ) {
    FakeFishSocket.calls.push({ url, protocols, options });
    FakeFishSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.fire("open", undefined);
    });
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
    const frame = decode(data) as { event?: string; text?: string };
    if (FakeFishSocket.respondToText && frame.event === "text" && frame.text) {
      queueMicrotask(() => {
        this.fire("message", {
          data: encode({ event: "audio", audio: new Uint8Array([5, 6]) }),
        });
        this.fire("message", {
          data: encode({
            event: "finish",
            reason: FakeFishSocket.finishReason,
          }),
        });
      });
    }
  }

  close(_code?: number, reason?: string): void {
    this.readyState = 3;
    this.fire("close", { reason });
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener as (event: unknown) => void);
  }

  private fire(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function runtime(
  settings: Record<string, string | undefined> = {},
): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
    registerModel: vi.fn(),
  } as unknown as IAgentRuntime;
}

function sentFrames(): Record<string, unknown>[] {
  const socket = FakeFishSocket.instances.at(-1);
  if (!socket) throw new Error("Expected a Fish Audio WebSocket");
  return socket.sent.map((frame) => decode(frame) as Record<string, unknown>);
}

afterEach(() => {
  FakeFishSocket.instances = [];
  FakeFishSocket.calls = [];
  FakeFishSocket.respondToText = true;
  FakeFishSocket.finishReason = "stop";
  configureFishAudioWebSocketFactory(undefined);
  Reflect.deleteProperty(globalThis, "WebSocket");
});

describe("fishAudioPlugin", () => {
  test("does not register TEXT_TO_SPEECH by default", async () => {
    const rt = runtime({
      FISH_AUDIO_API_KEY: "key",
      FISH_AUDIO_REFERENCE_ID: "voice",
    });

    await fishAudioPlugin.init?.({}, rt);

    expect(rt.registerModel).not.toHaveBeenCalled();
  });

  test("registers TEXT_TO_SPEECH when ELIZA_TTS_FISH_ENABLED is true", async () => {
    const rt = runtime({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_API_KEY: "key",
      FISH_AUDIO_REFERENCE_ID: "voice",
    });

    await fishAudioPlugin.init?.({}, rt);

    expect(rt.registerModel).toHaveBeenCalledWith(
      ModelType.TEXT_TO_SPEECH,
      expect.any(Function),
      "fish-audio",
      undefined,
    );
  });

  test("returns AudioStreamResult when audioStream is true and sends MessagePack frames", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      value: FakeFishSocket,
      configurable: true,
    });
    const rt = runtime({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_API_KEY: "key",
      FISH_AUDIO_REFERENCE_ID: "voice",
    });

    const result = await handleFishAudioTextToSpeech(rt, {
      text: "hello",
      audioStream: true,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.audioStream) chunks.push(chunk);

    expect(chunks).toEqual([new Uint8Array([5, 6])]);
    expect(await result.bytes).toEqual(new Uint8Array([5, 6]));
    expect(FakeFishSocket.calls.at(-1)).toEqual({
      url: "wss://api.fish.audio/v1/tts/live",
      protocols: undefined,
      options: {
        headers: { Authorization: "Bearer key", model: "s2.1-pro" },
      },
    });
    expect(sentFrames()).toEqual([
      {
        event: "start",
        request: {
          text: "",
          reference_id: "voice",
          format: "pcm",
          sample_rate: 24000,
          latency: "normal",
        },
      },
      { event: "text", text: "hello" },
      { event: "flush" },
      { event: "stop" },
    ]);
  });

  test("rejects when Fish closes before a finish frame", async () => {
    FakeFishSocket.respondToText = false;
    Object.defineProperty(globalThis, "WebSocket", {
      value: FakeFishSocket,
      configurable: true,
    });
    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      { text: "close early", audioStream: true },
    );
    if (!("bytes" in result)) throw new Error("Expected streaming result");
    await Promise.resolve();
    FakeFishSocket.instances.at(-1)?.close(1011, "provider failed");

    await expect(result.bytes).rejects.toThrow(
      "Fish Audio WebSocket closed before finish: provider failed",
    );
  });

  test("rejects a provider finish frame whose reason is error", async () => {
    FakeFishSocket.finishReason = "error";
    Object.defineProperty(globalThis, "WebSocket", {
      value: FakeFishSocket,
      configurable: true,
    });
    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      { text: "provider error", audioStream: true },
    );
    if (!("bytes" in result)) throw new Error("Expected streaming result");

    await expect(result.bytes).rejects.toThrow(
      "Fish Audio TTS failed to finish synthesis",
    );
  });

  test("rejects an already-aborted request", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      value: FakeFishSocket,
      configurable: true,
    });
    const controller = new AbortController();
    controller.abort();
    const result = await handleFishAudioTextToSpeech(
      runtime({
        ELIZA_TTS_FISH_ENABLED: "true",
        FISH_AUDIO_API_KEY: "key",
        FISH_AUDIO_REFERENCE_ID: "voice",
      }),
      { text: "cancelled", audioStream: true, signal: controller.signal },
    );
    if (!("bytes" in result)) throw new Error("Expected streaming result");

    await expect(result.bytes).rejects.toThrow("Fish Audio TTS aborted");
  });

  test("buffers bytes when audioStream is false", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      value: FakeFishSocket,
      configurable: true,
    });
    const rt = runtime({
      ELIZA_TTS_FISH_ENABLED: "true",
      FISH_AUDIO_API_KEY: "key",
      FISH_AUDIO_REFERENCE_ID: "voice",
    });

    const result = await handleFishAudioTextToSpeech(rt, { text: "buffer me" });

    expect(result).toEqual(new Uint8Array([5, 6]));
  });

  const liveTest =
    process.env.FISH_AUDIO_API_KEY && process.env.FISH_AUDIO_REFERENCE_ID
      ? test
      : test.skip;

  liveTest(
    "live Fish Audio realtime WebSocket returns PCM bytes",
    async () => {
      configureFishAudioWebSocketFactory(
        (url, options) => new WebSocket(url, { headers: options.headers }),
      );
      const result = await handleFishAudioTextToSpeech(
        runtime({
          ELIZA_TTS_FISH_ENABLED: "true",
          FISH_AUDIO_API_KEY: process.env.FISH_AUDIO_API_KEY,
          FISH_AUDIO_REFERENCE_ID: process.env.FISH_AUDIO_REFERENCE_ID,
        }),
        { text: "Fish Audio live integration test." },
      );
      if (!(result instanceof Uint8Array))
        throw new Error("Expected buffered PCM bytes");
      expect(result.byteLength).toBeGreaterThan(0);
    },
    30_000,
  );
});
