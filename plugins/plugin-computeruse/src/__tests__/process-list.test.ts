/**
 * Real-host process-list tests. Linux path runs against /proc on this host;
 * macOS / Windows paths are parser-only fixtures.
 */

import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { currentPlatform } from "../platform/helpers.js";
import {
  listProcesses,
  parsePsOutput,
  parseWindowsProcessJson,
} from "../platform/process-list.js";

describe("process-list — Linux /proc (real host)", () => {
  if (currentPlatform() !== "linux") {
    it.skip("not on linux", () => {});
    return;
  }
  it("enumerates running processes", () => {
    const procs = listProcesses();
    expect(procs.length).toBeGreaterThan(5);
    for (const p of procs) {
      expect(p.pid).toBeGreaterThan(0);
      expect(p.name.length).toBeGreaterThan(0);
    }
  });

  it("includes our own process (vitest)", () => {
    const procs = listProcesses();
    const ownPid = process.pid;
    const me = procs.find((p) => p.pid === ownPid);
    expect(me).toBeDefined();
    expect(me?.name.length).toBeGreaterThan(0);
  });

  it("matches /proc entry count within reason", () => {
    const procs = listProcesses();
    const procEntries = readdirSync("/proc").filter((e) => /^\d+$/.test(e));
    // Some pids may have vanished between the two reads, but the count
    // should be in the same order of magnitude.
    expect(procs.length).toBeGreaterThanOrEqual(
      Math.floor(procEntries.length * 0.5),
    );
    expect(procs.length).toBeLessThanOrEqual(procEntries.length + 10);
  });
});

describe("process-list — parsePsOutput (darwin parser)", () => {
  it("parses canonical BSD ps output", () => {
    const fixture = `   1 launchd
 100 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow
 200 mds_stores
`;
    const parsed = parsePsOutput(fixture);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ pid: 1, name: "launchd" });
    // basename normalization strips the full path.
    expect(parsed[1]).toEqual({ pid: 100, name: "loginwindow" });
    expect(parsed[2]).toEqual({ pid: 200, name: "mds_stores" });
  });

  it("ignores blank lines and non-numeric pids", () => {
    expect(parsePsOutput("")).toEqual([]);
    expect(parsePsOutput("   \n   foo\n").length).toBe(0);
  });
});

describe("process-list — parseWindowsProcessJson", () => {
  it("parses an array of Get-Process rows", () => {
    const json = JSON.stringify([
      { Id: 1234, ProcessName: "explorer" },
      { Id: 5678, ProcessName: "chrome" },
    ]);
    expect(parseWindowsProcessJson(json)).toEqual([
      { pid: 1234, name: "explorer" },
      { pid: 5678, name: "chrome" },
    ]);
  });

  it("tolerates a single-object form", () => {
    const json = JSON.stringify({ Id: 1, ProcessName: "System" });
    expect(parseWindowsProcessJson(json)).toEqual([{ pid: 1, name: "System" }]);
  });

  it("returns [] for malformed input", () => {
    expect(parseWindowsProcessJson("not json")).toEqual([]);
  });
});
