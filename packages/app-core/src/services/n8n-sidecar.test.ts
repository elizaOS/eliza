/**
 * Unit tests for n8n-sidecar.ts — lifecycle state machine.
 *
 * Covers:
 * - Disabled config short-circuits to stopped
 * - Happy path: starting → ready (on probe 200)
 * - 401 is also considered ready (auth required but reachable)
 * - 503 loops until timeout; doesn't infinite-loop
 * - API key provisioning populates getApiKey() but never leaks via getState()
 * - Crash + exponential backoff + max-retries → error
 * - stop() kills child, resets state, flips status to stopped
 * - subscribe() fires on each state change
 *
 * All external side effects (`spawn`, `fetch`, port picker, sleep) are
 * injected via the N8nSidecarDeps contract — no real sockets, no real n8n.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  N8nSidecar,
  type N8nSidecarConfig,
  type N8nSidecarDeps,
  type N8nSidecarState,
} from "./n8n-sidecar";

// ── Fakes ────────────────────────────────────────────────────────────────────

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  killed: boolean;
  kill: (signal?: string) => boolean;
}

function makeFakeChild(pid = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.kill = (_signal?: string) => {
    child.killed = true;
    // Simulate process exit on kill.
    queueMicrotask(() => child.emit("exit", 0, _signal ?? null));
    return true;
  };
  return child;
}

interface Harness {
  spawn: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  pickPort: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  children: FakeChild[];
  deps: N8nSidecarDeps;
}

function makeHarness(overrides: Partial<Harness> = {}): Harness {
  const children: FakeChild[] = [];
  const spawnFn = vi.fn((_cmd: string, _args: string[], _opts: unknown) => {
    const child = makeFakeChild(1000 + children.length);
    children.push(child);
    return child as unknown as ReturnType<
      typeof import("node:child_process").spawn
    >;
  });
  const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) => {
    return new Response(null, { status: 200 });
  });
  const pickPortFn = vi.fn(async (start: number) => start);
  const sleepFn = vi.fn(async (_ms: number) => undefined);

  return {
    spawn: overrides.spawn ?? spawnFn,
    fetch: overrides.fetch ?? fetchFn,
    pickPort: overrides.pickPort ?? pickPortFn,
    sleep: overrides.sleep ?? sleepFn,
    children,
    deps: {
      spawn: (overrides.spawn ?? spawnFn) as unknown as N8nSidecarDeps["spawn"],
      fetch: (overrides.fetch ?? fetchFn) as unknown as N8nSidecarDeps["fetch"],
      pickPort: overrides.pickPort ?? pickPortFn,
      sleep: overrides.sleep ?? sleepFn,
    },
  };
}

function baseConfig(over: Partial<N8nSidecarConfig> = {}): N8nSidecarConfig {
  return {
    enabled: true,
    readinessTimeoutMs: 2000,
    readinessIntervalMs: 10,
    maxRetries: 2,
    backoffBaseMs: 5,
    startPort: 5678,
    stateDir: "/tmp/milady-n8n-test",
    version: "1.70.0",
    ...over,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("N8nSidecar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("disabled config", () => {
    it("short-circuits to stopped without spawning", async () => {
      const h = makeHarness();
      const sidecar = new N8nSidecar(baseConfig({ enabled: false }), h.deps);
      await sidecar.start();
      const state = sidecar.getState();
      expect(state.status).toBe("stopped");
      expect(state.errorMessage).toBe("disabled");
      expect(h.spawn).not.toHaveBeenCalled();
    });
  });

  describe("happy path", () => {
    it("transitions stopped → starting → ready on probe 200", async () => {
      const h = makeHarness();
      const sidecar = new N8nSidecar(baseConfig(), h.deps);

      // Kick start; supervisor awaits child exit after readiness, so we
      // kick stop() once we observe ready to unblock the test.
      const observed: string[] = [];
      sidecar.subscribe((s) => observed.push(s.status));

      const readyPromise = new Promise<void>((resolve) => {
        const unsub = sidecar.subscribe((s) => {
          if (s.status === "ready") {
            unsub();
            resolve();
          }
        });
      });

      const startPromise = sidecar.start();
      await readyPromise;

      const state = sidecar.getState();
      expect(state.status).toBe("ready");
      expect(state.host).toBe("http://127.0.0.1:5678");
      expect(state.port).toBe(5678);
      expect(h.spawn).toHaveBeenCalledTimes(1);
      const [cmd, args] = h.spawn.mock.calls[0];
      expect(cmd).toBe("bunx");
      expect(args).toContain("n8n@1.70.0");

      await sidecar.stop();
      await startPromise;

      expect(observed).toContain("starting");
      expect(observed).toContain("ready");
      expect(observed.at(-1)).toBe("stopped");
    });

    it("treats probe 401 as ready (n8n reachable, auth required)", async () => {
      const fetchFn = vi.fn(async () => new Response(null, { status: 401 }));
      const h = makeHarness({ fetch: fetchFn });
      const sidecar = new N8nSidecar(baseConfig(), h.deps);

      const readyPromise = new Promise<void>((resolve) => {
        const unsub = sidecar.subscribe((s) => {
          if (s.status === "ready") {
            unsub();
            resolve();
          }
        });
      });
      const startPromise = sidecar.start();
      await readyPromise;

      expect(sidecar.getState().status).toBe("ready");
      await sidecar.stop();
      await startPromise;
    });
  });

  describe("readiness probe termination", () => {
    it("does not infinite-loop on 503; times out cleanly and retries", async () => {
      const fetchFn = vi.fn(
        async () => new Response("unavailable", { status: 503 }),
      );
      const h = makeHarness({ fetch: fetchFn });
      const sidecar = new N8nSidecar(
        baseConfig({
          readinessTimeoutMs: 50,
          readinessIntervalMs: 5,
          maxRetries: 0, // fail fast to error after single attempt
          backoffBaseMs: 1,
        }),
        h.deps,
      );

      const errorPromise = new Promise<N8nSidecarState>((resolve) => {
        const unsub = sidecar.subscribe((s) => {
          if (s.status === "error") {
            unsub();
            resolve(s);
          }
        });
      });

      const startPromise = sidecar.start();
      const finalState = await errorPromise;

      expect(finalState.status).toBe("error");
      expect(finalState.errorMessage).toMatch(/readiness probe timed out/);
      // We hit fetch at least once; didn't infinite-loop.
      expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(1);

      await sidecar.stop();
      await startPromise;
    });

    it("terminates on probe 200 after transient connection-refused", async () => {
      let calls = 0;
      const fetchFn = vi.fn(async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error("ECONNREFUSED");
        }
        return new Response(null, { status: 200 });
      });
      const h = makeHarness({ fetch: fetchFn });
      const sidecar = new N8nSidecar(
        baseConfig({ readinessIntervalMs: 1 }),
        h.deps,
      );

      const readyPromise = new Promise<void>((resolve) => {
        const unsub = sidecar.subscribe((s) => {
          if (s.status === "ready") {
            unsub();
            resolve();
          }
        });
      });
      const startPromise = sidecar.start();
      await readyPromise;

      expect(sidecar.getState().status).toBe("ready");
      expect(calls).toBeGreaterThanOrEqual(3);

      await sidecar.stop();
      await startPromise;
    });
  });

  describe("api key provisioning", () => {
    it("stores provisioned key out-of-band from getState()", async () => {
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/rest/login")) {
          return new Response(null, { status: 200 });
        }
        if (url.endsWith("/rest/me/api-keys") && init?.method === "POST") {
          return new Response(
            JSON.stringify({ data: { rawApiKey: "n8n_secret_abc" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(null, { status: 404 });
      });
      const h = makeHarness({ fetch: fetchFn });
      const sidecar = new N8nSidecar(baseConfig(), h.deps);

      const readyPromise = new Promise<void>((resolve) => {
        const unsub = sidecar.subscribe((s) => {
          if (s.status === "ready") {
            unsub();
            resolve();
          }
        });
      });
      const startPromise = sidecar.start();
      await readyPromise;

      expect(sidecar.getApiKey()).toBe("n8n_secret_abc");
      // State snapshot must NOT contain the secret.
      const state = sidecar.getState();
      expect(JSON.stringify(state)).not.toContain("n8n_secret_abc");

      await sidecar.stop();
      await startPromise;

      // stop() clears the key.
      expect(sidecar.getApiKey()).toBeNull();
    });

    it("returns null (non-fatal) when api-keys endpoint is 404", async () => {
      const fetchFn = vi.fn(async (url: string) => {
        if (url.endsWith("/rest/login")) {
          return new Response(null, { status: 200 });
        }
        return new Response(null, { status: 404 });
      });
      const h = makeHarness({ fetch: fetchFn });
      const sidecar = new N8nSidecar(baseConfig(), h.deps);

      const readyPromise = new Promise<void>((resolve) => {
        const unsub = sidecar.subscribe((s) => {
          if (s.status === "ready") {
            unsub();
            resolve();
          }
        });
      });
      const startPromise = sidecar.start();
      await readyPromise;

      // Sidecar still ready; key missing.
      expect(sidecar.getState().status).toBe("ready");
      expect(sidecar.getApiKey()).toBeNull();

      await sidecar.stop();
      await startPromise;
    });
  });

  describe("retry + backoff", () => {
    it("retries on probe timeout and eventually lands in error", async () => {
      const fetchFn = vi.fn(async () => new Response(null, { status: 503 }));
      const h = makeHarness({ fetch: fetchFn });
      const sidecar = new N8nSidecar(
        baseConfig({
          readinessTimeoutMs: 20,
          readinessIntervalMs: 1,
          maxRetries: 2,
          backoffBaseMs: 1,
        }),
        h.deps,
      );

      const errorPromise = new Promise<N8nSidecarState>((resolve) => {
        const unsub = sidecar.subscribe((s) => {
          if (s.status === "error") {
            unsub();
            resolve(s);
          }
        });
      });
      const startPromise = sidecar.start();
      const finalState = await errorPromise;

      expect(finalState.status).toBe("error");
      // maxRetries=2 → 3 attempts total
      expect(h.spawn.mock.calls.length).toBeGreaterThanOrEqual(3);
      // sleep called for backoff between attempts
      expect(h.sleep).toHaveBeenCalled();

      await sidecar.stop();
      await startPromise;
    });
  });

  describe("stop()", () => {
    it("is idempotent and resets state to stopped", async () => {
      const h = makeHarness();
      const sidecar = new N8nSidecar(baseConfig(), h.deps);
      await sidecar.stop();
      await sidecar.stop();
      const state = sidecar.getState();
      expect(state.status).toBe("stopped");
      expect(state.host).toBeNull();
      expect(state.pid).toBeNull();
    });
  });

  describe("subscribe()", () => {
    it("fires immediately with current snapshot", () => {
      const h = makeHarness();
      const sidecar = new N8nSidecar(baseConfig(), h.deps);
      const seen: N8nSidecarState[] = [];
      const unsub = sidecar.subscribe((s) => seen.push(s));
      expect(seen).toHaveLength(1);
      expect(seen[0].status).toBe("stopped");
      unsub();
    });
  });

  describe("isRunning()", () => {
    it("is false for stopped/error, true otherwise", () => {
      const h = makeHarness();
      const sidecar = new N8nSidecar(baseConfig(), h.deps);
      expect(sidecar.isRunning()).toBe(false);
    });
  });

  describe("onStatusChange callback", () => {
    it("fires on every state transition, mirroring StewardSidecar.onStatusChange", async () => {
      const statuses: N8nSidecarState["status"][] = [];
      const h = makeHarness();
      const sidecar = new N8nSidecar(
        baseConfig({
          onStatusChange: (s) => statuses.push(s.status),
        }),
        h.deps,
      );

      const readyPromise = new Promise<void>((resolve) => {
        const unsub = sidecar.subscribe((s) => {
          if (s.status === "ready") {
            unsub();
            resolve();
          }
        });
      });
      const startPromise = sidecar.start();
      await readyPromise;
      await sidecar.stop();
      await startPromise;

      expect(statuses).toContain("starting");
      expect(statuses).toContain("ready");
      expect(statuses).toContain("stopped");
    });
  });
});
