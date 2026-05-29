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

afterEach(() => {
  window.fetch = originalWindowFetch;
  if (originalWindowCapacitor === undefined) {
    Reflect.deleteProperty(window, "Capacitor");
  } else {
    Reflect.set(window, "Capacitor", originalWindowCapacitor);
  }
  Reflect.deleteProperty(window, "__ELIZA_ANDROID_IPC_FETCH_BRIDGE__");
});

function installBridgeScript(): void {
  const doc = document.implementation.createHTMLDocument("index");
  doc.documentElement.innerHTML = indexHtml;
  const script = [...doc.querySelectorAll("script")].find((candidate) =>
    candidate.textContent?.includes("__ELIZA_ANDROID_IPC_FETCH_BRIDGE__"),
  );
  if (!script?.textContent) throw new Error("missing fetch bridge script");
  window.eval(script.textContent);
}

function createHarness(platform: string | (() => string)): BridgeHarness {
  const agentRequest = vi.fn(async () => ({
    status: 201,
    body: "bridged",
    headers: { "content-type": "text/plain" },
  }));
  const originalFetch = vi.fn(async function originalFetch(this: Window) {
    return new this.Response("original", { status: 202 });
  });
  window.fetch = originalFetch as unknown as typeof window.fetch;
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
      "http://127.0.0.1:31337/api/vincent/status",
    );

    expect(await response.text()).toBe("original");
    expect(response.status).toBe(202);
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(agentRequest).not.toHaveBeenCalled();
  });

  it("bridges native mobile loopback fetches through Agent.request", async () => {
    const { agentRequest, originalFetch } = createHarness("ios");

    const response = await window.fetch(
      "http://127.0.0.1:31337/api/vincent/status?x=1",
    );

    expect(await response.text()).toBe("bridged");
    expect(response.status).toBe(201);
    expect(originalFetch).not.toHaveBeenCalled();
    expect(agentRequest).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/vincent/status?x=1",
      headers: {},
      body: null,
    });
  });

  it("continues to bridge explicit IPC URLs on every platform", async () => {
    const { agentRequest, originalFetch } = createHarness("web");

    await window.fetch("eliza-local-agent://ipc/api/vincent/status");

    expect(originalFetch).not.toHaveBeenCalled();
    expect(agentRequest).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/vincent/status",
      headers: {},
      body: null,
    });
  });

  it("falls through for loopback fetches if platform detection throws", async () => {
    const { agentRequest, originalFetch } = createHarness(() => {
      throw new Error("platform unavailable");
    });

    await window.fetch("http://127.0.0.1:31337/api/vincent/status");

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(agentRequest).not.toHaveBeenCalled();
  });
});
