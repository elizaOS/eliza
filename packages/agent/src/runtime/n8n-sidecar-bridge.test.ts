import { describe, expect, test, vi } from "vitest";

import { bootLocalN8nSidecar } from "./n8n-sidecar-bridge.js";

interface SidecarHarness {
  status: "stopped" | "starting" | "ready" | "error";
  host: string | null;
  apiKey: string | null;
  errorMessage: string | null;
  listeners: Array<(s: { status: SidecarHarness["status"] }) => void>;
  startCalls: number;
}

function makeSidecar(initial: Partial<SidecarHarness> = {}): {
  harness: SidecarHarness;
  api: {
    start: () => Promise<void>;
    getState: () => {
      status: SidecarHarness["status"];
      host: string | null;
      errorMessage: string | null;
    };
    getApiKey: () => string | null;
    subscribe: (
      fn: (s: { status: SidecarHarness["status"] }) => void,
    ) => () => void;
  };
  /** Trigger a state transition + notify subscribers. */
  transition: (
    next: SidecarHarness["status"],
    host?: string,
    key?: string,
  ) => void;
} {
  const harness: SidecarHarness = {
    status: initial.status ?? "stopped",
    host: initial.host ?? null,
    apiKey: initial.apiKey ?? null,
    errorMessage: initial.errorMessage ?? null,
    listeners: [],
    startCalls: 0,
  };

  const api = {
    start: async () => {
      harness.startCalls += 1;
    },
    getState: () => ({
      status: harness.status,
      host: harness.host,
      errorMessage: harness.errorMessage,
    }),
    getApiKey: () => harness.apiKey,
    subscribe: (fn: (s: { status: SidecarHarness["status"] }) => void) => {
      harness.listeners.push(fn);
      return () => {
        const i = harness.listeners.indexOf(fn);
        if (i >= 0) harness.listeners.splice(i, 1);
      };
    },
  };

  const transition = (
    next: SidecarHarness["status"],
    host?: string,
    key?: string,
  ) => {
    harness.status = next;
    if (host !== undefined) harness.host = host;
    if (key !== undefined) harness.apiKey = key;
    for (const fn of [...harness.listeners]) {
      fn({ status: next });
    }
  };

  return { harness, api, transition };
}

describe("bootLocalN8nSidecar", () => {
  test("returns existing values when sidecar is already ready", async () => {
    const { api } = makeSidecar({
      status: "ready",
      host: "http://127.0.0.1:5678",
      apiKey: "preexisting-key",
    });

    const loadModule = vi.fn(async () => ({
      getN8nSidecarAsync: vi.fn(),
      peekN8nSidecar: () => api,
    }));

    const booted = await bootLocalN8nSidecar({ loadModule });

    expect(booted).toEqual({
      host: "http://127.0.0.1:5678",
      apiKey: "preexisting-key",
    });
    // Should not have constructed a new sidecar via getN8nSidecarAsync.
    const mod = await loadModule.mock.results[0].value;
    expect(mod.getN8nSidecarAsync).not.toHaveBeenCalled();
  });

  test("constructs sidecar and awaits ready transition", async () => {
    const { api, harness, transition } = makeSidecar({ status: "starting" });
    const loadModule = async () => ({
      getN8nSidecarAsync: async () => api,
      peekN8nSidecar: () => null,
    });

    const promise = bootLocalN8nSidecar({
      loadModule,
      readinessTimeoutMs: 500,
    });

    // Simulate sidecar reaching ready in the background.
    queueMicrotask(() => {
      transition("ready", "http://127.0.0.1:5680", "minted-by-sidecar");
    });

    const booted = await promise;
    expect(booted).toEqual({
      host: "http://127.0.0.1:5680",
      apiKey: "minted-by-sidecar",
    });
    expect(harness.startCalls).toBe(1);
  });

  test("returns null when sidecar reaches error", async () => {
    const { api, transition } = makeSidecar({ status: "starting" });
    const loadModule = async () => ({
      getN8nSidecarAsync: async () => api,
      peekN8nSidecar: () => null,
    });

    const promise = bootLocalN8nSidecar({
      loadModule,
      readinessTimeoutMs: 500,
    });

    queueMicrotask(() => transition("error"));

    const booted = await promise;
    expect(booted).toBeNull();
  });

  test("returns null on readiness timeout", async () => {
    const { api } = makeSidecar({ status: "starting" });
    const loadModule = async () => ({
      getN8nSidecarAsync: async () => api,
      peekN8nSidecar: () => null,
    });

    const booted = await bootLocalN8nSidecar({
      loadModule,
      readinessTimeoutMs: 50,
    });

    expect(booted).toBeNull();
  });

  test("returns null when module load fails", async () => {
    const loadModule = async () => {
      throw new Error("module not found");
    };

    const booted = await bootLocalN8nSidecar({
      loadModule: loadModule as never,
    });
    expect(booted).toBeNull();
  });

  test("returns null when sidecar reports ready but apiKey missing", async () => {
    const { api, transition } = makeSidecar({ status: "starting" });
    const loadModule = async () => ({
      getN8nSidecarAsync: async () => api,
      peekN8nSidecar: () => null,
    });

    const promise = bootLocalN8nSidecar({
      loadModule,
      readinessTimeoutMs: 500,
    });

    // host set, but apiKey stays null
    queueMicrotask(() => transition("ready", "http://127.0.0.1:5678"));

    const booted = await promise;
    expect(booted).toBeNull();
  });
});
