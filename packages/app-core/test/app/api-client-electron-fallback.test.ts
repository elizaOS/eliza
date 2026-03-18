// @vitest-environment jsdom

import { ElizaClient } from "@elizaos/app-core/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ElizaClient Electron API fallback", () => {
  const originalFetch = globalThis.fetch;
  const originalBase = (window as { __ELIZA_API_BASE__?: string })
    .__ELIZA_API_BASE__;
  const originalProtocol = window.location.protocol;

  beforeEach(() => {
    // Aggressively clear global state that might leak from other tests
    delete (window as { __ELIZA_API_BASE__?: string }).__ELIZA_API_BASE__;
    delete (window as { __ELIZA_API_TOKEN__?: string }).__ELIZA_API_TOKEN__;
    window.sessionStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "fetch", {
      value: originalFetch,
      writable: true,
      configurable: true,
    });
    if (originalBase !== undefined) {
      (window as { __ELIZA_API_BASE__?: string }).__ELIZA_API_BASE__ =
        originalBase;
    } else {
      delete (window as { __ELIZA_API_BASE__?: string }).__ELIZA_API_BASE__;
    }
    Object.defineProperty(window, "location", {
      value: { ...window.location, protocol: originalProtocol },
      writable: true,
    });
  });

  function setProtocol(proto: string) {
    Object.defineProperty(window, "location", {
      value: { ...window.location, protocol: proto },
      writable: true,
    });
  }

  it("does not probe localhost on capacitor-electron protocol before API base is injected", async () => {
    (window as { __ELIZA_API_BASE__?: string }).__ELIZA_API_BASE__ =
      undefined;
    setProtocol("capacitor-electron:");

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        state: "starting",
        agentName: "Eliza",
        model: undefined,
        uptime: undefined,
        startedAt: undefined,
      }),
    }));
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      writable: true,
      configurable: true,
    });

    const client = new ElizaClient();
    expect(client.apiAvailable).toBe(false);
    await expect(client.getStatus()).rejects.toThrow(
      "API not available (no HTTP origin)",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers injected API base over fallback", async () => {
    (window as { __ELIZA_API_BASE__?: string }).__ELIZA_API_BASE__ =
      "http://localhost:9999";
    setProtocol("capacitor-electron:");

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        state: "running",
        agentName: "Eliza",
        model: "test",
        uptime: 1,
        startedAt: Date.now(),
      }),
    }));
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      writable: true,
      configurable: true,
    });

    const client = new ElizaClient();
    await client.getStatus();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:9999/api/status",
      expect.any(Object),
    );
  });

  it("starts unavailable on capacitor-electron and switches to injected API base when injected later", async () => {
    (window as { __ELIZA_API_BASE__?: string }).__ELIZA_API_BASE__ =
      undefined;
    setProtocol("capacitor-electron:");

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        state: "running",
        agentName: "Eliza",
        model: "test",
        uptime: 1,
        startedAt: Date.now(),
      }),
    }));
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      writable: true,
      configurable: true,
    });

    const client = new ElizaClient();
    await expect(client.getStatus()).rejects.toThrow(
      "API not available (no HTTP origin)",
    );
    expect(fetchMock).not.toHaveBeenCalled();

    (window as { __ELIZA_API_BASE__?: string }).__ELIZA_API_BASE__ =
      "http://127.0.0.1:4444";
    await client.getStatus();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:4444/api/status",
      expect.any(Object),
    );
  });
});
