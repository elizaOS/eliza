/**
 * Unit tests for the Index Html Fetch Bridge app shell contract and coverage
 * guardrail.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const appRoot = join(import.meta.dirname, "..");
const indexHtml = readFileSync(join(appRoot, "index.html"), "utf8");

interface BridgeHarness {
  agentRequest: ReturnType<typeof vi.fn>;
  originalFetch: ReturnType<typeof vi.fn>;
}

const originalWindowFetch = window.fetch;
const originalWindowCapacitor = Reflect.get(window, "Capacitor");
const runtimeModeStorageKey = "eliza:mobile-runtime-mode";
const originalRuntimeMode = window.localStorage.getItem(runtimeModeStorageKey);

afterEach(() => {
  window.fetch = originalWindowFetch;
  if (originalWindowCapacitor === undefined) {
    Reflect.deleteProperty(window, "Capacitor");
  } else {
    Reflect.set(window, "Capacitor", originalWindowCapacitor);
  }
  Reflect.deleteProperty(window, "__ELIZA_ANDROID_IPC_FETCH_BRIDGE__");
  if (originalRuntimeMode === null) {
    window.localStorage.removeItem(runtimeModeStorageKey);
  } else {
    window.localStorage.setItem(runtimeModeStorageKey, originalRuntimeMode);
  }
});

function installBridgeScript(): void {
  const doc = document.implementation.createHTMLDocument("index");
  doc.documentElement.innerHTML = indexHtml;
  const script = [...doc.querySelectorAll("script")].find((candidate) =>
    candidate.textContent?.includes("__ELIZA_ANDROID_IPC_FETCH_BRIDGE__"),
  );
  if (!script?.textContent) throw new Error("missing fetch bridge script");
  // Executes the committed inline bridge script, never user input.
  // biome-ignore lint/security/noGlobalEval: the HTML shell is the system under test
  window.eval(script.textContent);
}

function createHarness(
  platform: string | (() => string),
  runtimeMode?: string,
): BridgeHarness {
  const agentRequest = vi.fn(async () => ({
    status: 201,
    body: "bridged",
    headers: { "content-type": "text/plain" },
  }));
  const originalFetch = vi.fn(async function originalFetch(this: Window) {
    return new this.Response("original", { status: 202 });
  });
  window.fetch = originalFetch as unknown as typeof window.fetch;
  if (runtimeMode === undefined) {
    window.localStorage.removeItem(runtimeModeStorageKey);
  } else {
    window.localStorage.setItem(runtimeModeStorageKey, runtimeMode);
  }
  Object.assign(window, {
    Capacitor: {
      getPlatform: typeof platform === "function" ? platform : () => platform,
      Plugins: {
        Agent: {
          request: agentRequest,
        },
      },
    },
  });
  installBridgeScript();
  return { agentRequest, originalFetch };
}

describe("index.html local-agent fetch bridge", () => {
  it("lets non-native loopback fetches hit the real backend directly", async () => {
    const { agentRequest, originalFetch } = createHarness("web");

    const response = await window.fetch(
      "http://127.0.0.1:31337/api/wallet/config",
    );

    expect(await response.text()).toBe("original");
    expect(response.status).toBe(202);
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(agentRequest).not.toHaveBeenCalled();
  });

  it("bridges native mobile loopback fetches through Agent.request", async () => {
    const { agentRequest, originalFetch } = createHarness("ios");

    const response = await window.fetch(
      "http://127.0.0.1:31337/api/wallet/config?x=1",
    );

    expect(await response.text()).toBe("bridged");
    expect(response.status).toBe(201);
    expect(originalFetch).not.toHaveBeenCalled();
    expect(agentRequest).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/wallet/config?x=1",
      headers: {},
      body: null,
    });
  });

  it.each(["remote-mac", "cloud", "tunnel-to-mobile"])(
    "lets native %s mode reach loopback HTTP directly",
    async (runtimeMode) => {
      const { agentRequest, originalFetch } = createHarness("ios", runtimeMode);

      const response = await window.fetch("http://127.0.0.1:31337/api/health");

      expect(await response.text()).toBe("original");
      expect(originalFetch).toHaveBeenCalledTimes(1);
      expect(agentRequest).not.toHaveBeenCalled();
    },
  );

  it.each(["local", "cloud-hybrid"])(
    "keeps native %s mode on Agent.request",
    async (runtimeMode) => {
      const { agentRequest, originalFetch } = createHarness("ios", runtimeMode);

      await window.fetch("http://127.0.0.1:31337/api/health");

      expect(originalFetch).not.toHaveBeenCalled();
      expect(agentRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/api/health",
        headers: {},
        body: null,
      });
    },
  );

  it("continues to bridge explicit IPC URLs on every platform", async () => {
    const { agentRequest, originalFetch } = createHarness("web");

    await window.fetch("eliza-local-agent://ipc/api/wallet/config");

    expect(originalFetch).not.toHaveBeenCalled();
    expect(agentRequest).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/wallet/config",
      headers: {},
      body: null,
    });
  });

  it("falls through for loopback fetches if platform detection throws", async () => {
    const { agentRequest, originalFetch } = createHarness(() => {
      throw new Error("platform unavailable");
    });

    await window.fetch("http://127.0.0.1:31337/api/wallet/config");

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(agentRequest).not.toHaveBeenCalled();
  });
});
