/**
 * Unit coverage for the combined app-core dev-server process entry. The
 * module exports nothing and boots on import, so this suite isolates
 * process.exit plus the API/runtime I/O seams, then imports the real
 * entry and asserts observed bootstrap, restart coalescing, PGlite
 * recovery, shutdown, and rejection-policy behaviour.
 */
import type { AgentRuntime } from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const startApiServer = vi.fn();
const startEliza = vi.fn();
const shutdownRuntime = vi.fn();
const attemptPgliteAutoReset = vi.fn();
const getPgliteRecoveryRetrySkipPlugins = vi.fn();
const startDeferredLocalEmbeddingWarmup = vi.fn();
const applySavedTokenToEnv = vi.fn();
const warnStalePluginDists = vi.fn();
const ensureAuthPairingCodeForRemoteAccess = vi.fn();

vi.mock("../api/server", () => ({
  startApiServer: (...args: unknown[]) => startApiServer(...args),
}));

vi.mock("./eliza", () => ({
  startEliza: (...args: unknown[]) => startEliza(...args),
  shutdownRuntime: (...args: unknown[]) => shutdownRuntime(...args),
  attemptPgliteAutoReset: (...args: unknown[]) =>
    attemptPgliteAutoReset(...args),
  getPgliteRecoveryRetrySkipPlugins: (...args: unknown[]) =>
    getPgliteRecoveryRetrySkipPlugins(...args),
  startDeferredLocalEmbeddingWarmup: (...args: unknown[]) =>
    startDeferredLocalEmbeddingWarmup(...args),
}));

vi.mock("../services/github-credentials.js", () => ({
  applySavedTokenToEnv: (...args: unknown[]) => applySavedTokenToEnv(...args),
}));

vi.mock("./dev-plugin-dist-staleness.js", () => ({
  warnStalePluginDists: (...args: unknown[]) => warnStalePluginDists(...args),
}));

vi.mock("../api/auth-pairing-routes", () => ({
  ensureAuthPairingCodeForRemoteAccess: (...args: unknown[]) =>
    ensureAuthPairingCodeForRemoteAccess(...args),
}));

vi.mock("dotenv", () => ({
  config: () => ({ parsed: {} }),
}));

type ProcessEvent =
  | "SIGINT"
  | "SIGTERM"
  | "unhandledRejection"
  | "uncaughtException";

type Listener = (...args: unknown[]) => unknown;

type ListenerSnapshot = Record<ProcessEvent, Set<Listener>>;

type StartupUpdate = {
  phase?: string;
  attempt?: number;
  lastError?: string;
  lastErrorAt?: number;
  nextRetryAt?: number;
  state?:
    | "not_started"
    | "starting"
    | "running"
    | "paused"
    | "stopped"
    | "restarting"
    | "error";
};

const ENV_KEYS = [
  "ELIZA_API_PROCESS_SPAWNED_AT_MS",
  "ELIZA_PROCESS_SPAWNED_AT_MS",
  "ELIZA_API_PORT",
  "ELIZA_PORT",
  "ELIZA_UI_PORT",
  "ELIZA_API_TOKEN",
  "ELIZA_SKIP_PLUGINS",
  "GITHUB_TOKEN",
  "ELIZA_DEV_HEAP_REPORT",
  "ELIZA_DEV_SHOW_SETTINGS",
  "ELIZA_DEV_VERBOSE_LOGS",
  "ELIZA_DEV_LOG_LEVEL",
  "LOG_LEVEL",
  "ELIZA_SETTINGS_DEBUG",
  "ELIZA_PAIRING_DISABLED",
] as const;

const savedEnv: Record<string, string | undefined> = {};
const exitCodes: number[] = [];
let baseListeners: ListenerSnapshot = snapshotListeners();

function snapshotListeners(): ListenerSnapshot {
  return {
    SIGINT: new Set(process.listeners("SIGINT") as Listener[]),
    SIGTERM: new Set(process.listeners("SIGTERM") as Listener[]),
    unhandledRejection: new Set(
      process.listeners("unhandledRejection") as Listener[],
    ),
    uncaughtException: new Set(
      process.listeners("uncaughtException") as Listener[],
    ),
  };
}

