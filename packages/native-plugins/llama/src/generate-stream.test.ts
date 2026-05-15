/**
 * Event-ordering tests for `CapacitorLlamaAdapter.generateStream()`. Mocks
 * `llama-cpp-capacitor` so we can drive token events from the test and
 * assert the resulting `GenerationEvent` sequence.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import { describe, expect, it, vi } from "vitest";

type TokenListener = (data: { token: string }) => void;

interface MockState {
  /** Captured `@LlamaCpp_onToken` listener so the test can drive tokens. */
  tokenListener: TokenListener | null;
  /** Resolver for the completion call; the test calls this after emitting tokens. */
  resolveCompletion: ((result: unknown) => void) | null;
  /** Rejector for the completion call, used to drive the error path. */
  rejectCompletion: ((err: unknown) => void) | null;
}

function installMockPlugin(): MockState {
  const state: MockState = {
    tokenListener: null,
    resolveCompletion: null,
    rejectCompletion: null,
  };

  vi.doMock("llama-cpp-capacitor", () => ({
    LlamaCpp: {
      initContext: vi.fn(async (opts: { contextId: number }) => ({
        contextId: opts.contextId,
      })),
      releaseContext: vi.fn(async () => undefined),
      releaseAllContexts: vi.fn(async () => undefined),
      completion: vi.fn(
        () =>
          new Promise((resolve, reject) => {
            state.resolveCompletion = resolve;
            state.rejectCompletion = reject;
          }),
      ),
      stopCompletion: vi.fn(async () => undefined),
      addListener: vi.fn(async (event: string, listener: TokenListener) => {
        if (event === "@LlamaCpp_onToken") {
          state.tokenListener = listener;
        }
        const handle: PluginListenerHandle = {
          remove: async () => undefined,
        };
        return handle;
      }),
      getHardwareInfo: vi.fn(async () => ({
        platform: "android",
        deviceModel: "Pixel 9a",
        totalRamGb: 8,
        availableRamGb: 4,
        cpuCores: 8,
        gpu: null,
        gpuSupported: false,
      })),
    },
  }));

  (globalThis as Record<string, unknown>).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
  };

  return state;
}

async function pumpMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe("CapacitorLlamaAdapter.generateStream", () => {
  it("emits token events in order, terminated by a single done event", async () => {
    vi.resetModules();
    const state = installMockPlugin();
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");

    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({ modelPath: "/tmp/model.gguf" });

    const collected: Array<{ kind: string; text?: string }> = [];
    const consume = (async () => {
      for await (const event of adapter.generateStream({ prompt: "hi" })) {
        collected.push({
          kind: event.kind,
          ...(event.kind === "token" ? { text: event.text } : {}),
        });
      }
    })();

    // Wait for the stream to wire up its token listener.
    await pumpMicrotasks();
    expect(state.tokenListener).not.toBeNull();

    // Drive three tokens through the native bridge.
    state.tokenListener?.({ token: "Hello" });
    state.tokenListener?.({ token: ", " });
    state.tokenListener?.({ token: "world" });
    await pumpMicrotasks();

    // Resolve the completion call with the final stats.
    state.resolveCompletion?.({
      text: "Hello, world",
      tokens_evaluated: 3,
      tokens_predicted: 3,
      timings: { predicted_ms: 50 },
    });

    await consume;

    const kinds = collected.map((e) => e.kind);
    expect(kinds).toEqual(["token", "token", "token", "done"]);
    expect(collected[0].text).toBe("Hello");
    expect(collected[1].text).toBe(", ");
    expect(collected[2].text).toBe("world");
  });

  it("ends with an error+done pair when the native call rejects", async () => {
    vi.resetModules();
    const state = installMockPlugin();
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");

    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({ modelPath: "/tmp/model.gguf" });

    const collected: Array<{ kind: string }> = [];
    const consume = (async () => {
      for await (const event of adapter.generateStream({ prompt: "hi" })) {
        collected.push({ kind: event.kind });
      }
    })();

    await pumpMicrotasks();
    state.rejectCompletion?.(new Error("native blew up"));
    await consume;

    expect(collected.map((e) => e.kind)).toEqual(["error", "done"]);
  });

  it("legacy generate() wraps generateStream and returns assembled GenerateResult", async () => {
    vi.resetModules();
    const state = installMockPlugin();
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");

    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({ modelPath: "/tmp/model.gguf" });

    const generatePromise = adapter.generate({ prompt: "hi" });
    await pumpMicrotasks();

    state.tokenListener?.({ token: "Hi " });
    state.tokenListener?.({ token: "there" });
    await pumpMicrotasks();
    state.resolveCompletion?.({
      text: "Hi there",
      tokens_evaluated: 2,
      tokens_predicted: 2,
      timings: { predicted_ms: 30 },
    });

    const result = await generatePromise;
    expect(result.text).toBe("Hi there");
    expect(result.promptTokens).toBe(2);
    expect(result.outputTokens).toBe(2);
    expect(result.durationMs).toBe(30);
  });

  it("accepts samplerStages without throwing (native bridge is no-op for now)", async () => {
    vi.resetModules();
    const state = installMockPlugin();
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");

    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({ modelPath: "/tmp/model.gguf" });

    const consume = (async () => {
      const out: string[] = [];
      for await (const event of adapter.generateStream({
        prompt: "hi",
        specDecode: false,
        samplerStages: [
          {
            kind: "logit_bias",
            bias: { 42: -100 },
          },
        ],
      })) {
        out.push(event.kind);
      }
      return out;
    })();

    await pumpMicrotasks();
    state.resolveCompletion?.({
      text: "ok",
      tokens_evaluated: 1,
      tokens_predicted: 1,
      timings: { predicted_ms: 10 },
    });

    const kinds = await consume;
    expect(kinds).toEqual(["done"]);
  });
});
