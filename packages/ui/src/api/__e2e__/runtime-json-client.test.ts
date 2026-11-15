import { describe, expect, it } from "vitest";
import {
  createRuntimeJsonClient,
  RUNTIME_NOT_READY,
  type RuntimeJsonBridge,
  type RuntimeJsonResponse,
  type RuntimeStatus,
} from "../runtime-json-client";

type Reply = RuntimeJsonResponse | Error;

/** A native runtime that can stop, start and report not-ready like an embedded service. */
function runtime(replies: Reply[] = []) {
  const calls = { status: 0, start: 0, restart: 0, sent: [] as unknown[] };
  let state = "running";
  const status = (): RuntimeStatus => ({ available: true, state });
  const bridge: RuntimeJsonBridge = {
    async status() {
      calls.status++;
      const now = status();
      if (state === "starting") state = "running";
      return now;
    },
    async start() {
      calls.start++;
      state = "starting";
      return status();
    },
    async restart() {
      calls.restart++;
      state = "starting";
      return status();
    },
    async request(input) {
      calls.sent.push(input.body);
      const reply = replies.shift() ?? { status: 200, data: { ok: true } };
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { bridge, calls, stop: () => (state = "stopped") };
}

const notReady = () =>
  Object.assign(new Error("Runtime is not running"), {
    code: RUNTIME_NOT_READY,
  });

function options(
  bridge: RuntimeJsonBridge,
  reuseRunningStatus?: boolean,
): Parameters<typeof createRuntimeJsonClient>[0] {
  return {
    nativePlatform: () => true,
    nativeBridge: () => bridge,
    nativeFallback: () => Promise.reject(new Error("no fallback")),
    webUrl: (path) => path,
    startupTimeoutMs: 2_000,
    pollMs: 1,
    requestTimeoutMs: 2_000,
    reuseRunningStatus,
    messages: {
      invalidPath: "invalid path",
      startup: "startup failed",
      changed: "account changed",
      request: "request failed",
      fallback: "unreachable",
      invalidJson: "invalid json",
    },
  };
}

function client(bridge: RuntimeJsonBridge, reuseRunningStatus?: boolean) {
  return createRuntimeJsonClient(options(bridge, reuseRunningStatus));
}

describe("runtime JSON client native status reuse", () => {
  it("probes status before every request by default", async () => {
    const { bridge, calls } = runtime();
    const api = client(bridge);
    await api.request("/a");
    await api.request("/b");
    expect(calls.status).toBe(2);
  });

  it("probes once per account generation while the runtime stays running", async () => {
    const { bridge, calls } = runtime();
    const api = client(bridge, true);
    await api.request("/a");
    await api.request("/b", { text: "hi" });
    await api.request("/c");
    expect(calls.status).toBe(1);
    expect(calls.sent).toEqual([undefined, { text: "hi" }, undefined]);
  });

  it("starts a stopped runtime and sends an undispatched request once", async () => {
    const { bridge, calls, stop } = runtime([
      { status: 200, data: {} },
      notReady(),
    ]);
    const api = client(bridge, true);
    await api.request("/a");
    stop();
    await expect(api.request("/b", { text: "hi" })).resolves.toEqual({
      ok: true,
    });
    expect(calls.start).toBe(1);
    expect(calls.sent).toEqual([undefined, { text: "hi" }, { text: "hi" }]);
    // Running again: the next request does not probe.
    const probes = calls.status;
    await api.request("/c");
    expect(calls.status).toBe(probes);
  });

  it("never resends after another rejection, and probes the next request", async () => {
    const { bridge, calls } = runtime([
      { status: 200, data: {} },
      new Error("connection reset"),
    ]);
    const api = client(bridge, true);
    await api.request("/a");
    await expect(api.request("/b", { text: "hi" })).rejects.toThrow(
      "connection reset",
    );
    expect(calls.sent).toHaveLength(2);
    expect(calls.status).toBe(1);
    await api.request("/c");
    expect(calls.status).toBe(2);
  });

  it("never resends a not-ready rejection by default", async () => {
    const { bridge, calls } = runtime([notReady()]);
    const api = client(bridge);
    await expect(api.request("/a", { text: "hi" })).rejects.toMatchObject({
      code: RUNTIME_NOT_READY,
    });
    expect(calls.sent).toHaveLength(1);
    expect(calls.status).toBe(1);
    expect(calls.start).toBe(0);
  });

  it("does not start an unavailable runtime after a not-ready rejection", async () => {
    const { bridge, calls } = runtime([{ status: 200, data: {} }, notReady()]);
    let fallback = 0;
    const api = createRuntimeJsonClient({
      ...options(bridge, true),
      nativeFallback: async () => {
        fallback++;
        return { status: 200, data: {} };
      },
    });
    await api.request("/a");
    const probe = bridge.status;
    bridge.status = async () => {
      await probe();
      return { available: false, state: "stopped" };
    };
    await expect(api.request("/b", { text: "hi" })).rejects.toMatchObject({
      code: RUNTIME_NOT_READY,
    });
    expect(calls.start).toBe(0);
    expect(fallback).toBe(0);
    expect(calls.sent).toHaveLength(2);
  });

  it("does not resend when not-ready repeats after startup", async () => {
    const { bridge, calls } = runtime([
      { status: 200, data: {} },
      notReady(),
      notReady(),
    ]);
    const api = client(bridge, true);
    await api.request("/a");
    await expect(api.request("/b", {})).rejects.toMatchObject({
      code: RUNTIME_NOT_READY,
    });
    expect(calls.sent).toHaveLength(3);
  });

  it("treats a 503 or a not-ready response body as dispatched", async () => {
    const { bridge, calls } = runtime([
      { status: 200, data: {} },
      { status: 503, data: { error: "busy", code: RUNTIME_NOT_READY } },
    ]);
    const api = client(bridge, true);
    await api.request("/a");
    await expect(api.request("/b", {})).rejects.toMatchObject({
      status: 503,
      code: RUNTIME_NOT_READY,
    });
    expect(calls.sent).toHaveLength(2);
    await api.request("/c");
    expect(calls.status).toBe(2);
  });

  it("reuses the running status that an account refresh established", async () => {
    const { bridge, calls } = runtime();
    const api = client(bridge, true);
    await api.request("/a");
    await api.refreshNativeAccount();
    expect(calls.restart).toBe(1);
    const probes = calls.status;
    await api.request("/b");
    expect(calls.status).toBe(probes);
  });

  it("does not reuse an earlier running status after a failed refresh", async () => {
    const { bridge, calls } = runtime();
    bridge.restart = async () => {
      throw new Error("restart failed");
    };
    const api = client(bridge, true);
    await api.request("/a");
    await expect(api.refreshNativeAccount()).rejects.toThrow("restart failed");
    await expect(api.request("/b")).rejects.toThrow("restart failed");
    expect(calls.sent).toHaveLength(1);
  });
});

describe("runtime JSON client generation ownership", () => {
  it("fences a refresh between readiness and the first native dispatch", async () => {
    const { bridge, calls } = runtime();
    const api = client(bridge, true);
    const status = bridge.status;
    let refresh: Promise<void> | undefined;
    bridge.status = () => {
      const response = status();
      if (calls.status === 1) {
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
          refresh = api.refreshNativeAccount();
        })));
      }
      return response;
    };
    await expect(api.request("/old", { text: "old account" })).rejects.toThrow("account changed");
    expect(refresh).toBeDefined();
    await refresh;
    expect(calls.sent).toEqual([]);
  });

  it("fences a refresh between retry readiness and native redispatch", async () => {
    const { bridge, calls } = runtime([
      { status: 200, data: {} },
      notReady(),
    ]);
    const api = client(bridge, true);
    await api.request("/warm");
    const status = bridge.status;
    let refresh: Promise<void> | undefined;
    bridge.status = () => {
      const response = status();
      if (calls.status === 2) {
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
          refresh = api.refreshNativeAccount();
        })));
      }
      return response;
    };
    await expect(api.request("/old", { text: "old account" })).rejects.toThrow("account changed");
    expect(refresh).toBeDefined();
    await refresh;
    // The original NOT_READY attempt was explicitly undispatched. It may not
    // be resubmitted to the generation that refresh just admitted.
    expect(calls.sent).toEqual([undefined, { text: "old account" }]);
  });

  it("keeps the current running cache when an old response returns 503", async () => {
    const { bridge, calls } = runtime();
    const request = bridge.request;
    let completeOld!: (response: RuntimeJsonResponse) => void;
    bridge.request = (input) => {
      if (input.path !== "/old") return request(input);
      calls.sent.push(input.body);
      return new Promise((resolve) => { completeOld = resolve; });
    };
    const api = client(bridge, true);
    await api.request("/warm");
    const old = api.request("/old");
    const rejected = expect(old).rejects.toThrow("account changed");
    await api.refreshNativeAccount();
    await api.request("/new");
    const probes = calls.status;
    completeOld({ status: 503, data: {} });
    await rejected;
    await api.request("/later");
    expect(calls.status).toBe(probes);
  });

  it("keeps the current refresh receipt when an older refresh fails", async () => {
    const { bridge, calls } = runtime();
    let rejectOld!: (error: Error) => void;
    bridge.restart = () => {
      calls.restart++;
      if (calls.restart === 1) {
        return new Promise((_resolve, reject) => { rejectOld = reject; });
      }
      return Promise.resolve({ available: true, state: "running" });
    };
    const api = client(bridge, true);
    const old = api.refreshNativeAccount();
    const rejected = expect(old).rejects.toThrow("old restart failed");
    await expect.poll(() => calls.restart).toBe(1);
    await api.refreshNativeAccount();
    await api.request("/new");
    const probes = calls.status;
    rejectOld(new Error("old restart failed"));
    await rejected;
    await api.request("/later");
    expect(calls.status).toBe(probes);
  });
  it("recovers only after the host explicitly retries a failed refresh", async () => {
    const { bridge, calls } = runtime();
    let fail = true;
    bridge.restart = async () => {
      calls.restart++;
      if (fail) throw new Error("restart failed");
      return { available: true, state: "running" };
    };
    const api = client(bridge, true);
    await expect(api.refreshNativeAccount()).rejects.toThrow("restart failed");
    await expect(api.request("/blocked")).rejects.toThrow("restart failed");
    expect(calls.sent).toHaveLength(0);
    fail = false;
    await api.refreshNativeAccount();
    await expect(api.request("/recovered")).resolves.toEqual({ ok: true });
    expect(calls.restart).toBe(2);
    expect(calls.sent).toHaveLength(1);
  });

});
