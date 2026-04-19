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
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disposeN8nSidecar,
  getN8nSidecar,
  getN8nSidecarAsync,
  N8nSidecar,
  type N8nSidecarConfig,
  type N8nSidecarDeps,
  type N8nSidecarState,
  peekN8nSidecar,
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
  pickPort: (start: number) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
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
  const pickPortFn: Harness["pickPort"] = vi.fn(async (start: number) => start);
  const sleepFn: Harness["sleep"] = vi.fn(async (_ms: number) => undefined);

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
      expect(cmd).toBe("npx");
      // npx syntax: `--yes <pkg> start`. `--yes` auto-confirms the install
      // prompt on first run so we don't hang waiting for stdin.
      expect(args).toEqual(["--yes", "n8n@1.70.0", "start"]);

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
        // Owner setup flow: setup creates the owner and returns an auth cookie.
        if (url.endsWith("/rest/owner/setup") && init?.method === "POST") {
          return new Response(JSON.stringify({ data: { id: "owner-id" } }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": "n8n-auth=fake-jwt; Path=/; HttpOnly",
            },
          });
        }
        // Scopes enumerate what the role can grant.
        if (
          url.endsWith("/rest/api-keys/scopes") &&
          (!init?.method || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({ data: ["workflow:read", "workflow:list"] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // Api-key create returns rawApiKey on the authed path.
        if (url.endsWith("/rest/api-keys") && init?.method === "POST") {
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

  describe("preflightBinary (Bug 7)", () => {
    it("raises a clear error when the spawn binary is missing", async () => {
      const preflightBinary = vi.fn(async () => {
        throw new Error(
          "bunx runtime not found on PATH — required for local n8n. Install from https://bun.sh.",
        );
      });
      const h = makeHarness();
      const sidecar = new N8nSidecar(
        baseConfig({ maxRetries: 0 }),
        { ...h.deps, preflightBinary },
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
      expect(finalState.errorMessage).toMatch(/bun.sh/i);
      expect(h.spawn).not.toHaveBeenCalled();

      await sidecar.stop();
      await startPromise;
    });
  });

  describe("orphan reaping (Bug 2)", () => {
    async function makeStateDir(): Promise<string> {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "milady-n8n-"));
      return dir;
    }

    it("kills a live orphan recorded in the pidfile before spawning", async () => {
      const stateDir = await makeStateDir();
      await fs.writeFile(path.join(stateDir, "pid"), "9999");

      const isProcessAlive = vi.fn((pid: number) => pid === 9999);
      const readProcessCommand = vi.fn(async () => "node n8n/bin/n8n start");
      const killPid = vi.fn((_pid: number, _sig: NodeJS.Signals) => {
        // First kill flips the pid to "dead" on subsequent checks.
        isProcessAlive.mockImplementation(() => false);
      });

      const h = makeHarness();
      const sidecar = new N8nSidecar(
        baseConfig({ stateDir }),
        {
          ...h.deps,
          isProcessAlive,
          readProcessCommand,
          killPid,
        },
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

      expect(readProcessCommand).toHaveBeenCalledWith(9999);
      expect(killPid).toHaveBeenCalledWith(9999, "SIGTERM");
      // Pidfile was rewritten with the new child's pid.
      const written = await fs.readFile(path.join(stateDir, "pid"), "utf-8");
      expect(Number.parseInt(written, 10)).toBeGreaterThan(0);

      await sidecar.stop();
      await startPromise;

      // stop() clears the pidfile.
      await expect(
        fs.readFile(path.join(stateDir, "pid"), "utf-8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await fs.rm(stateDir, { recursive: true, force: true });
    });

    it("does not kill a reused pid whose cmdline is not n8n", async () => {
      const stateDir = await makeStateDir();
      await fs.writeFile(path.join(stateDir, "pid"), "4242");

      const isProcessAlive = vi.fn(() => true);
      const readProcessCommand = vi.fn(async () => "/usr/bin/vim somefile");
      const killPid = vi.fn();

      const h = makeHarness();
      const sidecar = new N8nSidecar(
        baseConfig({ stateDir }),
        {
          ...h.deps,
          isProcessAlive,
          readProcessCommand,
          killPid,
        },
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

      expect(killPid).not.toHaveBeenCalled();

      await sidecar.stop();
      await startPromise;
      await fs.rm(stateDir, { recursive: true, force: true });
    });
  });

  describe("waitForChildExit timeout (Bug 5)", () => {
    it("forces kill + unblocks supervisor when child hangs past the cap", async () => {
      const CHILD_EXIT_TIMEOUT = 2 * 60 * 1_000;
      // Only fire the exit-wait timer (2-minute schedule). Leave the
      // retry-reset timer (5-minute schedule) as a no-op.
      const setTimer = vi.fn((fn: () => void, ms: number) => {
        if (ms === CHILD_EXIT_TIMEOUT) queueMicrotask(fn);
        return { id: ms };
      });
      const clearTimer = vi.fn();

      // Spawn a child whose SIGTERM does not emit exit (simulates a hung
      // child), but whose SIGKILL does. The supervisor's watchdog should
      // escalate to SIGKILL after the timeout fires.
      const spawnFn = vi.fn(() => {
        const child = new EventEmitter() as FakeChild;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.pid = 7777;
        child.killed = false;
        child.kill = (signal?: string) => {
          if (signal === "SIGKILL") {
            child.killed = true;
            queueMicrotask(() => child.emit("exit", 0, signal));
          }
          // Ignore SIGTERM — simulate hung child.
          return true;
        };
        return child as unknown as ReturnType<
          typeof import("node:child_process").spawn
        >;
      });

      const h = makeHarness({ spawn: spawnFn });
      const sidecar = new N8nSidecar(
        baseConfig({ maxRetries: 0, backoffBaseMs: 1 }),
        { ...h.deps, setTimer, clearTimer },
      );

      const terminalPromise = new Promise<N8nSidecarState>((resolve) => {
        const unsub = sidecar.subscribe((s) => {
          if (s.status === "error") {
            unsub();
            resolve(s);
          }
        });
      });
      const startPromise = sidecar.start();
      const finalState = await terminalPromise;

      expect(finalState.status).toBe("error");
      expect(setTimer).toHaveBeenCalled();

      await sidecar.stop();
      await startPromise;
    });
  });

  describe("retry reset (Bug 4)", () => {
    it("resets retries to 0 after sustained healthy uptime", async () => {
      const RETRY_RESET_MS = 5 * 60 * 1_000;
      let retryResetFn: () => void = () => {};
      const setTimer = vi.fn((fn: () => void, ms: number) => {
        // Only capture the retry-reset timer (5-minute schedule); ignore
        // the child-exit timer (2-minute schedule).
        if (ms === RETRY_RESET_MS) retryResetFn = fn;
        return { id: ms };
      });
      const clearTimer = vi.fn();

      const h = makeHarness();
      const sidecar = new N8nSidecar(baseConfig(), {
        ...h.deps,
        setTimer,
        clearTimer,
      });

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

      // Force a non-zero retry count directly via the state (simulate crash
      // recovery), then fire the reset timer.
      (sidecar as unknown as { state: N8nSidecarState }).state.retries = 2;
      expect(sidecar.getState().retries).toBe(2);
      retryResetFn();
      expect(sidecar.getState().retries).toBe(0);

      await sidecar.stop();
      await startPromise;
    });
  });

  describe("API key persistence (Bug 6)", () => {
    it("reuses a cached api key when /rest/api-keys accepts it", async () => {
      const stateDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "milady-n8n-key-"),
      );
      await fs.writeFile(path.join(stateDir, "api-key"), "cached_key_abc");

      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/rest/login")) {
          return new Response(null, { status: 200 });
        }
        if (url.endsWith("/rest/api-keys") && init?.method === "GET") {
          const key = (init.headers as Record<string, string>)["X-N8N-API-KEY"];
          if (key === "cached_key_abc") {
            return new Response(JSON.stringify({ data: [] }), { status: 200 });
          }
          return new Response(null, { status: 401 });
        }
        // Explicit guard: if provisionApiKey were called, fail loudly.
        if (url.endsWith("/rest/me/api-keys")) {
          throw new Error(
            "provisionApiKey should not be called when cache is valid",
          );
        }
        return new Response(null, { status: 404 });
      });

      const h = makeHarness({ fetch: fetchFn });
      const sidecar = new N8nSidecar(baseConfig({ stateDir }), h.deps);

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

      expect(sidecar.getApiKey()).toBe("cached_key_abc");

      await sidecar.stop();
      await startPromise;
      await fs.rm(stateDir, { recursive: true, force: true });
    });

    it("re-provisions and persists a new key when the cached key is rejected", async () => {
      const stateDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "milady-n8n-key-"),
      );
      await fs.writeFile(path.join(stateDir, "api-key"), "stale_key");

      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/rest/login")) {
          // Two callers hit /rest/login: (a) readiness probe (no body, just
          // a status check), (b) provisionApiKey's owner-login fallback. Both
          // are satisfied by returning 200 with a cookie; the provision path
          // also validates the stale key via GET /rest/api-keys first.
          return new Response(null, {
            status: 200,
            headers: { "set-cookie": "n8n-auth=fake-jwt; Path=/; HttpOnly" },
          });
        }
        if (url.endsWith("/rest/api-keys") && init?.method === "GET") {
          return new Response(null, { status: 401 }); // stale cached key rejected
        }
        if (url.endsWith("/rest/owner/setup") && init?.method === "POST") {
          // Owner already exists on restart — setup returns 400. Force login.
          return new Response(
            JSON.stringify({ code: 400, message: "already set up" }),
            { status: 400 },
          );
        }
        if (
          url.endsWith("/rest/api-keys/scopes") &&
          (!init?.method || init.method === "GET")
        ) {
          return new Response(
            JSON.stringify({ data: ["workflow:read", "workflow:list"] }),
            { status: 200 },
          );
        }
        if (url.endsWith("/rest/api-keys") && init?.method === "POST") {
          return new Response(
            JSON.stringify({ data: { rawApiKey: "fresh_key_xyz" } }),
            { status: 200 },
          );
        }
        return new Response(null, { status: 404 });
      });

      const h = makeHarness({ fetch: fetchFn });
      const sidecar = new N8nSidecar(baseConfig({ stateDir }), h.deps);

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

      expect(sidecar.getApiKey()).toBe("fresh_key_xyz");
      const persisted = await fs.readFile(
        path.join(stateDir, "api-key"),
        "utf-8",
      );
      expect(persisted.trim()).toBe("fresh_key_xyz");

      await sidecar.stop();
      await startPromise;
      await fs.rm(stateDir, { recursive: true, force: true });
    });
  });

  describe("updateConfig (Bug 1)", () => {
    it("applies non-respawn fields immediately when idle", () => {
      const h = makeHarness();
      const sidecar = new N8nSidecar(
        baseConfig({ readinessTimeoutMs: 1000 }),
        h.deps,
      );
      sidecar.updateConfig({ readinessTimeoutMs: 5000 });
      // Internal field — exercise via a cast only to assert the merge.
      const cfg = (sidecar as unknown as {
        config: { readinessTimeoutMs: number; startPort: number };
      }).config;
      expect(cfg.readinessTimeoutMs).toBe(5000);
    });

    it("warns and keeps old respawn fields while the sidecar is running", async () => {
      const h = makeHarness();
      const sidecar = new N8nSidecar(baseConfig({ startPort: 5678 }), h.deps);
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

      sidecar.updateConfig({ startPort: 9999, version: "2.0.0" });
      const cfg = (sidecar as unknown as {
        config: { startPort: number; version: string };
      }).config;
      // Live values unchanged until explicit restart.
      expect(cfg.startPort).toBe(5678);
      expect(cfg.version).toBe("1.70.0");

      await sidecar.stop();
      await startPromise;
    });
  });

  describe("singleton accessors (Bug 1 + Bug 3)", () => {
    afterEach(async () => {
      await disposeN8nSidecar();
    });

    it("updateConfig flows through getN8nSidecar on subsequent calls", () => {
      const first = getN8nSidecar({ readinessTimeoutMs: 1000 });
      const second = getN8nSidecar({ readinessTimeoutMs: 8000 });
      expect(first).toBe(second);
      const cfg = (second as unknown as {
        config: { readinessTimeoutMs: number };
      }).config;
      expect(cfg.readinessTimeoutMs).toBe(8000);
    });

    it("disposeN8nSidecar is concurrency-safe: awaits single stop, then clears", async () => {
      const sidecar = getN8nSidecar({ enabled: false });
      let stopResolves: () => void = () => {};
      const stopPromise = new Promise<void>((resolve) => {
        stopResolves = resolve;
      });
      // Monkey-patch stop so we can observe the shared disposal barrier.
      (sidecar as unknown as { stop: () => Promise<void> }).stop = () =>
        stopPromise;

      const d1 = disposeN8nSidecar();
      const d2 = disposeN8nSidecar();
      // Singleton must still be present until stop() resolves, so a
      // peek during disposal still sees the old instance.
      expect(peekN8nSidecar()).toBe(sidecar);
      stopResolves();
      await Promise.all([d1, d2]);
      expect(peekN8nSidecar()).toBeNull();
    });

    it("getN8nSidecarAsync waits for disposal before returning a new instance", async () => {
      const sidecar = getN8nSidecar({ enabled: false });
      let stopResolves: () => void = () => {};
      const stopPromise = new Promise<void>((resolve) => {
        stopResolves = resolve;
      });
      (sidecar as unknown as { stop: () => Promise<void> }).stop = () =>
        stopPromise;

      const disposalPromise = disposeN8nSidecar();
      // Kick off async getter while disposal is in flight.
      const nextPromise = getN8nSidecarAsync({ enabled: false });

      // Without resolving stop, the async getter must still be pending.
      let resolved = false;
      void nextPromise.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(false);

      stopResolves();
      await disposalPromise;
      const next = await nextPromise;
      expect(next).not.toBe(sidecar);
    });
  });
});
