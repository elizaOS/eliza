/**
 * Plain-web boot shim coverage for same-origin API and WebSocket repair.
 *
 * The module runs as the first side-effect import in the renderer entrypoint,
 * so these tests import it fresh per case with mocked platform detectors and a
 * controlled browser location.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformState = vi.hoisted(() => ({
  isElectrobun: false,
  isNative: false,
  setElizaApiBase: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => platformState.isNative,
  },
}));

vi.mock("@elizaos/ui/bridge", () => ({
  isElectrobunRuntime: () => platformState.isElectrobun,
}));

vi.mock("@elizaos/shared", () => ({
  setElizaApiBase: platformState.setElizaApiBase,
}));

function setLocation(url: string): void {
  const parsed = new URL(url);
  vi.stubGlobal("location", {
    protocol: parsed.protocol,
    host: parsed.host,
    hostname: parsed.hostname,
  });
}

function setGlobal(key: string, value: unknown): void {
  (window as unknown as Record<string, unknown>)[key] = value;
}

function getGlobal(key: string): unknown {
  return (window as unknown as Record<string, unknown>)[key];
}

async function importFreshShim(): Promise<void> {
  vi.resetModules();
  await import("./web-ws-base-fix");
}

beforeEach(() => {
  platformState.isElectrobun = false;
  platformState.isNative = false;
  platformState.setElizaApiBase.mockReset();
  for (const key of [
    "__ELIZA_WS_BASE__",
    "__ELIZAOS_WS_BASE__",
    "__ACME_WS_BASE__",
    "__ELIZA_APP_API_BASE__",
  ]) {
    Reflect.deleteProperty(window, key);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("web same-origin WS base repair", () => {
  it("rewrites desktop-loopback WS globals and API base on remote https plain web", async () => {
    setLocation("https://app.example.test/dashboard");
    setGlobal("__ELIZA_WS_BASE__", "ws://127.0.0.1:31337");
    setGlobal("__ELIZAOS_WS_BASE__", "http://127.0.0.1:31337");
    setGlobal("__ACME_WS_BASE__", "ws://127.0.0.1:31337");
    setGlobal("__ELIZA_APP_API_BASE__", "https://brand.example.test");

    await importFreshShim();

    expect(getGlobal("__ELIZA_WS_BASE__")).toBe("wss://app.example.test");
    expect(getGlobal("__ELIZAOS_WS_BASE__")).toBe("wss://app.example.test");
    expect(getGlobal("__ACME_WS_BASE__")).toBe("wss://app.example.test");
    expect(getGlobal("__ELIZA_APP_API_BASE__")).toBe(
      "https://brand.example.test",
    );
    expect(platformState.setElizaApiBase).toHaveBeenCalledWith(
      "https://app.example.test",
    );
  });

  it("uses ws/http same-origin bases for remote plain http", async () => {
    setLocation("http://preview.example.test/chat");
    setGlobal("__ELIZA_WS_BASE__", "ws://127.0.0.1:31337");

    await importFreshShim();

    expect(getGlobal("__ELIZA_WS_BASE__")).toBe("ws://preview.example.test");
    expect(getGlobal("__ELIZAOS_WS_BASE__")).toBe("ws://preview.example.test");
    expect(platformState.setElizaApiBase).toHaveBeenCalledWith(
      "http://preview.example.test",
    );
  });

  it("does not rewrite loopback browser sessions", async () => {
    setLocation("http://localhost:2138");
    setGlobal("__ELIZA_WS_BASE__", "ws://127.0.0.1:31337");

    await importFreshShim();

    expect(getGlobal("__ELIZA_WS_BASE__")).toBe("ws://127.0.0.1:31337");
    expect(getGlobal("__ELIZAOS_WS_BASE__")).toBeUndefined();
    expect(platformState.setElizaApiBase).not.toHaveBeenCalled();
  });

  it("does not rewrite Electrobun desktop sessions", async () => {
    platformState.isElectrobun = true;
    setLocation("https://desktop-shell.example.test");
    setGlobal("__ELIZA_WS_BASE__", "ws://127.0.0.1:31337");

    await importFreshShim();

    expect(getGlobal("__ELIZA_WS_BASE__")).toBe("ws://127.0.0.1:31337");
    expect(platformState.setElizaApiBase).not.toHaveBeenCalled();
  });

  it("does not rewrite Capacitor native sessions", async () => {
    platformState.isNative = true;
    setLocation("https://native-shell.example.test");
    setGlobal("__ELIZA_WS_BASE__", "ws://127.0.0.1:31337");

    await importFreshShim();

    expect(getGlobal("__ELIZA_WS_BASE__")).toBe("ws://127.0.0.1:31337");
    expect(platformState.setElizaApiBase).not.toHaveBeenCalled();
  });

  it("does not second-guess an already secure injected WS base", async () => {
    setLocation("https://app.example.test");
    setGlobal("__ELIZA_WS_BASE__", "wss://api.example.test");

    await importFreshShim();

    expect(getGlobal("__ELIZA_WS_BASE__")).toBe("wss://api.example.test");
    expect(getGlobal("__ELIZAOS_WS_BASE__")).toBeUndefined();
    expect(platformState.setElizaApiBase).not.toHaveBeenCalled();
  });
});
