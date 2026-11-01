/**
 * The pre-warm sends exactly one credential-free OPTIONS to the inference URL
 * the text handlers use, only when Cloud serves text, at most once a minute.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";

const BASE = "https://api.example.invalid/api/v1";

function runtime(options: { provider?: string; apiKey?: string } = {}): IAgentRuntime {
  const settings: Record<string, string | undefined> = {
    ELIZAOS_CLOUD_BASE_URL: `${BASE}/`,
    ELIZAOS_CLOUD_API_KEY: "apiKey" in options ? options.apiKey : "test-key-not-real",
  };
  return {
    getSetting: (key: string) => settings[key],
    getModelRegistrations: () => [
      { modelType: "TEXT_EMBEDDING", provider: "elizaOSCloud", priority: 50, registrationOrder: 0 },
      { modelType: "RESPONSE_HANDLER", provider: options.provider ?? "elizaOSCloud", priority: 50, registrationOrder: 1 },
    ],
  } as unknown as IAgentRuntime;
}

async function load() {
  vi.resetModules();
  return import("./cloud-warm-route");
}

describe("cloud inference pre-warm", () => {
  const savedEnv = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("ELIZAOS_CLOUD") || k.startsWith("ELIZA_DEV_CLOUD")) delete process.env[k];
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.env = { ...savedEnv };
  });

  it("sends one OPTIONS without credentials or body to the chat/completions URL", async () => {
    const { warmCloudInference } = await load();
    const result = await warmCloudInference(runtime());
    expect(result).toMatchObject({ warmed: true, status: 204 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/chat/completions`);
    expect(init.method).toBe("OPTIONS");
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
    expect(JSON.stringify(init)).not.toContain("test-key-not-real");
  });

  it("debounces to once per 60s, including concurrent triggers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const { warmCloudInference, CLOUD_WARM_INTERVAL_MS } = await load();
    const [a, b] = await Promise.all([warmCloudInference(runtime()), warmCloudInference(runtime())]);
    expect([a.warmed, b.warmed].sort()).toEqual([false, true]);
    vi.setSystemTime(1_000_000 + CLOUD_WARM_INTERVAL_MS - 1);
    expect(await warmCloudInference(runtime())).toEqual({ warmed: false, reason: "debounced" });
    vi.setSystemTime(1_000_000 + CLOUD_WARM_INTERVAL_MS);
    expect((await warmCloudInference(runtime())).warmed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does nothing when another provider owns text or Cloud has no key", async () => {
    const { warmCloudInference } = await load();
    expect(await warmCloudInference(runtime({ provider: "cerebras" }))).toEqual({ warmed: false, reason: "not-cloud-text" });
    expect(await warmCloudInference(runtime({ apiKey: undefined }))).toEqual({ warmed: false, reason: "not-cloud-text" });
    expect(await warmCloudInference(null)).toEqual({ warmed: false, reason: "not-cloud-text" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a network failure as unreachable and still debounces", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const { warmCloudInference } = await load();
    expect(await warmCloudInference(runtime())).toEqual({ warmed: false, reason: "unreachable" });
    expect(await warmCloudInference(runtime())).toEqual({ warmed: false, reason: "debounced" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is registered as POST /api/cloud/warm on the route plugin", async () => {
    vi.resetModules();
    const { elizaCloudRoutePlugin } = await import("../plugin");
    const route = elizaCloudRoutePlugin.routes?.find((r) => r.path === "/api/cloud/warm");
    expect(route).toMatchObject({ type: "POST", rawPath: true });
  });
});
