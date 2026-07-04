/**
 * waitForSpawnSlot unit tests pin the concurrency gate that serializes coding
 * sub-agent spawns past a configurable ceiling. Vitest fake timers and a mocked
 * ACP service cover disabled limits, polling until capacity returns, warn-and-
 * proceed timeout behavior, and terminal-status filtering without real sleeps.
 */
// Determinism: every wait is driven by vi.advanceTimersByTimeAsync; the
// service's session list is a mutable array we flip between polls, so the gate
// observes real state changes without any wall-clock sleeping or network.

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpActionService } from "../../src/actions/common.ts";
import { waitForSpawnSlot } from "../../src/actions/common.ts";
import type { SessionInfo, SessionStatus } from "../../src/services/types.ts";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeSession(status: SessionStatus, id = `s-${status}`): SessionInfo {
  return {
    id,
    agentType: "elizaos" as SessionInfo["agentType"],
    workdir: "/tmp/work",
    status,
    approvalPreset: "standard" as SessionInfo["approvalPreset"],
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
  };
}

/**
 * A minimal AcpActionService whose `listSessions()` returns a mutable array
 * the test controls. listSessions resolves synchronously (returns the array
 * directly) so the 2s race inside listSessionsWithin always settles on the
 * data side, never the timeout — keeping polls deterministic under fake timers.
 */
function makeService(initial: SessionInfo[] = []): {
  service: AcpActionService;
  setSessions: (s: SessionInfo[]) => void;
  listSpy: ReturnType<typeof vi.fn>;
} {
  let sessions = initial;
  const listSpy = vi.fn(() => sessions);
  const service = {
    spawnSession: vi.fn(),
    sendToSession: vi.fn(),
    sendKeysToSession: vi.fn(),
    stopSession: vi.fn(),
    listSessions: listSpy,
    getSession: vi.fn(),
  } as unknown as AcpActionService;
  return {
    service,
    setSessions: (s) => {
      sessions = s;
    },
    listSpy,
  };
}

