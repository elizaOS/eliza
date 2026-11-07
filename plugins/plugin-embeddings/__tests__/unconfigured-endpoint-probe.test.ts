/**
 * EMBEDDING_API_KEY alone activates this plugin, but real requests need
 * EMBEDDING_BASE_URL. The runtime's boot probe pins the first TEXT_EMBEDDING
 * provider that answers a null call, so an endpoint-less plugin must fail that
 * probe. Otherwise it outranks a working on-device embedder (priority 1 over
 * 0) and every real embedding call throws. Real runtime (SQLite) and plugin
 * registration; no request leaves the process.
 */
import { ModelType, type Plugin } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldEnable } from "../auto-enable";
import embeddingsPlugin, { handleTextEmbedding } from "../src/index";

const ON_DEVICE_WIDTH = 384;

/** A working local embedder at local-inference's priority, below this plugin. */
const onDeviceEmbedder: Plugin = {
  name: "on-device-embedder",
  description: "Test on-device TEXT_EMBEDDING provider",
  priority: 0,
  models: {
    [ModelType.TEXT_EMBEDDING]: async () =>
      Array.from({ length: ON_DEVICE_WIDTH }, (_, i) => (i === 0 ? 1 : 0)),
  },
};

function runtimeWith(settings: Record<string, string>, plugins: Plugin[] = []) {
  return createSQLiteTestRuntime({
    logLevel: "fatal",
    character: { name: "Agent", bio: ["test"], settings },
    plugins,
  });
}

const fetchSpy = vi.fn(async () => {
  throw new Error("unexpected embedding request");
});

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embedding dimension probe without EMBEDDING_BASE_URL", () => {
  it("leaves the slot to a working embedder when only EMBEDDING_API_KEY is set", async () => {
    expect(
      shouldEnable({ env: { EMBEDDING_API_KEY: "test-key" }, config: {}, isNativePlatform: false })
    ).toBe(true);
    const runtime = runtimeWith({ EMBEDDING_API_KEY: "test-key" }, [
      onDeviceEmbedder,
      embeddingsPlugin,
    ]);
    await runtime.initialize({ skipMigrations: true });
    try {
      const vector = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
        text: "remember this",
      });
      expect(vector).toHaveLength(ON_DEVICE_WIDTH);
    } finally {
      await runtime.stop();
    }
  });

  it("fails the null probe instead of returning a marker vector", async () => {
    const runtime = runtimeWith({ EMBEDDING_API_KEY: "test-key" });
    await expect(handleTextEmbedding(runtime, null)).rejects.toThrow(
      "No embedding endpoint configured. Set EMBEDDING_BASE_URL."
    );
  });

  it("still answers the null probe with the configured width when the endpoint is set", async () => {
    const runtime = runtimeWith({
      EMBEDDING_BASE_URL: "https://embedding.test",
      EMBEDDING_DIMENSIONS: "384",
    });
    const probe = await handleTextEmbedding(runtime, null);
    expect(probe).toHaveLength(384);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