function removeAddedListeners(before: ListenerSnapshot): void {
  for (const event of Object.keys(before) as ProcessEvent[]) {
    for (const listener of process.listeners(event) as Listener[]) {
      if (!before[event].has(listener)) {
        process.removeListener(event, listener);
      }
    }
  }
}

function addedListener(
  event: ProcessEvent,
  before: ListenerSnapshot,
): Listener {
  const added = (process.listeners(event) as Listener[]).filter(
    (listener) => !before[event].has(listener),
  );
  expect(added.length).toBeGreaterThanOrEqual(1);
  const listener = added[added.length - 1];
  if (!listener) {
    throw new Error(`dev-server did not register a ${event} listener`);
  }
  return listener;
}

function makeRuntime(
  character: { name?: string } = { name: "TestAgent" },
): AgentRuntime {
  return { character } as unknown as AgentRuntime;
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function isolateEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.LOG_LEVEL = "info";
  process.env.ELIZA_PAIRING_DISABLED = "1";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function loadDevServer(
  env: Record<string, string | undefined> = {},
): Promise<{
  moduleExports: string[];
  updateRuntime: ReturnType<typeof vi.fn<(rt: AgentRuntime) => void>>;
  updateStartup: ReturnType<typeof vi.fn<(update: StartupUpdate) => void>>;
  logs: string[];
  requestRestart: (reason?: string) => void | Promise<void>;
  info: ReturnType<typeof vi.spyOn>;
  warn: ReturnType<typeof vi.spyOn>;
  error: ReturnType<typeof vi.spyOn>;
}> {
  isolateEnv(env);
  vi.resetModules();

  const updateRuntime = vi.fn<(rt: AgentRuntime) => void>();
  const updateStartup = vi.fn<(update: StartupUpdate) => void>();
  const requestedPort = Number(process.env.ELIZA_API_PORT ?? 31337);
  startApiServer.mockImplementation(
    async (opts: {
      port: number;
      initialAgentState: string;
      onRestart: () => Promise<AgentRuntime | null>;
    }) => ({
      port: opts.port ?? requestedPort,
      updateRuntime,
      updateStartup,
    }),
  );

  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });

  const { logger } = await import("@elizaos/core");
  const info = vi.spyOn(logger, "info");
  const warn = vi.spyOn(logger, "warn");
  const error = vi.spyOn(logger, "error");

  const loaded = await import("./dev-server");
  await vi.waitFor(() => {
    expect(
      logs.some((line) => line.includes("API ready:")) || exitCodes.length > 0,
    ).toBe(true);
  });

  const { requestRestart } = await import("@elizaos/shared/restart");
  return {
    moduleExports: Object.keys(loaded),
    updateRuntime,
    updateStartup,
    logs,
    requestRestart,
    info,
    warn,
    error,
  };
}

async function waitForRuntimeReady(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(startDeferredLocalEmbeddingWarmup).toHaveBeenCalled();
    },
    { timeout: 5000 },
  );
}

beforeEach(() => {
  baseListeners = snapshotListeners();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  exitCodes.length = 0;
  installProcessExitMock();
  startEliza.mockResolvedValue(makeRuntime());
  shutdownRuntime.mockResolvedValue(undefined);
  attemptPgliteAutoReset.mockResolvedValue(null);
  getPgliteRecoveryRetrySkipPlugins.mockReturnValue([]);
  startDeferredLocalEmbeddingWarmup.mockReturnValue(undefined);
  applySavedTokenToEnv.mockResolvedValue({
    applied: false,
    envAlreadySet: false,
  });
  warnStalePluginDists.mockReturnValue({
    stale: [],
    distLoaded: 0,
    sourceLoaded: 0,
  });
  ensureAuthPairingCodeForRemoteAccess.mockReturnValue(null);
});

function installProcessExitMock(): void {
  vi.spyOn(process, "exit").mockImplementation(
    (code?: number | string | null) => {
      exitCodes.push(typeof code === "number" ? code : 0);
      return undefined as never;
    },
  );
}

beforeAll(() => {
  installProcessExitMock();
});

afterAll(() => {
  vi.mocked(process.exit).mockRestore();
});

