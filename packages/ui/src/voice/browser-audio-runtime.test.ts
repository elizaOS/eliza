import { afterEach, describe, expect, it, vi } from "vitest";

import {
  constructBrowserAudioContext,
  constructBrowserAudioWorkletNode,
} from "./browser-audio-runtime";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser audio runtime boundaries", () => {
  it("constructs the native AudioContext with arguments after validation", () => {
    class NativeAudioContext {
      constructor(readonly options: AudioContextOptions) {}
    }
    vi.stubGlobal("window", { AudioContext: NativeAudioContext });

    const context = constructBrowserAudioContext(
      [{ sampleRate: 16_000 }],
      (value): value is NativeAudioContext =>
        value instanceof NativeAudioContext,
    );

    expect(context).toBeInstanceOf(NativeAudioContext);
    expect(context?.options.sampleRate).toBe(16_000);
  });

  it("uses webkitAudioContext and rejects a constructor result that fails validation", () => {
    class WebkitAudioContext {
      static latest: WebkitAudioContext | null = null;
      readonly close = vi.fn(async () => {});

      constructor() {
        WebkitAudioContext.latest = this;
      }
    }
    vi.stubGlobal("window", { webkitAudioContext: WebkitAudioContext });

    const context = constructBrowserAudioContext(
      [],
      (_value): _value is { accepted: true } => false,
    );

    expect(context).toBeNull();
    expect(WebkitAudioContext.latest?.close).toHaveBeenCalledTimes(1);
  });

  it("constructs and validates the native AudioWorkletNode", () => {
    const context = { sampleRate: 16_000 };
    class NativeAudioWorkletNode {
      constructor(
        readonly receivedContext: object,
        readonly name: string,
      ) {}
    }
    vi.stubGlobal("AudioWorkletNode", NativeAudioWorkletNode);

    const node = constructBrowserAudioWorkletNode(
      context,
      "eliza-test-worklet",
      (value): value is NativeAudioWorkletNode =>
        value instanceof NativeAudioWorkletNode,
    );

    expect(node?.receivedContext).toBe(context);
    expect(node?.name).toBe("eliza-test-worklet");
  });

  it("returns null for unavailable or invalid AudioWorkletNode runtimes", () => {
    expect(
      constructBrowserAudioWorkletNode(
        {},
        "missing",
        (value): value is unknown => value !== undefined,
      ),
    ).toBeNull();

    class InvalidAudioWorkletNode {
      static latest: InvalidAudioWorkletNode | null = null;
      readonly disconnect = vi.fn();

      constructor() {
        InvalidAudioWorkletNode.latest = this;
      }
    }
    vi.stubGlobal("AudioWorkletNode", InvalidAudioWorkletNode);
    expect(
      constructBrowserAudioWorkletNode(
        {},
        "invalid",
        (_value): _value is { accepted: true } => false,
      ),
    ).toBeNull();
    expect(InvalidAudioWorkletNode.latest?.disconnect).toHaveBeenCalledTimes(1);
  });
});
