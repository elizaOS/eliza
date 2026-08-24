// @vitest-environment jsdom

/**
 * Unit suite for the platform first-run-reset force-fresh state machine
 * (`src/platform/first-run-reset.ts`), driven entirely through its public API.
 *
 * The module is the shell's escape hatch for stranded startup screens: arm
 * `elizaos:first-run:force-fresh`, consume a `?reset` query param into that
 * directive plus an "applied" marker, and overlay a patched API client until
 * onboarding completes. The suite pins the contracts downstream consumers rely
 * on: arming clears a stale applied-marker (an interrupted query-param reset
 * must not suppress the next restore), consuming `?reset` clears the three
 * boot keys and the shell-reserved `elizaos_api_base` from BOTH storages,
 * history is rewritten to strip the param, submission lifts the overlay by
 * clearing the flag, and double installation is inert while uninstall restores
 * the original client methods verbatim.
 *
 * Harness: real module, real jsdom `localStorage`/`sessionStorage`, functional
 * in-memory `StorageLike`/`HistoryLike` doubles injected through the module's
 * own seams. No network, nothing under test mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyForceFreshFirstRunReset,
  clearForceFreshFirstRun,
  enableForceFreshFirstRun,
  installForceFreshFirstRunClientPatch,
  isForceFreshFirstRunEnabled,
  startFreshFirstRunReload,
  wasForceFreshResetApplied,
} from "./first-run-reset";
import type { FirstRunClientLike, HistoryLike, StorageLike } from "./types";

const FORCE_FRESH_KEY = "elizaos:first-run:force-fresh";
const RESET_APPLIED_KEY = "elizaos:first-run:reset-applied";
const ACTIVE_SERVER_KEY = "elizaos:active-server";
const SETUP_STEP_KEY = "eliza:setup:step";
const FIRST_RUN_COMPLETE_KEY = "eliza:first-run-complete";

/**
 * Functional Map-backed storage double: every mutation is recorded in `ops`
 * so tests can assert that a path mutated NOTHING, not merely that a getter
 * returned a value the double itself produced.
 */
function makeStorage(seed?: Record<string, string>): StorageLike & {
  ops: string[];
  get: (key: string) => string | null;
} {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  const ops: string[] = [];
  return {
    ops,
    get: (key) => map.get(key) ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      ops.push(`set:${key}`);
      map.set(key, value);
    },
    removeItem: (key) => {
      ops.push(`remove:${key}`);
      map.delete(key);
    },
  };
}

function makeHistory(): HistoryLike & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    replaceState: (...args: unknown[]) => {
      calls.push(args);
    },
  };
}

function resetUrl(): URL {
  return new URL("https://app.eliza.local/?reset&tab=chat");
}

const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
);

/** Swap `window.location` for a plain object recording reload() invocations. */
function stubLocationReload(): { reloads: () => number } {
  let reloads = 0;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      reload: () => {
        reloads += 1;
      },
      toString: () => "https://app.eliza.local/",
    },
  });
  return { reloads: () => reloads };
}

/** Spy client matching the narrow FirstRunClientLike seam, onboarding-replay style. */
function makeClient(status: { complete: boolean } & Record<string, unknown>) {
  const getConfig = vi.fn(async () => ({
    meta: { firstRunComplete: true },
  }));
  const getFirstRunStatus = vi.fn(async () => status);
  const submitFirstRun = vi.fn(async () => {});
  const client = {
    getConfig,
    getFirstRunStatus,
    submitFirstRun,
  } as unknown as FirstRunClientLike;
  return { client, getConfig, getFirstRunStatus, submitFirstRun };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  if (originalLocationDescriptor) {
    Object.defineProperty(window, "location", originalLocationDescriptor);
  }
  vi.restoreAllMocks();
});