afterEach(() => {
  const addedSigint = (process.listeners("SIGINT") as Listener[]).filter(
    (listener) => !baseListeners.SIGINT.has(listener),
  );
  for (const handler of addedSigint) {
    handler();
  }
  removeAddedListeners(baseListeners);
  restoreEnv();
  vi.clearAllMocks();
  // Keep process.exit mocked for the whole file — in-flight shutdown() still
  // calls it after this hook, and Vitest treats an unmocked exit as a failure.
  installProcessExitMock();
});

describe.sequential("dev-server process entry", () => {
  it("exports nothing — the file is a process entry, not a library", async () => {
    const loaded = await loadDevServer();
    expect(loaded.moduleExports).toEqual([]);
  });

  it("anchors startup timing to the first finite positive spawn-env timestamp", async () => {
    const spawnedAt = Date.now() - 40;
    const loaded = await loadDevServer({
      ELIZA_API_PROCESS_SPAWNED_AT_MS: String(spawnedAt),
      ELIZA_PROCESS_SPAWNED_AT_MS: String(spawnedAt - 1000),
    });
    expect(
      loaded.logs.some((line) =>
        line.includes("child-spawn env ELIZA_API_PROCESS_SPAWNED_AT_MS"),
      ),
    ).toBe(true);
  });

  it("skips empty, zero, negative, and NaN timestamps and uses the second env key", async () => {
    const spawnedAt = Date.now() - 25;
    const loaded = await loadDevServer({
      ELIZA_API_PROCESS_SPAWNED_AT_MS: "0",
      ELIZA_PROCESS_SPAWNED_AT_MS: String(spawnedAt),
    });
    expect(
      loaded.logs.some((line) =>
        line.includes("child-spawn env ELIZA_PROCESS_SPAWNED_AT_MS"),
      ),
    ).toBe(true);
  });

  it("falls back to the module-body timestamp when every spawn-env value is invalid", async () => {
    const loaded = await loadDevServer({
      ELIZA_API_PROCESS_SPAWNED_AT_MS: "abc",
      ELIZA_PROCESS_SPAWNED_AT_MS: "",
    });
    expect(
      loaded.logs.some((line) => line.includes("module-body timestamp")),
    ).toBe(true);
    expect(
      loaded.logs.some((line) =>
        line.includes("pre-body/import delay: unavailable"),
      ),
    ).toBe(true);
  });

  it("binds the API first with initialAgentState starting at the resolved desktop port", async () => {
    await loadDevServer({ ELIZA_API_PORT: "32123" });
    expect(startApiServer).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 32123,
        initialAgentState: "starting",
      }),
    );
    const opts = startApiServer.mock.calls[0]?.[0] as {
      onRestart: () => Promise<unknown>;
    };
    expect(typeof opts.onRestart).toBe("function");
  });

  it("logs a critical error when the bound port does not match the orchestrator port", async () => {
    startApiServer.mockImplementationOnce(async () => ({
      port: 9999,
      updateRuntime: vi.fn(),
      updateStartup: vi.fn(),
    }));
    const loaded = await loadDevServer({ ELIZA_API_PORT: "31337" });
    expect(loaded.error).toHaveBeenCalledWith(
      expect.stringContaining("[CRITICAL] API bound to port 9999"),
    );
  });

  it("syncs the bound port into ELIZA_API_PORT without inventing a UI port overwrite", async () => {
    await loadDevServer({ ELIZA_API_PORT: "32124" });
    expect(process.env.ELIZA_API_PORT).toBe("32124");
    expect(process.env.ELIZA_UI_PORT).toBeUndefined();
  });

  it("masks the connection key to the last four characters when a token is set", async () => {
    const token = "secret-token-zx9k";
    const loaded = await loadDevServer({
      ELIZA_API_TOKEN: token,
    });
    const keyLines = loaded.logs.filter((line) =>
      line.includes("Connection key:"),
    );
    expect(keyLines.length).toBeGreaterThan(0);
    expect(keyLines.some((line) => line.includes(token))).toBe(false);
    expect(keyLines.some((line) => line.includes(token.slice(-4)))).toBe(true);
    expect(keyLines.some((line) => line.includes("*"))).toBe(true);
  });

  it("prints the pairing code only when the pairing helper returns one", async () => {
    ensureAuthPairingCodeForRemoteAccess.mockReturnValue({
      code: "ABCD-EFGH-IJKL",
      expiresAt: Date.now() + 60_000,
    });
    const withCode = await loadDevServer();
    expect(
      withCode.logs.some((line) =>
        line.includes("Pairing code: ABCD-EFGH-IJKL"),
      ),
    ).toBe(true);

    ensureAuthPairingCodeForRemoteAccess.mockReturnValue(null);
    const withoutCode = await loadDevServer();
    expect(
      withoutCode.logs.some((line) => line.includes("Pairing code:")),
    ).toBe(false);
  });

  it("creates a headless runtime, hot-swaps it into the API, and marks startup running", async () => {
    const runtime = makeRuntime({ name: "Booted" });
    startEliza.mockResolvedValue(runtime);
    const loaded = await loadDevServer();
    await waitForRuntimeReady();

    expect(startEliza).toHaveBeenCalledWith({ headless: true });
    expect(loaded.updateRuntime).toHaveBeenCalledWith(runtime);
    expect(loaded.updateStartup).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "api-ready",
        state: "starting",
        attempt: 0,
      }),
    );
    expect(loaded.updateStartup).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "running",
        state: "running",
        attempt: 0,
      }),
    );
    expect(loaded.info).toHaveBeenCalledWith(
      expect.stringContaining("Runtime ready — agent: Booted"),
    );
  });

  it("defaults a missing character name to Eliza and keeps an empty name as empty", async () => {
    startEliza.mockResolvedValue(makeRuntime({}));
    const missing = await loadDevServer();
    await waitForRuntimeReady();
    expect(missing.info).toHaveBeenCalledWith(
      expect.stringContaining("Runtime ready — agent: Eliza"),
    );

    startDeferredLocalEmbeddingWarmup.mockClear();
    startEliza.mockResolvedValue(makeRuntime({ name: "" }));
    const empty = await loadDevServer();
    await waitForRuntimeReady();
    expect(empty.info).toHaveBeenCalledWith(
      expect.stringContaining("Runtime ready — agent:  (total:"),
    );
  });

  it("retries when startEliza returns null, then boots the next successful runtime", async () => {
    const recovered = makeRuntime({ name: "RetryWin" });
    startEliza.mockResolvedValueOnce(null).mockResolvedValueOnce(recovered);
    const loaded = await loadDevServer();
    await vi.waitFor(
      () => {
        expect(startEliza).toHaveBeenCalledTimes(2);
      },
      { timeout: 4000 },
    );
    await waitForRuntimeReady();
    expect(loaded.updateRuntime).toHaveBeenCalledWith(recovered);
    expect(loaded.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "startEliza returned null — runtime failed to initialize",
      ),
    );
  });

  it("halts retries on a fatal PGlite error code after auto-reset declines", async () => {
    const fatal = Object.assign(new Error("pglite corrupt"), {
      code: "ELIZA_PGLITE_CORRUPT_DATA",
    });
    startEliza.mockRejectedValue(fatal);
    attemptPgliteAutoReset.mockResolvedValue(null);
    const loaded = await loadDevServer();
    await vi.waitFor(() => {
      expect(loaded.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "Startup halted until the PGlite issue is fixed",
        ),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(startEliza).toHaveBeenCalledTimes(1);
  });

  it("quarantines corrupt PGlite data once, unions skip-plugins for the retry, then restores the operator list", async () => {
    const recovered = makeRuntime({ name: "AfterReset" });
    attemptPgliteAutoReset.mockResolvedValue("/tmp/elizadb-backup");
    getPgliteRecoveryRetrySkipPlugins.mockReturnValue(["plugin-sql"]);

    let startElizaCalls = 0;
    let skipPluginsDuringRetry: string | undefined;
    startEliza.mockImplementation(async () => {
      startElizaCalls += 1;
      if (startElizaCalls === 1) {
        throw new Error("corrupt db");
      }
      skipPluginsDuringRetry = process.env.ELIZA_SKIP_PLUGINS;
      return recovered;
    });

    const loaded = await loadDevServer({
      ELIZA_SKIP_PLUGINS: "plugin-browser",
    });
    await waitForRuntimeReady();

    expect(skipPluginsDuringRetry).toBe("plugin-browser,plugin-sql");
    expect(process.env.ELIZA_SKIP_PLUGINS).toBe("plugin-browser");
    expect(loaded.warn).toHaveBeenCalledWith(
      expect.stringContaining("Quarantined corrupt PGlite data dir"),
    );
    expect(loaded.updateRuntime).toHaveBeenCalledWith(recovered);
  });

  it("continues bootstrap when applying a saved GitHub token throws", async () => {
    applySavedTokenToEnv.mockRejectedValue(new Error("credential store down"));
    const loaded = await loadDevServer();
    await waitForRuntimeReady();
    expect(loaded.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to apply saved GitHub token (runtime continues without it)",
      ),
    );
    expect(startEliza).toHaveBeenCalled();
  });

  it("logs whether a saved GitHub token was applied or left untouched", async () => {
    applySavedTokenToEnv.mockResolvedValue({
      applied: true,
      envAlreadySet: false,
      username: "octocat",
    });
    const applied = await loadDevServer();
    await waitForRuntimeReady();
    expect(applied.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "Applied saved GitHub token to runtime env (user=@octocat)",
      ),
    );

    startDeferredLocalEmbeddingWarmup.mockClear();
    applySavedTokenToEnv.mockResolvedValue({
      applied: false,
      envAlreadySet: true,
    });
    const existing = await loadDevServer();
    await waitForRuntimeReady();
    expect(existing.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "GITHUB_TOKEN already set in env — leaving untouched",
      ),
    );
  });

  it("coalesces concurrent restarts onto one in-flight promise and shuts down the previous runtime", async () => {
    const first = makeRuntime({ name: "First" });
    const second = makeRuntime({ name: "Second" });
    let startElizaCalls = 0;
    let releaseRestart: ((runtime: AgentRuntime) => void) | undefined;
    startEliza.mockImplementation(() => {
      startElizaCalls += 1;
      if (startElizaCalls === 1) {
        return Promise.resolve(first);
      }
      if (startElizaCalls === 2) {
        return new Promise<AgentRuntime>((resolve) => {
          releaseRestart = resolve;
        });
      }
      return Promise.resolve(second);
    });
    const loaded = await loadDevServer();
    await waitForRuntimeReady();
    expect(startElizaCalls).toBe(1);

    const pending = loaded.requestRestart("one");
    await vi.waitFor(() => {
      expect(startElizaCalls).toBe(2);
      expect(releaseRestart).toBeTypeOf("function");
    });
    const coalesced = loaded.requestRestart("two");
    // handleRestart is `async`, so each caller gets a distinct outer
    // promise; the in-flight restartPromise is what is shared.
    expect(loaded.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "Restart already in progress, awaiting existing restart",
      ),
    );
    expect(startElizaCalls).toBe(2);

    if (!releaseRestart) {
      throw new Error("restart did not reach startEliza");
    }
    releaseRestart(second);
    await pending;
    await coalesced;
    expect(startElizaCalls).toBe(2);

    expect(shutdownRuntime).toHaveBeenCalledWith(
      first,
      "dev-server createRuntime",
    );
    expect(loaded.updateRuntime).toHaveBeenCalledWith(second);
    expect(loaded.info).toHaveBeenCalledWith(
      expect.stringContaining("Runtime restarted — agent: Second"),
    );
  });

  it("rejects a restart requested while runtime bootstrap is still in progress", async () => {
    let releaseBoot: ((runtime: AgentRuntime) => void) | undefined;
    startEliza.mockImplementation(
      () =>
        new Promise<AgentRuntime>((resolve) => {
          releaseBoot = resolve;
        }),
    );
    const loaded = await loadDevServer();
    await vi.waitFor(() => {
      expect(startEliza).toHaveBeenCalled();
    });
    await expect(loaded.requestRestart("api")).rejects.toThrow(
      "Restart requested while runtime bootstrap is in progress. Please wait for startup to complete.",
    );
    if (!releaseBoot) {
      throw new Error("bootstrap did not reach startEliza");
    }
    releaseBoot(makeRuntime());
    await waitForRuntimeReady();
  });

  it("returns the live runtime from the API onRestart callback after a bounce", async () => {
    const original = makeRuntime({ name: "Original" });
    const restarted = makeRuntime({ name: "FromApi" });
    startEliza.mockResolvedValueOnce(original);
    const loaded = await loadDevServer();
    await waitForRuntimeReady();

    startEliza.mockResolvedValueOnce(restarted);
    const opts = startApiServer.mock.calls[0]?.[0] as {
      onRestart: () => Promise<AgentRuntime | null>;
    };
    const returned = await opts.onRestart();
    expect(returned).toBe(restarted);
    expect(loaded.updateRuntime).toHaveBeenCalledWith(restarted);
  });

  it("rejects restart after shutdown and exits 0 once even if SIGINT fires twice", async () => {
    const runtime = makeRuntime({ name: "Live" });
    startEliza.mockResolvedValue(runtime);
    const loaded = await loadDevServer();
    await waitForRuntimeReady();

    const sigint = addedListener("SIGINT", baseListeners);
    const first = sigint();
    const second = sigint();
    await first;
    await second;

    expect(exitCodes).toEqual([0]);
    expect(shutdownRuntime).toHaveBeenCalledWith(
      runtime,
      "dev-server shutdown",
    );
    await expect(loaded.requestRestart("late")).rejects.toThrow(
      "Restart skipped — process is shutting down",
    );
  });

  it("registers SIGTERM as well as SIGINT for graceful shutdown", async () => {
    await loadDevServer();
    expect(addedListener("SIGTERM", baseListeners)).toBeTypeOf("function");
    expect(addedListener("SIGINT", baseListeners)).toBeTypeOf("function");
  });

  it("tears down a runtime that wins the shutdown race during bootstrap", async () => {
    const raced = makeRuntime({ name: "Raced" });
    let releaseBoot: ((runtime: AgentRuntime) => void) | undefined;
    startEliza.mockImplementation(
      () =>
        new Promise<AgentRuntime>((resolve) => {
          releaseBoot = resolve;
        }),
    );
    const loaded = await loadDevServer();
    await vi.waitFor(() => {
      expect(startEliza).toHaveBeenCalled();
    });

    const sigint = addedListener("SIGINT", baseListeners);
    const shuttingDown = sigint();
    if (!releaseBoot) {
      throw new Error("bootstrap did not reach startEliza");
    }
    releaseBoot(raced);
    await shuttingDown;
    await vi.waitFor(() => {
      expect(shutdownRuntime).toHaveBeenCalledWith(
        raced,
        "dev-server shutdown race",
      );
    });
    expect(loaded.updateRuntime).not.toHaveBeenCalled();
    expect(startDeferredLocalEmbeddingWarmup).not.toHaveBeenCalled();
  });

  it("warns on provider credit rejections and errors on any other unhandled rejection", async () => {
    const loaded = await loadDevServer();
    const onRejection = addedListener("unhandledRejection", baseListeners);

    onRejection(
      Object.assign(new Error("AI_APICallError: insufficient_quota"), {
        statusCode: 402,
      }),
    );
    expect(loaded.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Provider credits appear exhausted; request failed without output",
      ),
    );

    onRejection(new Error("socket hang up"));
    expect(loaded.error).toHaveBeenCalledWith(
      expect.stringContaining("Unhandled rejection:"),
    );
    expect(exitCodes).toEqual([]);
  });

  it("exits 1 on an uncaught exception", async () => {
    await loadDevServer();
    const onException = addedListener("uncaughtException", baseListeners);
    onException(new Error("native explode"));
    expect(exitCodes).toEqual([1]);
  });

  it("exits 1 from main() when the API server fails to bind, including the cause chain", async () => {
    const failure = new Error("bind failed");
    failure.cause = new Error("EADDRINUSE");
    startApiServer.mockRejectedValueOnce(failure);
    await loadDevServer();
    await vi.waitFor(() => {
      expect(exitCodes).toContain(1);
    });
    expect(exitCodes).toEqual([1]);
  });

  it("does not fail startup when the optional plugin-dist staleness sweep throws", async () => {
    warnStalePluginDists.mockImplementation(() => {
      throw new Error("plugins directory unreadable");
    });
    const loaded = await loadDevServer();
    await waitForRuntimeReady();
    await new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });
    expect(loaded.warn).toHaveBeenCalledWith(
      expect.stringContaining("Plugin dist staleness check unavailable"),
    );
    expect(exitCodes).toEqual([]);
  });
});
