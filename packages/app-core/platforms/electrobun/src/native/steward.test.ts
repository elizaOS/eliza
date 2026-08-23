/**
 * Exercises Electrobun Steward native lifecycle against a deterministic sidecar
 * collaborator. Sidecar spawn stays faked; start, stop, restart, reset, status,
 * env configuration, listener dispatch, and data-dir safety are the real module.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StewardStatus = {
  state: "stopped" | "starting" | "running" | "error" | "restarting";
  port: number | null;
  pid: number | null;
  error: string | null;
  restartCount: number;
  walletAddress: string | null;
  agentId: string | null;
  tenantId: string | null;
  startedAt: number | null;
};

type StewardCredentials = {
  agentToken?: string;
  tenantApiKey?: string;
  tenantId?: string;
  agentId?: string;
  walletAddress?: string;
};

type SavedCredentials = {
  apiUrl: string;
  tenantId: string | undefined;
  agentId: string | undefined;
  apiKey: string | undefined;
  agentToken: string | undefined;
  walletAddresses: { evm: string | undefined };
  agentName: string | undefined;
};

const STOPPED_STATUS: StewardStatus = {
  state: "stopped",
  port: null,
  pid: null,
  error: null,
  restartCount: 0,
  walletAddress: null,
  agentId: null,
  tenantId: null,
  startedAt: null,
};

const FULL_CREDENTIALS: Required<StewardCredentials> = {
  agentToken: "agent-token",
  tenantApiKey: "tenant-api-key",
  tenantId: "tenant-1",
  agentId: "agent-1",
  walletAddress: "0xabc",
};

const ENV_KEYS = [
  "STEWARD_LOCAL",
  "STEWARD_API_URL",
  "STEWARD_AGENT_TOKEN",
  "STEWARD_API_KEY",
  "STEWARD_TENANT_ID",
  "STEWARD_AGENT_ID",
  "STEWARD_DATA_DIR",
  "HOME",
  "USERPROFILE",
  "NODE_ENV",
] as const;

const harness = vi.hoisted(() => {
  const stopped = (): StewardStatus => ({
    state: "stopped",
    port: null,
    pid: null,
    error: null,
    restartCount: 0,
    walletAddress: null,
    agentId: null,
    tenantId: null,
    startedAt: null,
  });

  const state = {
    status: stopped(),
    credentials: null as StewardCredentials | null,
    apiBase: "http://127.0.0.1:3200",
    port: 3200 as number | null,
    startFailure: undefined as unknown,
    stopFailure: undefined as unknown,
    restartFailure: undefined as unknown,
    saveFailure: undefined as unknown,
    startCount: 0,
    stopCount: 0,
    restartCount: 0,
    saveCalls: [] as SavedCredentials[],
    onStatusChange: null as ((status: StewardStatus) => void) | null,
    onLog: null as ((line: string, stream: "stdout" | "stderr") => void) | null,
  };

  const sidecar = {
    getStatus: (): StewardStatus => ({ ...state.status }),
    getCredentials: (): StewardCredentials | null => state.credentials,
    getApiBase: (): string => state.apiBase,
    start: async (): Promise<StewardStatus> => {
      state.startCount += 1;
      if (state.startFailure !== undefined) {
        const failure = state.startFailure;
        state.status = {
          ...stopped(),
          state: "error",
          error: failure instanceof Error ? failure.message : String(failure),
        };
        throw failure;
      }
      state.status = {
        ...state.status,
        state: "running",
        port: state.port,
        pid: 4242,
        error: null,
        walletAddress: state.credentials?.walletAddress ?? null,
        agentId: state.credentials?.agentId ?? null,
        tenantId: state.credentials?.tenantId ?? null,
        startedAt: 1_700_000_000_000,
      };
      state.onStatusChange?.({ ...state.status });
      return { ...state.status };
    },
    stop: async (): Promise<void> => {
      state.stopCount += 1;
      if (state.stopFailure !== undefined) {
        throw state.stopFailure;
      }
      state.status = stopped();
    },
    restart: async (): Promise<StewardStatus> => {
      state.restartCount += 1;
      if (state.restartFailure !== undefined) {
        throw state.restartFailure;
      }
      state.status = {
        ...state.status,
        state: "running",
        port: state.port,
        pid: 4243,
        error: null,
        restartCount: state.status.restartCount + 1,
        walletAddress: state.credentials?.walletAddress ?? null,
        agentId: state.credentials?.agentId ?? null,
        tenantId: state.credentials?.tenantId ?? null,
        startedAt: 1_700_000_000_100,
      };
      state.onStatusChange?.({ ...state.status });
      return { ...state.status };
    },
  };

  const createDesktopStewardSidecar = vi.fn(
    (opts: {
      onStatusChange?: (status: StewardStatus) => void;
      onLog?: (line: string, stream: "stdout" | "stderr") => void;
    }) => {
      state.onStatusChange = opts.onStatusChange ?? null;
      state.onLog = opts.onLog ?? null;
      return sidecar;
    },
  );

  const saveStewardCredentials = vi.fn(async (payload: SavedCredentials) => {
    if (state.saveFailure !== undefined) {
      throw state.saveFailure;
    }
    state.saveCalls.push(payload);
  });

  function reset(): void {
    state.status = stopped();
    state.credentials = null;
    state.apiBase = "http://127.0.0.1:3200";
    state.port = 3200;
    state.startFailure = undefined;
    state.stopFailure = undefined;
    state.restartFailure = undefined;
    state.saveFailure = undefined;
    state.startCount = 0;
    state.stopCount = 0;
    state.restartCount = 0;
    state.saveCalls = [];
    state.onStatusChange = null;
    state.onLog = null;
    createDesktopStewardSidecar.mockClear();
    saveStewardCredentials.mockClear();
  }

  return {
    state,
    sidecar,
    createDesktopStewardSidecar,
    saveStewardCredentials,
    reset,
  };
});

vi.mock("@elizaos/app-core", () => ({
  createDesktopStewardSidecar: harness.createDesktopStewardSidecar,
  saveStewardCredentials: harness.saveStewardCredentials,
}));

vi.mock("../brand-config", () => ({
  getBrandConfig: vi.fn(() => ({ namespace: "eliza" })),
}));

vi.mock("../logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

import { logger } from "../logger";

const tempDirs: string[] = [];
let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

function snapshotEnv(): void {
  envSnapshot = {};
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-steward-native-"));
  tempDirs.push(dir);
  return dir;
}

async function loadSteward() {
  return import("./steward");
}

beforeEach(() => {
  snapshotEnv();
  harness.reset();
  vi.clearAllMocks();
  vi.resetModules();
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  restoreEnv();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("isStewardLocalEnabled", () => {
  it("is true only when STEWARD_LOCAL is the exact string true", async () => {
    const { isStewardLocalEnabled } = await loadSteward();
    delete process.env.STEWARD_LOCAL;
    expect(isStewardLocalEnabled()).toBe(false);

    process.env.STEWARD_LOCAL = "true";
    expect(isStewardLocalEnabled()).toBe(true);
  });

  it.each(["", "1", "TRUE", "true ", "yes", "false"] as const)(
    "is false for %j",
    async (value) => {
      const { isStewardLocalEnabled } = await loadSteward();
      process.env.STEWARD_LOCAL = value;
      expect(isStewardLocalEnabled()).toBe(false);
    },
  );
});

describe("getStewardStatus and getStewardApiBase without a sidecar", () => {
  it("reports the stopped default status when nothing has been created", async () => {
    const { getStewardStatus } = await loadSteward();
    expect(getStewardStatus()).toEqual(STOPPED_STATUS);
    expect(harness.createDesktopStewardSidecar).not.toHaveBeenCalled();
  });

  it("returns null for the API base when the sidecar has not been created", async () => {
    const { getStewardApiBase } = await loadSteward();
    expect(getStewardApiBase()).toBeNull();
  });
});

describe("getStewardSidecar", () => {
  it("creates one sidecar and reuses it", async () => {
    const { getStewardSidecar } = await loadSteward();
    const first = await getStewardSidecar();
    const second = await getStewardSidecar();
    expect(first).toBe(harness.sidecar);
    expect(second).toBe(first);
    expect(harness.createDesktopStewardSidecar).toHaveBeenCalledTimes(1);
  });

  it("forwards status updates to sendToWebview even when registered after create", async () => {
    const { getStewardSidecar, setStewardSendToWebview } = await loadSteward();
    await getStewardSidecar();
    const webview: Array<{ message: string; payload: unknown }> = [];
    setStewardSendToWebview((message, payload) => {
      webview.push({ message, payload });
    });

    const update: StewardStatus = {
      ...STOPPED_STATUS,
      state: "running",
      port: 3200,
      pid: 9,
    };
    harness.state.onStatusChange?.(update);

    expect(webview).toEqual([
      { message: "stewardStatusUpdate", payload: update },
    ]);
  });

  it("does not throw when sendToWebview is unset during a status change", async () => {
    const { getStewardSidecar } = await loadSteward();
    await getStewardSidecar();
    expect(() =>
      harness.state.onStatusChange?.({
        ...STOPPED_STATUS,
        state: "starting",
      }),
    ).not.toThrow();
  });
});

describe("onStewardStatusChange", () => {
  it("invokes listeners and honors unsubscribe by function identity", async () => {
    const { getStewardSidecar, onStewardStatusChange } = await loadSteward();
    await getStewardSidecar();
    const seenA: StewardStatus[] = [];
    const seenB: StewardStatus[] = [];
    const listenerA = (status: StewardStatus) => {
      seenA.push(status);
    };
    const unsubscribeA = onStewardStatusChange(listenerA);
    onStewardStatusChange((status) => {
      seenB.push(status);
    });

    const first: StewardStatus = { ...STOPPED_STATUS, state: "starting" };
    harness.state.onStatusChange?.(first);
    unsubscribeA();
    const second: StewardStatus = { ...STOPPED_STATUS, state: "running" };
    harness.state.onStatusChange?.(second);

    expect(seenA).toEqual([first]);
    expect(seenB).toEqual([first, second]);
  });

  it("warns when a listener throws and still calls the remaining listeners", async () => {
    const { getStewardSidecar, onStewardStatusChange } = await loadSteward();
    await getStewardSidecar();
    const surviving: StewardStatus[] = [];
    onStewardStatusChange(() => {
      throw new Error("listener boom");
    });
    onStewardStatusChange(() => {
      throw "plain-string";
    });
    onStewardStatusChange((status) => {
      surviving.push(status);
    });

    const update: StewardStatus = { ...STOPPED_STATUS, state: "error" };
    harness.state.onStatusChange?.(update);

    expect(surviving).toEqual([update]);
    expect(logger.warn).toHaveBeenCalledWith(
      "[Steward] Status listener error: listener boom",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "[Steward] Status listener error: plain-string",
    );
  });

  it("removes every registration of the same callback on unsubscribe", async () => {
    const { getStewardSidecar, onStewardStatusChange } = await loadSteward();
    await getStewardSidecar();
    const seen: number[] = [];
    const callback = () => {
      seen.push(1);
    };
    const unsubscribe = onStewardStatusChange(callback);
    onStewardStatusChange(callback);
    unsubscribe();
    harness.state.onStatusChange?.({ ...STOPPED_STATUS, state: "running" });
    expect(seen).toEqual([]);
  });
});

describe("sidecar log forwarding", () => {
  it("forwards stderr in production and stdout only outside production", async () => {
    const { getStewardSidecar } = await loadSteward();
    await getStewardSidecar();
    const onLog = harness.state.onLog;
    expect(onLog).toEqual(expect.any(Function));

    process.env.NODE_ENV = "production";
    onLog?.("err-line", "stderr");
    onLog?.("out-line", "stdout");
    expect(consoleLogSpy).toHaveBeenCalledWith("[Steward:err] err-line");
    expect(consoleLogSpy).not.toHaveBeenCalledWith("[Steward] out-line");

    consoleLogSpy.mockClear();
    process.env.NODE_ENV = "development";
    onLog?.("dev-out", "stdout");
    expect(consoleLogSpy).toHaveBeenCalledWith("[Steward] dev-out");
  });
});

describe("getStewardApiBase with a sidecar", () => {
  it("returns null unless the sidecar is running with a truthy port", async () => {
    const { getStewardSidecar, getStewardApiBase } = await loadSteward();
    await getStewardSidecar();

    harness.state.status = {
      ...STOPPED_STATUS,
      state: "starting",
      port: 3200,
    };
    expect(getStewardApiBase()).toBeNull();

    harness.state.status = {
      ...STOPPED_STATUS,
      state: "running",
      port: null,
    };
    expect(getStewardApiBase()).toBeNull();

    harness.state.status = {
      ...STOPPED_STATUS,
      state: "running",
      port: 0,
    };
    expect(getStewardApiBase()).toBeNull();

    harness.state.status = {
      ...STOPPED_STATUS,
      state: "running",
      port: 3200,
    };
    harness.state.apiBase = "http://127.0.0.1:3200";
    expect(getStewardApiBase()).toBe("http://127.0.0.1:3200");
  });

  it("delegates to the sidecar API base when running", async () => {
    const { getStewardSidecar, getStewardApiBase } = await loadSteward();
    await getStewardSidecar();
    harness.state.status = {
      ...STOPPED_STATUS,
      state: "running",
      port: 3300,
    };
    harness.state.apiBase = "http://127.0.0.1:3300";
    expect(getStewardApiBase()).toBe("http://127.0.0.1:3300");
  });
});

describe("startSteward", () => {
  it("skips start when the sidecar is already running", async () => {
    const { getStewardSidecar, setStewardSendToWebview, startSteward } =
      await loadSteward();
    await getStewardSidecar();
    harness.state.status = {
      ...STOPPED_STATUS,
      state: "running",
      port: 3200,
      pid: 77,
      walletAddress: "0xlive",
    };
    const webview: string[] = [];
    setStewardSendToWebview((message) => {
      webview.push(message);
    });

    const status = await startSteward();
    expect(status).toEqual(harness.state.status);
    expect(harness.state.startCount).toBe(0);
    expect(webview).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      "[Steward] Already running, skipping start",
    );
  });

  it("pushes starting, starts the sidecar, and configures env from credentials", async () => {
    const { setStewardSendToWebview, startSteward } = await loadSteward();
    harness.state.credentials = FULL_CREDENTIALS;
    const webview: Array<{ message: string; payload: unknown }> = [];
    setStewardSendToWebview((message, payload) => {
      webview.push({ message, payload });
    });

    const status = await startSteward();

    expect(status.state).toBe("running");
    expect(status.port).toBe(3200);
    expect(status.walletAddress).toBe("0xabc");
    expect(harness.state.startCount).toBe(1);
    expect(webview[0]).toEqual({
      message: "stewardStatusUpdate",
      payload: {
        state: "starting",
        port: null,
        pid: null,
        error: null,
        restartCount: 0,
        walletAddress: null,
        agentId: null,
        tenantId: null,
        startedAt: null,
      },
    });
    expect(process.env.STEWARD_API_URL).toBe("http://127.0.0.1:3200");
    expect(process.env.STEWARD_AGENT_TOKEN).toBe("agent-token");
    expect(process.env.STEWARD_API_KEY).toBe("tenant-api-key");
    expect(process.env.STEWARD_TENANT_ID).toBe("tenant-1");
    expect(process.env.STEWARD_AGENT_ID).toBe("agent-1");
    expect(harness.state.saveCalls).toEqual([
      {
        apiUrl: "http://127.0.0.1:3200",
        tenantId: "tenant-1",
        agentId: "agent-1",
        apiKey: "tenant-api-key",
        agentToken: "agent-token",
        walletAddresses: { evm: "0xabc" },
        agentName: "agent-1",
      },
    ]);
  });

  it("sets STEWARD_API_URL and warns when credentials are not ready", async () => {
    const { startSteward } = await loadSteward();
    harness.state.credentials = null;
    const status = await startSteward();
    expect(status.state).toBe("running");
    expect(process.env.STEWARD_API_URL).toBe("http://127.0.0.1:3200");
    expect(process.env.STEWARD_AGENT_TOKEN).toBeUndefined();
    expect(harness.state.saveCalls).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "[Steward] Sidecar running but no credentials available yet",
    );
  });

  it("skips falsy credential fields instead of writing empty env values", async () => {
    const { startSteward } = await loadSteward();
    harness.state.credentials = {
      agentToken: "",
      tenantApiKey: "",
      tenantId: "",
      agentId: "",
      walletAddress: "",
    };
    await startSteward();
    expect(process.env.STEWARD_API_URL).toBe("http://127.0.0.1:3200");
    expect(process.env.STEWARD_AGENT_TOKEN).toBeUndefined();
    expect(process.env.STEWARD_API_KEY).toBeUndefined();
    expect(process.env.STEWARD_TENANT_ID).toBeUndefined();
    expect(process.env.STEWARD_AGENT_ID).toBeUndefined();
    expect(harness.state.saveCalls[0]).toEqual({
      apiUrl: "http://127.0.0.1:3200",
      tenantId: "",
      agentId: "",
      apiKey: "",
      agentToken: "",
      walletAddresses: { evm: "" },
      agentName: "",
    });
  });

  it("keeps env configuration when credential persistence throws", async () => {
    const { startSteward } = await loadSteward();
    harness.state.credentials = FULL_CREDENTIALS;
    harness.state.saveFailure = new Error("disk full");
    const status = await startSteward();
    expect(status.state).toBe("running");
    expect(process.env.STEWARD_AGENT_TOKEN).toBe("agent-token");
    expect(logger.warn).toHaveBeenCalledWith(
      "[Steward] Failed to persist credentials: disk full",
    );
  });

  it("stringifies a non-Error persist failure", async () => {
    const { startSteward } = await loadSteward();
    harness.state.credentials = FULL_CREDENTIALS;
    harness.state.saveFailure = "persist-denied";
    await startSteward();
    expect(logger.warn).toHaveBeenCalledWith(
      "[Steward] Failed to persist credentials: persist-denied",
    );
  });

  it("returns the sidecar error status when start throws an Error", async () => {
    const { startSteward } = await loadSteward();
    harness.state.startFailure = new Error("bind failed");
    const status = await startSteward();
    expect(status).toEqual({
      ...STOPPED_STATUS,
      state: "error",
      error: "bind failed",
    });
    expect(logger.error).toHaveBeenCalledWith(
      "[Steward] Failed to start:",
      "bind failed",
    );
    expect(harness.state.saveCalls).toEqual([]);
  });

  it("returns getStatus when start throws a non-Error", async () => {
    const { startSteward } = await loadSteward();
    harness.state.startFailure = "spawn-denied";
    const status = await startSteward();
    expect(status.state).toBe("error");
    expect(status.error).toBe("spawn-denied");
    expect(logger.error).toHaveBeenCalledWith(
      "[Steward] Failed to start:",
      "spawn-denied",
    );
  });

  it("logs none when start succeeds without a wallet address", async () => {
    const { startSteward } = await loadSteward();
    harness.state.credentials = null;
    const status = await startSteward();
    expect(status.walletAddress).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      "[Steward] Running on port 3200, wallet: none",
    );
  });
});

describe("stopSteward", () => {
  it("is a no-op when the sidecar was never created", async () => {
    const { stopSteward } = await loadSteward();
    await expect(stopSteward()).resolves.toBeUndefined();
    expect(harness.state.stopCount).toBe(0);
  });

  it("stops the created sidecar", async () => {
    const { getStewardSidecar, stopSteward } = await loadSteward();
    await getStewardSidecar();
    harness.state.status = { ...STOPPED_STATUS, state: "running", port: 3200 };
    await stopSteward();
    expect(harness.state.stopCount).toBe(1);
    expect(harness.state.status.state).toBe("stopped");
  });
});

describe("restartSteward", () => {
  it("starts a sidecar when none exists", async () => {
    const { restartSteward } = await loadSteward();
    harness.state.credentials = FULL_CREDENTIALS;
    const status = await restartSteward();
    expect(status.state).toBe("running");
    expect(harness.state.startCount).toBe(1);
    expect(harness.state.restartCount).toBe(0);
    expect(harness.createDesktopStewardSidecar).toHaveBeenCalledTimes(1);
  });

  it("restarts an existing sidecar and reconfigures env", async () => {
    const { getStewardSidecar, restartSteward } = await loadSteward();
    await getStewardSidecar();
    harness.state.credentials = FULL_CREDENTIALS;
    const status = await restartSteward();
    expect(status.state).toBe("running");
    expect(status.pid).toBe(4243);
    expect(status.restartCount).toBe(1);
    expect(harness.state.startCount).toBe(0);
    expect(harness.state.restartCount).toBe(1);
    expect(process.env.STEWARD_AGENT_TOKEN).toBe("agent-token");
  });

  it("propagates a restart failure instead of catching it", async () => {
    const { getStewardSidecar, restartSteward } = await loadSteward();
    await getStewardSidecar();
    const failure = new Error("restart refused");
    harness.state.restartFailure = failure;
    await expect(restartSteward()).rejects.toBe(failure);
  });
});

describe("resetSteward", () => {
  it("refuses a data directory outside the brand namespace", async () => {
    const { resetSteward } = await loadSteward();
    const home = makeTempHome();
    process.env.HOME = home;
    process.env.STEWARD_DATA_DIR = path.join(os.tmpdir(), "not-eliza-steward");
    const resolved = path.resolve(process.env.STEWARD_DATA_DIR);
    await expect(resetSteward()).rejects.toThrow(
      `[Steward] Refusing to delete dataDir outside ~/.eliza/: ${resolved}`,
    );
    expect(harness.state.startCount).toBe(0);
  });

  it("refuses a sibling directory that only shares a prefix with the namespace", async () => {
    const { resetSteward } = await loadSteward();
    const home = makeTempHome();
    process.env.HOME = home;
    process.env.STEWARD_DATA_DIR = path.join(home, ".eliza-evil", "steward");
    await expect(resetSteward()).rejects.toThrow(
      /Refusing to delete dataDir outside ~\/\.eliza\//,
    );
  });

  it("deletes an existing namespace data directory, clears env, and starts fresh", async () => {
    const { getStewardSidecar, startSteward, resetSteward } =
      await loadSteward();
    const home = makeTempHome();
    const dataDir = path.join(home, ".eliza", "steward");
    fs.mkdirSync(dataDir, { recursive: true });
    const sentinel = path.join(dataDir, "wallet-state");
    fs.writeFileSync(sentinel, "wipe-me", "utf8");
    process.env.HOME = home;
    process.env.STEWARD_DATA_DIR = dataDir;
    harness.state.credentials = FULL_CREDENTIALS;
    await getStewardSidecar();
    await startSteward();
    expect(process.env.STEWARD_AGENT_TOKEN).toBe("agent-token");

    harness.state.credentials = null;
    const status = await resetSteward();

    expect(status.state).toBe("running");
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.existsSync(dataDir)).toBe(false);
    expect(process.env.STEWARD_AGENT_TOKEN).toBeUndefined();
    expect(process.env.STEWARD_API_KEY).toBeUndefined();
    expect(process.env.STEWARD_TENANT_ID).toBeUndefined();
    expect(process.env.STEWARD_AGENT_ID).toBeUndefined();
    expect(process.env.STEWARD_API_URL).toBe("http://127.0.0.1:3200");
    expect(harness.state.stopCount).toBe(1);
    expect(harness.createDesktopStewardSidecar).toHaveBeenCalledTimes(2);
  });

  it("starts even when the data directory does not exist", async () => {
    const { resetSteward } = await loadSteward();
    const home = makeTempHome();
    const dataDir = path.join(home, ".eliza", "steward");
    process.env.HOME = home;
    process.env.STEWARD_DATA_DIR = dataDir;
    const status = await resetSteward();
    expect(status.state).toBe("running");
    expect(harness.createDesktopStewardSidecar).toHaveBeenCalledTimes(1);
  });

  it("allows a dataDir that resolves exactly to the namespace root", async () => {
    const { resetSteward } = await loadSteward();
    const home = makeTempHome();
    const stateBase = path.join(home, ".eliza");
    fs.mkdirSync(stateBase, { recursive: true });
    fs.writeFileSync(path.join(stateBase, "marker"), "gone", "utf8");
    process.env.HOME = home;
    process.env.STEWARD_DATA_DIR = stateBase;
    await resetSteward();
    expect(fs.existsSync(stateBase)).toBe(false);
  });

  it("resolves USERPROFILE when HOME is unset", async () => {
    const { resetSteward } = await loadSteward();
    const home = makeTempHome();
    const dataDir = path.join(home, ".eliza", "steward");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "wallet"), "x", "utf8");
    delete process.env.HOME;
    process.env.USERPROFILE = home;
    process.env.STEWARD_DATA_DIR = dataDir;
    await resetSteward();
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it("uses the default ~/.eliza/steward path when STEWARD_DATA_DIR is unset", async () => {
    const { resetSteward } = await loadSteward();
    const home = makeTempHome();
    const dataDir = path.join(home, ".eliza", "steward");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "wallet"), "x", "utf8");
    process.env.HOME = home;
    delete process.env.STEWARD_DATA_DIR;
    await resetSteward();
    expect(fs.existsSync(dataDir)).toBe(false);
  });
});

describe("getStewardStatus with a sidecar", () => {
  it("returns the sidecar status rather than the stopped default", async () => {
    const { getStewardSidecar, getStewardStatus } = await loadSteward();
    await getStewardSidecar();
    harness.state.status = {
      ...STOPPED_STATUS,
      state: "running",
      port: 3200,
      pid: 11,
      walletAddress: "0xstat",
      agentId: "agent-stat",
      tenantId: "tenant-stat",
      startedAt: 99,
    };
    expect(getStewardStatus()).toEqual(harness.state.status);
  });
});