describe("isForceFreshFirstRunEnabled", () => {
  it("reads the durable directive from the resolved storage", () => {
    const storage = makeStorage({ [FORCE_FRESH_KEY]: "1" });
    expect(isForceFreshFirstRunEnabled(storage)).toBe(true);
  });

  it("is false when the key holds any value other than '1' or is absent", () => {
    const storage = makeStorage({ [FORCE_FRESH_KEY]: "0" });
    expect(isForceFreshFirstRunEnabled(storage)).toBe(false);
    expect(isForceFreshFirstRunEnabled(makeStorage())).toBe(false);
  });

  it("is false when no storage can be resolved", () => {
    expect(isForceFreshFirstRunEnabled(null)).toBe(false);
  });

  it("reports a hostile (throwing) store as disabled instead of crashing", () => {
    const hostile: StorageLike = {
      getItem: () => {
        throw new Error("storage guard denied");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(isForceFreshFirstRunEnabled(hostile)).toBe(false);
  });
});

describe("enableForceFreshFirstRun / clearForceFreshFirstRun", () => {
  it("arming sets the flag AND clears a stale applied-marker so the next restore runs", () => {
    const storage = makeStorage({
      [FORCE_FRESH_KEY]: "",
      [RESET_APPLIED_KEY]: "1",
    });
    enableForceFreshFirstRun(storage);
    expect(storage.get(FORCE_FRESH_KEY)).toBe("1");
    expect(storage.get(RESET_APPLIED_KEY)).toBeNull();
  });

  it("clearing removes both keys and tolerates repeated or absent clears", () => {
    const storage = makeStorage({
      [FORCE_FRESH_KEY]: "1",
      [RESET_APPLIED_KEY]: "1",
    });
    clearForceFreshFirstRun(storage);
    expect(storage.get(FORCE_FRESH_KEY)).toBeNull();
    expect(storage.get(RESET_APPLIED_KEY)).toBeNull();
    expect(() => clearForceFreshFirstRun(storage)).not.toThrow();
  });

  it("both operations are safe no-ops without resolvable storage", () => {
    expect(() => enableForceFreshFirstRun(null)).not.toThrow();
    expect(() => clearForceFreshFirstRun(null)).not.toThrow();
  });

  it("arming swallows a hostile store failure during startup", () => {
    const hostile: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {},
    };
    expect(() => enableForceFreshFirstRun(hostile)).not.toThrow();
  });
});

describe("wasForceFreshResetApplied", () => {
  it("only reports applied once the ?reset boot path has marked it", () => {
    const storage = makeStorage();
    const history = makeHistory();
    expect(wasForceFreshResetApplied(storage)).toBe(false);

    applyForceFreshFirstRunReset({ url: resetUrl(), storage, history });
    expect(wasForceFreshResetApplied(storage)).toBe(true);
    expect(storage.get(RESET_APPLIED_KEY)).toBe("1");

    clearForceFreshFirstRun(storage);
    expect(wasForceFreshResetApplied(storage)).toBe(false);
  });
});

describe("applyForceFreshFirstRunReset", () => {
  it("returns false and mutates nothing when the URL carries no ?reset", () => {
    const storage = makeStorage();
    const history = makeHistory();

    const applied = applyForceFreshFirstRunReset({
      url: new URL("https://app.eliza.local/?tab=chat"),
      storage,
      history,
    });

    expect(applied).toBe(false);
    expect(storage.ops).toEqual([]);
    expect(history.calls).toEqual([]);
  });

  it("consuming ?reset clears the three boot keys, arms force-fresh, marks applied, and strips the param from history", () => {
    const storage = makeStorage({
      [ACTIVE_SERVER_KEY]: '{"label":"old"}',
      [SETUP_STEP_KEY]: "pairing",
      [FIRST_RUN_COMPLETE_KEY]: "1",
    });
    const history = makeHistory();

    const applied = applyForceFreshFirstRunReset({
      url: resetUrl(),
      storage,
      history,
    });

    expect(applied).toBe(true);
    expect(storage.get(ACTIVE_SERVER_KEY)).toBeNull();
    expect(storage.get(SETUP_STEP_KEY)).toBeNull();
    expect(storage.get(FIRST_RUN_COMPLETE_KEY)).toBeNull();
    expect(storage.get(FORCE_FRESH_KEY)).toBe("1");
    expect(storage.get(RESET_APPLIED_KEY)).toBe("1");

    expect(history.calls).toHaveLength(1);
    const rewritten = String(history.calls[0]?.[2]);
    expect(rewritten).toContain("tab=chat");
    expect(rewritten).not.toContain("reset");
  });

  it("still strips the param and reports applied when storage is unavailable", () => {
    const history = makeHistory();
    const applied = applyForceFreshFirstRunReset({
      url: resetUrl(),
      storage: null,
      history,
    });
    expect(applied).toBe(true);
    expect(history.calls).toHaveLength(1);
  });

  it("clears the shell-reserved elizaos_api_base from BOTH browser storages", () => {
    window.localStorage.setItem("elizaos_api_base", "https://stale.example");
    window.sessionStorage.setItem("elizaos_api_base", "https://stale.example");
    const storage = makeStorage();
    const history = makeHistory();

    const applied = applyForceFreshFirstRunReset({
      url: resetUrl(),
      storage,
      history,
    });

    expect(applied).toBe(true);
    expect(window.localStorage.getItem("elizaos_api_base")).toBeNull();
    expect(window.sessionStorage.getItem("elizaos_api_base")).toBeNull();
  });
});

describe("startFreshFirstRunReload", () => {
  it("persists the durable directive, then reloads exactly once", () => {
    const location = stubLocationReload();
    const storage = makeStorage();

    startFreshFirstRunReload(storage);

    expect(storage.get(FORCE_FRESH_KEY)).toBe("1");
    expect(location.reloads()).toBe(1);
  });
});

describe("installForceFreshFirstRunClientPatch", () => {
  it("delegates verbatim to the real client while the directive is disarmed", async () => {
    const storage = makeStorage();
    const spies = makeClient({ complete: true });

    const uninstall = installForceFreshFirstRunClientPatch(
      spies.client,
      storage,
    );

    const status = await spies.client.getFirstRunStatus();
    expect(status.complete).toBe(true);
    const config = await spies.client.getConfig();
    expect(config).toEqual({ meta: { firstRunComplete: true } });
    expect(spies.getFirstRunStatus).toHaveBeenCalledTimes(1);
    expect(spies.getConfig).toHaveBeenCalledTimes(1);

    uninstall();
  });

  it("while armed: config reads answer empty WITHOUT reaching the stranded backend, and status reports incomplete preserving extra fields", async () => {
    const storage = makeStorage();
    enableForceFreshFirstRun(storage);
    const spies = makeClient({ complete: true, agentName: "Real Agent" });

    const uninstall = installForceFreshFirstRunClientPatch(
      spies.client,
      storage,
    );

    expect(await spies.client.getConfig()).toEqual({});
    expect(spies.getConfig).not.toHaveBeenCalled();

    const status = await spies.client.getFirstRunStatus();
    expect(status).toEqual({ complete: false, agentName: "Real Agent" });
    expect(spies.getFirstRunStatus).toHaveBeenCalledTimes(1);

    uninstall();
  });

  it("submitting first run lifts the overlay by clearing the durable directive", async () => {
    const storage = makeStorage();
    enableForceFreshFirstRun(storage);
    const spies = makeClient({ complete: true });

    const uninstall = installForceFreshFirstRunClientPatch(
      spies.client,
      storage,
    );

    await spies.client.submitFirstRun({} as never);
    expect(spies.submitFirstRun).toHaveBeenCalledTimes(1);
    expect(isForceFreshFirstRunEnabled(storage)).toBe(false);

    await spies.client.getConfig();
    expect(spies.getConfig).toHaveBeenCalledTimes(1);

    uninstall();
  });

  it("double installation is inert: the second handle is a no-op and only the first uninstall restores", async () => {
    const storage = makeStorage();
    enableForceFreshFirstRun(storage);
    const spies = makeClient({ complete: true });

    const uninstallFirst = installForceFreshFirstRunClientPatch(
      spies.client,
      storage,
    );
    const uninstallSecond = installForceFreshFirstRunClientPatch(
      spies.client,
      storage,
    );

    uninstallSecond();
    const status = await spies.client.getFirstRunStatus();
    expect(status.complete).toBe(false);

    uninstallFirst();
    const restored = await spies.client.getFirstRunStatus();
    expect(restored).toEqual({ complete: true });
  });

  it("uninstall restores the original method identities and a fresh patch can be installed again", async () => {
    const storage = makeStorage();
    const spies = makeClient({ complete: true });

    const uninstall = installForceFreshFirstRunClientPatch(
      spies.client,
      storage,
    );
    uninstall();

    expect(spies.client.getConfig).toBe(spies.getConfig);
    expect(spies.client.getFirstRunStatus).toBe(spies.getFirstRunStatus);
    expect(spies.client.submitFirstRun).toBe(spies.submitFirstRun);

    enableForceFreshFirstRun(storage);
    const reinstall = installForceFreshFirstRunClientPatch(
      spies.client,
      storage,
    );
    expect(await spies.client.getConfig()).toEqual({});
    reinstall();
  });
});
