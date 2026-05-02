import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCloudRelayDestination,
  createStreamingPlugin,
  resolveStreamingBackend,
  type StreamingPluginConfig,
} from "../src/index.ts";

type SettingValue = string | boolean | number | null;

interface MockRuntime {
  getSetting(key: string): SettingValue;
}

function mockRuntime(settings: Record<string, SettingValue>): MockRuntime {
  return {
    getSetting(key: string): SettingValue {
      const value = settings[key];
      return value === undefined ? null : value;
    },
  };
}

const TWITCH_CFG: StreamingPluginConfig = {
  platformId: "twitch",
  platformName: "Twitch",
  streamKeyEnvVar: "TWITCH_STREAM_KEY",
  defaultRtmpUrl: "rtmp://live.twitch.tv/app",
  cloudRelay: true,
};

describe("resolveStreamingBackend", () => {
  it("returns 'direct' when local stream key is set (auto)", () => {
    const rt = mockRuntime({ TWITCH_STREAM_KEY: "live_xxx" });
    expect(resolveStreamingBackend(rt as never, TWITCH_CFG)).toBe("direct");
  });

  it("returns 'cloud' when no local key and cloud is connected (auto)", () => {
    const rt = mockRuntime({
      ELIZAOS_CLOUD_API_KEY: "ck-1",
      ELIZAOS_CLOUD_ENABLED: "true",
    });
    expect(resolveStreamingBackend(rt as never, TWITCH_CFG)).toBe("cloud");
  });

  it("returns 'direct' when nothing is set (auto fallback)", () => {
    expect(resolveStreamingBackend(mockRuntime({}) as never, TWITCH_CFG)).toBe(
      "direct",
    );
  });

  it("explicit 'direct' setting overrides auto pick", () => {
    const rt = mockRuntime({
      TWITCH_STREAMING_BACKEND: "direct",
      ELIZAOS_CLOUD_API_KEY: "ck-1",
      ELIZAOS_CLOUD_ENABLED: "true",
    });
    expect(resolveStreamingBackend(rt as never, TWITCH_CFG)).toBe("direct");
  });

  it("explicit 'cloud' setting wins even with local key", () => {
    const rt = mockRuntime({
      TWITCH_STREAM_KEY: "live_xxx",
      TWITCH_STREAMING_BACKEND: "cloud",
      ELIZAOS_CLOUD_API_KEY: "ck-1",
      ELIZAOS_CLOUD_ENABLED: "true",
    });
    expect(resolveStreamingBackend(rt as never, TWITCH_CFG)).toBe("cloud");
  });

  it("rejects invalid backend setting values", () => {
    const rt = mockRuntime({ TWITCH_STREAMING_BACKEND: "weird" });
    expect(() => resolveStreamingBackend(rt as never, TWITCH_CFG)).toThrow(
      /TWITCH_STREAMING_BACKEND/,
    );
  });
});

