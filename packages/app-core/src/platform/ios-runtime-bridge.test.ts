// @vitest-environment jsdom

/**
 * Exercises the browser-side iOS full-Bun smoke against deterministic native,
 * storage, and HTTP boundaries. The route sequence and model replies are real
 * contract shapes; only the simulator/Bun process boundary is substituted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const preferences = new Map<string, string>();
  return {
    preferences,
    preferenceGet: vi.fn(async ({ key }: { key: string }) => ({
      value: preferences.get(key) ?? null,
    })),
    preferenceSet: vi.fn(
      async ({ key, value }: { key: string; value: string }) => {
        preferences.set(key, value);
      },
    ),
    preferenceRemove: vi.fn(async ({ key }: { key: string }) => {
      preferences.delete(key);
    }),
    primeRuntime: vi.fn(),
    start: vi.fn(),
    getStatus: vi.fn(),
    call: vi.fn(),
  };
});

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: harness.preferenceGet,
    set: harness.preferenceSet,
    remove: harness.preferenceRemove,
  },
}));

vi.mock("@elizaos/capacitor-bun-runtime", () => ({
  ElizaBunRuntime: {
    start: harness.start,
    getStatus: harness.getStatus,
    call: harness.call,
  },
}));

vi.mock("../api/ios-local-agent-transport", () => ({
  primeIosFullBunRuntime: harness.primeRuntime,
}));

const REQUEST_KEY = "eliza:ios-full-bun-smoke:request";
const RESULT_KEY = "eliza:ios-full-bun-smoke:result";
const RUNTIME_MODE_KEY = "eliza:mobile-runtime-mode";

function installLocalStorage({ throwOnGet = false } = {}) {
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => {
      if (throwOnGet) throw new Error("WebKit storage unavailable");
      return values.get(key) ?? null;
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, String(value));
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  return storage;
}

function jsonResponse(value: unknown) {
  return {
    status: 200,
    text: async () => JSON.stringify(value),
  } as Response;
}

function textResponse(value: string) {
  return { status: 200, text: async () => value } as Response;
}

const PROVEN_MODEL_REPLY = "The iOS full Bun local backend is running.";

function installHappyFetch({ messageReply = PROVEN_MODEL_REPLY } = {}) {
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const route = String(input);
      const method = init?.method ?? "GET";
      if (route === "/api/health") {
        return jsonResponse({ ready: true, runtime: "ok" });
      }
      if (route === "/api/local-inference/hub") {
        return jsonResponse({
          catalog: [],
          installed: [{ id: "eliza-small" }],
          active: {},
          assignments: {},
        });
      }
      if (route === "/api/local-inference/providers") {
        return jsonResponse({
          providers: [
            {
              id: "capacitor-llama",
              registeredSlots: ["TEXT_SMALL", "TEXT_LARGE"],
            },
          ],
        });
      }
      if (route === "/api/local-inference/device") {
        return jsonResponse({
          enabled: true,
          connected: true,
          transport: "bun-host-ipc",
          devices: [],
        });
      }
      if (route === "/api/local-inference/active" && method === "POST") {
        return jsonResponse({
          status: "ready",
          modelPath: "/models/eliza.gguf",
        });
      }
      if (route === "/api/local-inference/active") {
        return jsonResponse({ modelId: "eliza-small", status: "ready" });
      }
      if (route === "/api/local-inference/installed") {
        return jsonResponse({ models: [{ id: "eliza-small" }] });
      }
      if (route === "/api/local-inference/routing") {
        return jsonResponse({ registrations: [], preferences: {} });
      }
      if (route === "/api/conversations") {
        return jsonResponse({ conversation: { id: "conversation-1" } });
      }
      if (route.endsWith("/messages/stream")) {
        return textResponse(
          `data: {"type":"delta","text":"${PROVEN_MODEL_REPLY}"}\n\ndata: {"type":"done"}\n\n`,
        );
      }
      if (route.endsWith("/messages")) {
        return jsonResponse({ text: messageReply });
      }
      throw new Error(`unexpected smoke fetch: ${method} ${route}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  harness.preferences.clear();
  installLocalStorage();
  document.body.innerHTML = "<div>normal app</div>";
  harness.start.mockResolvedValue({ ok: true });
  harness.getStatus.mockResolvedValue({ ready: true, engine: "bun" });
  harness.call
    .mockResolvedValueOnce({ result: { ready: true } })
    .mockResolvedValueOnce({
      result: {
        status: 200,
        body: JSON.stringify({ ready: true, runtime: "ok" }),
      },
    });
});

describe("iOS full-Bun browser smoke", () => {
  it("drives the complete strict nonstream and stream contract", async () => {
    const fetchMock = installHappyFetch();
    window.localStorage.setItem(REQUEST_KEY, "1");
    window.localStorage.setItem(RUNTIME_MODE_KEY, "local");
    const { runIosFullBunSmokeIfRequested } = await import(
      "./ios-runtime-bridge"
    );

    await expect(runIosFullBunSmokeIfRequested()).resolves.toBe(true);

    expect(harness.primeRuntime).toHaveBeenCalledOnce();
    expect(harness.start).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "bun",
        env: expect.objectContaining({
          ELIZA_IOS_BUN_STARTUP_TIMEOUT_MS: "300000",
          ELIZA_IOS_FULL_BUN_SMOKE: "1",
        }),
      }),
    );
    const messageCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/messages"),
    );
    expect(messageCalls).toHaveLength(2);
    for (const [, init] of messageCalls) {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        text: "In one short sentence, confirm the iOS full Bun local backend is running.",
        source: "ios-local",
      });
    }
    const result = JSON.parse(harness.preferences.get(RESULT_KEY) ?? "null");
    expect(result).toMatchObject({
      ok: true,
      phase: "complete",
      conversationId: "conversation-1",
      modelInput: {
        text: "In one short sentence, confirm the iOS full Bun local backend is running.",
        channelType: "DM",
        source: "ios-local",
      },
      sendMessage: { text: PROVEN_MODEL_REPLY },
    });
    expect(result.streamMessage).toContain('"type":"done"');
    expect(harness.preferences.has(REQUEST_KEY)).toBe(false);
    expect(window.__ELIZA_IOS_LOCAL_AGENT_DEBUG__).toBeUndefined();
    expect(document.body.textContent).toContain("iOS full Bun backend smoke");
  });

  it("fails closed when the live-model reply differs from the proven sentence", async () => {
    installHappyFetch({ messageReply: "A nearby but unproven reply." });
    window.localStorage.setItem(REQUEST_KEY, "1");
    window.localStorage.setItem(RUNTIME_MODE_KEY, "local");
    const { runIosFullBunSmokeIfRequested } = await import(
      "./ios-runtime-bridge"
    );

    await expect(runIosFullBunSmokeIfRequested()).resolves.toBe(true);

    const result = JSON.parse(harness.preferences.get(RESULT_KEY) ?? "null");
    expect(result).toMatchObject({
      ok: false,
      phase: "failed",
    });
    expect(result.error).toContain(
      "did not return the expected local model reply",
    );
  });

  it("honors native Preferences when localStorage reads fail", async () => {
    harness.preferences.set(REQUEST_KEY, "1");
    harness.preferences.set(RUNTIME_MODE_KEY, "cloud");
    installLocalStorage({ throwOnGet: true });
    const { runIosFullBunSmokeIfRequested } = await import(
      "./ios-runtime-bridge"
    );

    await expect(runIosFullBunSmokeIfRequested()).resolves.toBe(false);

    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.preferences.has(REQUEST_KEY)).toBe(false);
  });
});