function makeRuntime(setting?: string): {
  runtime: IAgentRuntime;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  const debug = vi.fn();
  const runtime = {
    getSetting: vi.fn((key: string) =>
      key === "ELIZA_MAX_CONCURRENT_SPAWNS" ? setting : undefined,
    ),
    logger: { warn, debug, info: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
  return { runtime, warn, debug };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("waitForSpawnSlot", () => {
  const savedEnv = process.env.ELIZA_MAX_CONCURRENT_SPAWNS;

  beforeEach(() => {
    vi.useFakeTimers();
    // Default env to a finite cap so cases not setting it are deterministic.
    delete process.env.ELIZA_MAX_CONCURRENT_SPAWNS;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    if (savedEnv === undefined) delete process.env.ELIZA_MAX_CONCURRENT_SPAWNS;
    else process.env.ELIZA_MAX_CONCURRENT_SPAWNS = savedEnv;
  });

  describe("disabled when the limit is <= 0", () => {
    it("returns immediately and never reads session state when setting is 0", async () => {
      const { runtime } = makeRuntime("0");
      const { service, listSpy } = makeService([
        makeSession("running", "a"),
        makeSession("running", "b"),
        makeSession("running", "c"),
      ]);

      // No timers should be needed; resolve without advancing the clock.
      await waitForSpawnSlot(runtime, service, {
        pollMs: 1000,
        maxWaitMs: 5000,
      });

      // The gate is disabled, so it must not have polled session state.
      expect(listSpy).not.toHaveBeenCalled();
    });

    it("returns immediately for a negative limit", async () => {
      const { runtime } = makeRuntime("-1");
      const { service, listSpy } = makeService([makeSession("running", "a")]);

      await waitForSpawnSlot(runtime, service);

      expect(listSpy).not.toHaveBeenCalled();
    });

    it("returns immediately for a non-numeric limit (NaN -> disabled)", async () => {
      const { runtime } = makeRuntime("not-a-number");
      const { service, listSpy } = makeService([makeSession("running", "a")]);

      await waitForSpawnSlot(runtime, service);

      // parseInt("not-a-number") -> NaN -> !Number.isFinite -> disabled.
      expect(listSpy).not.toHaveBeenCalled();
    });

    it("reads the env var when getSetting returns nothing", async () => {
      process.env.ELIZA_MAX_CONCURRENT_SPAWNS = "0";
      // getSetting returns undefined -> falls back to process.env.
      const { runtime } = makeRuntime(undefined);
      const { service, listSpy } = makeService([makeSession("running", "a")]);

      await waitForSpawnSlot(runtime, service);

      expect(listSpy).not.toHaveBeenCalled();
    });
  });

  describe("blocks then proceeds as active sessions terminate", () => {
    it("waits while the cap is full and returns once a slot frees up", async () => {
      const { runtime } = makeRuntime("2");
      // Start at the cap (2 active >= limit 2): the gate must block.
      const { service, setSessions, listSpy } = makeService([
        makeSession("running", "a"),
        makeSession("busy", "b"),
      ]);

      let resolved = false;
      const pending = waitForSpawnSlot(runtime, service, {
        pollMs: 3000,
        maxWaitMs: 60_000,
      }).then(() => {
        resolved = true;
      });

      // First poll happens immediately (Date.now()-startedAt === 0 < maxWaitMs).
      // Let the first listSessions/race microtasks settle.
      await Promise.resolve();
      await Promise.resolve();
      expect(listSpy).toHaveBeenCalledTimes(1);
      expect(resolved).toBe(false);

      // Advance one poll interval; still at the cap -> still blocked.
      await vi.advanceTimersByTimeAsync(3000);
      expect(listSpy).toHaveBeenCalledTimes(2);
      expect(resolved).toBe(false);

      // One session terminates: active drops to 1 < limit 2.
      setSessions([makeSession("completed", "a"), makeSession("busy", "b")]);

      // Next poll observes the free slot and the promise resolves.
      await vi.advanceTimersByTimeAsync(3000);
      await pending;
      expect(resolved).toBe(true);
      expect(listSpy).toHaveBeenCalledTimes(3);
    });

    it("proceeds on the very first poll when already under the cap", async () => {
      const { runtime, warn } = makeRuntime("2");
      const { service, listSpy } = makeService([makeSession("running", "a")]);

      let resolved = false;
      const pending = waitForSpawnSlot(runtime, service, {
        pollMs: 3000,
        maxWaitMs: 60_000,
      }).then(() => {
        resolved = true;
      });

      // Drain the initial poll's microtasks; 1 active < limit 2 -> resolve now.
      await Promise.resolve();
      await Promise.resolve();
      await pending;

      expect(resolved).toBe(true);
      expect(listSpy).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("gives up after maxWaitMs with warn-and-proceed", () => {
    it("warns and resolves once the deadline passes while still over the cap", async () => {
      const { runtime, warn } = makeRuntime("1");
      // Permanently over the cap: 1 active >= limit 1, never frees.
      const { service } = makeService([makeSession("running", "stuck")]);

      let resolved = false;
      const pending = waitForSpawnSlot(runtime, service, {
        pollMs: 1000,
        maxWaitMs: 5000,
      }).then(() => {
        resolved = true;
      });

      // Burn through the entire wait window. Each iteration: poll (still full),
      // then sleep pollMs. After ~5 iterations the deadline is reached.
      for (let i = 0; i < 6 && !resolved; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      await pending;

      expect(resolved).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      const warnMsg = String(warn.mock.calls[0]?.[0] ?? "");
      expect(warnMsg).toContain("proceeding anyway");
      // 5000ms / 1000 = 5s in the message.
      expect(warnMsg).toContain("5s");
    });

    it("does not warn when a slot frees before the deadline", async () => {
      const { runtime, warn } = makeRuntime("1");
      const { service, setSessions } = makeService([
        makeSession("running", "stuck"),
      ]);

      const pending = waitForSpawnSlot(runtime, service, {
        pollMs: 1000,
        maxWaitMs: 60_000,
      });

      await Promise.resolve();
      await Promise.resolve();
      // Free the slot before any deadline.
      setSessions([makeSession("stopped", "stuck")]);
      await vi.advanceTimersByTimeAsync(1000);
      await pending;

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("counts only non-terminal sessions toward the cap", () => {
    it("ignores terminal sessions entirely (all terminal -> proceeds at once)", async () => {
      const { runtime, warn } = makeRuntime("1");
      // Four sessions, all terminal -> 0 active < limit 1 -> immediate proceed.
      const { service, listSpy } = makeService([
        makeSession("completed", "c1"),
        makeSession("stopped", "c2"),
        makeSession("errored", "c3"),
        makeSession("cancelled", "c4"),
      ]);

      let resolved = false;
      const pending = waitForSpawnSlot(runtime, service, {
        pollMs: 1000,
        maxWaitMs: 60_000,
      }).then(() => {
        resolved = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      await pending;

      expect(resolved).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      expect(listSpy).toHaveBeenCalledTimes(1);
    });

    it("counts non-terminal sessions even when mixed with terminal ones", async () => {
      const { runtime } = makeRuntime("2");
      // 2 non-terminal (running, busy) + 3 terminal -> active 2 >= limit 2.
      const { service, setSessions, listSpy } = makeService([
        makeSession("running", "live1"),
        makeSession("busy", "live2"),
        makeSession("completed", "dead1"),
        makeSession("stopped", "dead2"),
        makeSession("cancelled", "dead3"),
      ]);

      let resolved = false;
      const pending = waitForSpawnSlot(runtime, service, {
        pollMs: 1000,
        maxWaitMs: 60_000,
      }).then(() => {
        resolved = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      // Active==2 == limit -> blocked despite three terminal sessions present.
      expect(resolved).toBe(false);
      expect(listSpy).toHaveBeenCalledTimes(1);

      // Drop one live session to terminal: active -> 1 < limit 2.
      setSessions([
        makeSession("completed", "live1"),
        makeSession("busy", "live2"),
        makeSession("completed", "dead1"),
      ]);
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
      expect(resolved).toBe(true);
    });

    it("treats an unknown / transient status as active (fails closed)", async () => {
      const { runtime } = makeRuntime("1");
      // "starting" is not in the terminal set -> must count as active.
      const { service, setSessions, listSpy } = makeService([
        makeSession("starting", "transient"),
      ]);

      let resolved = false;
      const pending = waitForSpawnSlot(runtime, service, {
        pollMs: 1000,
        maxWaitMs: 60_000,
      }).then(() => {
        resolved = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      // 1 active (transient) >= limit 1 -> blocked.
      expect(resolved).toBe(false);
      expect(listSpy).toHaveBeenCalledTimes(1);

      // Only once it goes terminal does the gate release.
      setSessions([makeSession("errored", "transient")]);
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
      expect(resolved).toBe(true);
    });
  });

  describe("default limit (no setting, no env)", () => {
    it("defaults to a cap of 2", async () => {
      const { runtime } = makeRuntime(undefined);
      // 2 active at the default cap -> blocked; would not block if default were higher.
      const { service, setSessions, listSpy } = makeService([
        makeSession("running", "a"),
        makeSession("running", "b"),
      ]);

      let resolved = false;
      const pending = waitForSpawnSlot(runtime, service, {
        pollMs: 1000,
        maxWaitMs: 60_000,
      }).then(() => {
        resolved = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(listSpy).toHaveBeenCalledTimes(1);

      setSessions([makeSession("stopped", "a"), makeSession("running", "b")]);
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
      expect(resolved).toBe(true);
    });
  });
});