describe("createCloudRelayDestination", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws when cloud is not connected", () => {
    expect(() =>
      createCloudRelayDestination({
        platformId: "twitch",
        platformName: "Twitch",
        runtime: mockRuntime({}) as never,
      }),
    ).toThrow(/Eliza Cloud is not connected/);
  });

  it("getCredentials POSTs to /apis/streaming/sessions and returns ingest creds", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe(
        "https://www.elizacloud.ai/api/v1/apis/streaming/sessions",
      );
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer ck-1",
      });
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      expect(body).toEqual({ destinations: ["twitch"] });
      return new Response(
        JSON.stringify({
          sessionId: "sess_42",
          streamKey: "sk_relay_xyz",
          ingestUrl: "rtmp://relay.elizacloud.ai/live",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const dest = createCloudRelayDestination({
      platformId: "twitch",
      platformName: "Twitch",
      runtime: mockRuntime({
        ELIZAOS_CLOUD_API_KEY: "ck-1",
        ELIZAOS_CLOUD_ENABLED: "true",
      }) as never,
    });

    const creds = await dest.getCredentials();
    expect(creds).toEqual({
      rtmpUrl: "rtmp://relay.elizacloud.ai/live",
      rtmpKey: "sk_relay_xyz",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses ELIZAOS_CLOUD_BASE_URL override and trims trailing slashes", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe(
        "https://custom-cloud.example/api/v9/apis/streaming/sessions",
      );
      return new Response(
        JSON.stringify({
          sessionId: "sess_1",
          streamKey: "sk_1",
          ingestUrl: "rtmp://relay.custom/live",
        }),
        { status: 201 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const dest = createCloudRelayDestination({
      platformId: "twitch",
      platformName: "Twitch",
      runtime: mockRuntime({
        ELIZAOS_CLOUD_API_KEY: "ck-1",
        ELIZAOS_CLOUD_ENABLED: "true",
        ELIZAOS_CLOUD_BASE_URL: "https://custom-cloud.example/api/v9///",
      }) as never,
    });

    await dest.getCredentials();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("onStreamStop DELETEs the session and tolerates 404", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/sessions") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            sessionId: "sess_42",
            streamKey: "sk",
            ingestUrl: "rtmp://relay/live",
          }),
          { status: 201 },
        );
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const dest = createCloudRelayDestination({
      platformId: "twitch",
      platformName: "Twitch",
      runtime: mockRuntime({
        ELIZAOS_CLOUD_API_KEY: "ck-1",
        ELIZAOS_CLOUD_ENABLED: "true",
      }) as never,
    });

    await dest.getCredentials();
    expect(dest.onStreamStop).toBeDefined();
    if (dest.onStreamStop) await dest.onStreamStop();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.method).toBe("DELETE");
    expect(calls[1]?.url).toContain("/sessions/sess_42");
  });

  it("getCredentials throws on non-2xx response", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as typeof globalThis.fetch;

    const dest = createCloudRelayDestination({
      platformId: "twitch",
      platformName: "Twitch",
      runtime: mockRuntime({
        ELIZAOS_CLOUD_API_KEY: "ck-1",
        ELIZAOS_CLOUD_ENABLED: "true",
      }) as never,
    });

    await expect(dest.getCredentials()).rejects.toThrow(
      /Cloud relay session create failed/,
    );
  });

  it("getCredentials throws on malformed response body", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ sessionId: "x" }), {
        status: 201,
      })) as typeof globalThis.fetch;

    const dest = createCloudRelayDestination({
      platformId: "twitch",
      platformName: "Twitch",
      runtime: mockRuntime({
        ELIZAOS_CLOUD_API_KEY: "ck-1",
        ELIZAOS_CLOUD_ENABLED: "true",
      }) as never,
    });

    await expect(dest.getCredentials()).rejects.toThrow(
      /malformed response/,
    );
  });
});

describe("createStreamingPlugin createDestination dispatch", () => {
  it("returns direct destination when cloudRelay flag absent", () => {
    const { createDestination } = createStreamingPlugin({
      ...TWITCH_CFG,
      cloudRelay: false,
    });
    const rt = mockRuntime({
      ELIZAOS_CLOUD_API_KEY: "ck-1",
      ELIZAOS_CLOUD_ENABLED: "true",
    });
    const dest = createDestination(rt as never, { streamKey: "live_local" });
    expect(dest.id).toBe("twitch");
    expect(dest.onStreamStop).toBeUndefined();
  });

  it("returns cloud destination when cloudRelay + cloud-only env", () => {
    const { createDestination } = createStreamingPlugin(TWITCH_CFG);
    const rt = mockRuntime({
      ELIZAOS_CLOUD_API_KEY: "ck-1",
      ELIZAOS_CLOUD_ENABLED: "true",
    });
    const dest = createDestination(rt as never);
    expect(dest.onStreamStop).toBeDefined();
  });

  it("falls back to direct when cloudRelay + local key set", () => {
    const { createDestination } = createStreamingPlugin(TWITCH_CFG);
    const rt = mockRuntime({
      TWITCH_STREAM_KEY: "live_local",
      ELIZAOS_CLOUD_API_KEY: "ck-1",
      ELIZAOS_CLOUD_ENABLED: "true",
    });
    const dest = createDestination(rt as never, { streamKey: "live_local" });
    expect(dest.onStreamStop).toBeUndefined();
  });
});
