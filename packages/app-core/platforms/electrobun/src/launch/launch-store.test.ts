import { describe, expect, it } from "vitest";
import { createDatabaseSnapshot } from "../database";
import { LaunchStore } from "./launch-store";
import type { LaunchSnapshot } from "./types";

function snapshot(phase: LaunchSnapshot["phase"]): LaunchSnapshot {
  return {
    phase,
    agent: {
      state: "running",
      port: 31337,
      apiBase: "http://127.0.0.1:31337",
      startedAt: 1,
      error: null,
    },
    boot: {
      runtimePhase: "running",
      pluginsLoaded: 10,
      pluginsFailed: 0,
      database: "ok",
    },
    database: createDatabaseSnapshot({
      mode: "pglite-persistent",
      status: "ready",
      postgresUrlSet: false,
      pgliteDataDir: "/tmp/pglite",
      effectiveTarget: "/tmp/pglite",
      updatedAt: "2026-05-17T00:00:00.000Z",
    }),
    auth: {
      checked: true,
      required: false,
      pairingEnabled: false,
      error: null,
    },
    onboarding: {
      checked: true,
      complete: true,
      requiredGate: null,
      error: null,
    },
    satellites: {
      seeded: true,
      requiredStarted: true,
      errors: [],
    },
    localModel: {
      backgroundDownloadQueued: false,
      blocking: false,
      error: null,
    },
    diagnostics: {
      logPath: "/tmp/launch.log",
      statusPath: "/tmp/launch-status.json",
      logTail: "",
    },
    recovery: {
      canRetry: true,
      canOpenLogs: true,
      canCreateBugReport: true,
    },
    updatedAt: "2026-05-17T00:00:00.000Z",
  };
}

describe("LaunchStore", () => {
  it("stores snapshots and records phase changes", () => {
    const store = new LaunchStore({
      now: () => new Date("2026-05-17T00:00:00.000Z"),
    });

    store.update(snapshot("agent-api-waiting"));
    store.update(snapshot("ready"));

    expect(store.getSnapshot().phase).toBe("ready");
    expect(store.tailEvents().events.map((event) => event.name)).toEqual([
      "launch.phase.changed",
      "launch.phase.changed",
    ]);
  });

  it("tails bounded event history", () => {
    const store = new LaunchStore({
      maxEvents: 2,
      now: () => new Date("2026-05-17T00:00:00.000Z"),
    });

    store.recordEvent("one", "static-shell");
    store.recordEvent("two", "agent-api-waiting");
    store.recordEvent("three", "ready");

    const tail = store.tailEvents(1, 10);

    expect(tail.nextSequence).toBe(3);
    expect(tail.events.map((event) => event.name)).toEqual(["two", "three"]);
  });
});
