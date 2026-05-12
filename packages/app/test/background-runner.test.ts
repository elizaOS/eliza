import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const runnerPath = join(
  import.meta.dirname,
  "..",
  "public",
  "runners",
  "eliza-tasks.js",
);

type RunnerListener = (
  resolve: (value: unknown) => void,
  reject: (reason?: unknown) => void,
  args?: unknown,
) => void;

function loadRunner() {
  const source = readFileSync(runnerPath, "utf8");
  const listeners = new Map<string, RunnerListener>();
  const kv = new Map<string, string>();
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, ranTasks: 0 }),
  }));

  const sandbox: Record<string, unknown> = {
    console: { error: () => undefined, warn: () => undefined },
    Date,
    Error,
    JSON,
    Map,
    Promise,
    String,
    fetch: fetchMock,
    CapacitorKV: {
      get(key: string) {
        return { value: kv.get(key) ?? "" };
      },
      set(key: string, value: string) {
        kv.set(key, value);
      },
    },
    addEventListener(event: string, listener: RunnerListener) {
      listeners.set(event, listener);
    },
  };
  sandbox.globalThis = sandbox;

  vm.runInContext(source, vm.createContext(sandbox), {
    filename: runnerPath,
  });

  function dispatch(event: string, dataArgs: Record<string, unknown>) {
    const listener = listeners.get(event);
    if (!listener) throw new Error(`Missing runner listener: ${event}`);
    return new Promise((resolve, reject) => {
      listener(resolve, reject, { dataArgs });
    });
  }

  function readKv(key: string): unknown {
    const raw = kv.get(key);
    return raw ? JSON.parse(raw) : null;
  }

  return { dispatch, fetchMock, readKv };
}

describe("public/runners/eliza-tasks.js", () => {
  it("records an explicit iOS-local ITTP background skip instead of probing TCP", async () => {
    const runner = loadRunner();
    await runner.dispatch("configure", {
      platform: "ios",
      mode: "local",
      localRouteKernel: "ittp",
    });

    const result = await runner.dispatch("wake", {});

    expect(result).toMatchObject({
      ok: true,
      skipped: true,
      platform: "ios",
      mode: "local",
      reason: "ios_ittp_route_kernel_unavailable_in_background_jscontext",
    });
    expect(runner.fetchMock).not.toHaveBeenCalled();
    expect(runner.readKv("eliza.background.lastResult")).toMatchObject({
      skipped: true,
      reason: "ios_ittp_route_kernel_unavailable_in_background_jscontext",
    });
  });

  it("still posts to a configured non-local background endpoint", async () => {
    const runner = loadRunner();
    const result = await runner.dispatch("wake", {
      platform: "ios",
      mode: "cloud-hybrid",
      apiBase: "https://agent.example",
      authToken: "token-123",
    });

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      body: { ok: true, ranTasks: 0 },
    });
    expect(runner.fetchMock).toHaveBeenCalledWith(
      "https://agent.example/api/background/run-due-tasks",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token-123",
        }),
      }),
    );
  });
});
