import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetRuntimeModeSnapshotCacheForTests,
  getRuntimeModeSnapshot,
} from "./runtime-mode.ts";

let stateDir: string;
let canonical: string;

function write(name: string, value: object): string {
  const file = path.join(stateDir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function mode(runtime: "local" | "cloud" | "remote") {
  return { deploymentTarget: { runtime } };
}

function nextCheck(): void {
  vi.advanceTimersByTime(1_001);
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-mode-cache-"));
  canonical = path.join(stateDir, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);
  vi.stubEnv("ELIZA_CONFIG_PATH", canonical);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", "");
  vi.stubEnv("ELIZA_NAMESPACE", "eliza");
  vi.stubEnv("ELIZA_DEV_SOURCE", "");
  vi.stubEnv("ELIZA_DEV_CLOUD_ENV_AUTHORITY", "");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
  __resetRuntimeModeSnapshotCacheForTests();
});

afterEach(() => {
  __resetRuntimeModeSnapshotCacheForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("runtime mode effective-config invalidation", () => {
  it("observes an overlay appearing, changing, and disappearing", () => {
    write("eliza.json", mode("local"));
    expect(getRuntimeModeSnapshot().mode).toBe("local");
    const overlay = write("eliza.config-overlay.json", mode("cloud"));
    nextCheck();
    expect(getRuntimeModeSnapshot().mode).toBe("cloud");
    write("eliza.config-overlay.json", mode("remote"));
    nextCheck();
    expect(getRuntimeModeSnapshot().mode).toBe("remote");
    fs.unlinkSync(overlay);
    nextCheck();
    expect(getRuntimeModeSnapshot().mode).toBe("local");
  });

  it("observes separate persistence and its included input", () => {
    write("eliza.json", mode("local"));
    vi.stubEnv(
      "ELIZA_PERSIST_CONFIG_PATH",
      path.join(stateDir, "persist.json"),
    );
    expect(getRuntimeModeSnapshot().mode).toBe("local");
    write("persist.json", { $include: "./persist-mode.json" });
    write("persist-mode.json", mode("cloud"));
    nextCheck();
    expect(getRuntimeModeSnapshot().mode).toBe("cloud");
    write("persist-mode.json", mode("remote"));
    nextCheck();
    expect(getRuntimeModeSnapshot().mode).toBe("remote");
  });

  it("tracks nested include graph replacement without reusing the old graph", () => {
    write("eliza.json", { $include: "./middle.json" });
    write("middle.json", { $include: "./first.json" });
    write("first.json", mode("local"));
    expect(getRuntimeModeSnapshot().mode).toBe("local");
    write("second.json", mode("cloud"));
    write("middle.json", { $include: "./second.json" });
    nextCheck();
    expect(getRuntimeModeSnapshot().mode).toBe("cloud");
    write("second.json", mode("remote"));
    nextCheck();
    expect(getRuntimeModeSnapshot().mode).toBe("remote");
  });

  it("invalidates immediately on a same-mtime canonical identity switch", () => {
    write("eliza.json", mode("local"));
    const other = write("other.json", mode("cloud"));
    const stamp = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(canonical, stamp, stamp);
    fs.utimesSync(other, stamp, stamp);
    expect(getRuntimeModeSnapshot().mode).toBe("local");
    vi.stubEnv("ELIZA_CONFIG_PATH", other);
    expect(getRuntimeModeSnapshot().mode).toBe("cloud");
  });

  it("invalidates immediately when persistence identity changes", () => {
    write("eliza.json", mode("local"));
    const persisted = write("persist.json", mode("remote"));
    expect(getRuntimeModeSnapshot().mode).toBe("local");
    vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", persisted);
    expect(getRuntimeModeSnapshot().mode).toBe("remote");
  });

  it("invalidates immediately when namespace selects a different overlay", () => {
    write("eliza.json", mode("local"));
    write("other.config-overlay.json", mode("cloud"));
    expect(getRuntimeModeSnapshot().mode).toBe("local");
    vi.stubEnv("ELIZA_NAMESPACE", "other");
    expect(getRuntimeModeSnapshot().mode).toBe("cloud");
  });

  it("observes a higher-priority canonical filename appearing", () => {
    vi.stubEnv("ELIZA_CONFIG_PATH", "");
    vi.stubEnv("ELIZA_NAMESPACE", "other");
    write("eliza.json", mode("local"));
    expect(getRuntimeModeSnapshot().mode).toBe("local");
    write("other.json", mode("remote"));
    expect(getRuntimeModeSnapshot().mode).toBe("remote");
  });

  it("observes an in-place change even when mtime is restored", () => {
    write("eliza.json", mode("local"));
    const stamp = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(canonical, stamp, stamp);
    const before = fs.statSync(canonical);
    expect(getRuntimeModeSnapshot().mode).toBe("local");
    write("eliza.json", mode("cloud"));
    fs.utimesSync(canonical, before.atime, before.mtime);
    nextCheck();
    expect(getRuntimeModeSnapshot().mode).toBe("cloud");
  });

  it("does not serve stale mode after a source fails, and retries repaired input", () => {
    write("eliza.json", { $include: "./included.json" });
    const included = write("included.json", mode("local"));
    expect(getRuntimeModeSnapshot().mode).toBe("local");
    fs.unlinkSync(included);
    nextCheck();
    expect(() => getRuntimeModeSnapshot()).toThrow("Failed to read include");
    expect(() => getRuntimeModeSnapshot()).toThrow("Failed to read include");
    write("included.json", mode("remote"));
    expect(getRuntimeModeSnapshot().mode).toBe("remote");
  });

  it("keeps malformed overlay failure visible until the source is repaired", () => {
    write("eliza.json", mode("local"));
    expect(getRuntimeModeSnapshot().mode).toBe("local");
    const overlay = path.join(stateDir, "eliza.config-overlay.json");
    fs.writeFileSync(overlay, '{"deploymentTarget":');
    nextCheck();
    expect(() => getRuntimeModeSnapshot()).toThrow();
    expect(() => getRuntimeModeSnapshot()).toThrow();
    write("eliza.config-overlay.json", mode("cloud"));
    expect(getRuntimeModeSnapshot().mode).toBe("cloud");
  });

  it("reuses parsed config across metadata checks, not only within one interval", () => {
    write("eliza.json", mode("cloud"));
    const reads = vi.spyOn(fs, "readFileSync");
    const stats = vi.spyOn(fs, "statSync");
    const first = getRuntimeModeSnapshot();
    const initialReads = reads.mock.calls.length;
    expect(initialReads).toBeGreaterThan(0);
    for (let interval = 0; interval < 3; interval++) {
      const initialStats = stats.mock.calls.length;
      for (let request = 0; request < 25; request++) {
        expect(getRuntimeModeSnapshot()).toBe(first);
      }
      expect(stats.mock.calls.length).toBe(initialStats);
      nextCheck();
      expect(getRuntimeModeSnapshot()).toBe(first);
      expect(stats.mock.calls.length).toBeGreaterThan(initialStats);
    }
    expect(getRuntimeModeSnapshot()).toBe(first);
    expect(reads.mock.calls.length).toBe(initialReads);
  });
});
