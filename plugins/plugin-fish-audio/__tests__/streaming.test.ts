/**
 * Fish Audio plugin TTS tests with an in-memory WebSocket.
 *
 * Live Fish Audio coverage is skipped pending funded credentials. Run manually:
 * `ELIZA_TTS_FISH_ENABLED=true FISH_AUDIO_API_KEY=... FISH_AUDIO_REFERENCE_ID=... \
 * bun run --cwd plugins/plugin-fish-audio test -- \
 * --testNamePattern "live Fish Audio"`.
 */

import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { decode, encode } from "@msgpack/msgpack";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fishAudioPlugin, handleFishAudioTextToSpeech } from "../src/index";

class FakeFishSocket {
  static instances: FakeFishSocket[] = [];
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
    if (frame.event === "text" && frame.text) {
      queueMicrotask(() => {
        this.fire("message", {
          data: encode({ event: "audio", audio: new Uint8Array([5, 6]) }),
        });
        this.fire("message", {
          data: encode({ event: "finish", reason: "stop" }),
        });
      });
    }
  }

  close(): void {
    this.readyState = 3;
    this.fire("close", {});
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener as (event: unknown) => void);
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
  return FakeFishSocket.instances
    .at(-1)!
    .sent.map((frame) => decode(frame) as Record<string, unknown>);
}

afterEach(() => {
  FakeFishSocket.instances = [];
  FakeFishSocket.calls = [];
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
      options: { headers: { Authorization: "Bearer key" } },
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
          model: "s2.1-pro",
        },
      },
      { event: "text", text: "hello" },
      { event: "stop" },
    ]);
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
