/**
 * Unit tests for the device freshness status policy. Hardware probing is
 * exercised by the device lanes; these tests pin the verdicts and table output
 * that make stale installs machine-readable.
 */
import { describe, expect, it } from "vitest";
import {
  buildDeviceStatusRow,
  formatDeviceStatusTable,
  hasNonFreshDevice,
  rendererStampVerdict,
  sameCommit,
} from "./lib/devices-status.mjs";

describe("devices-status policy", () => {
  it("matches full and short shas in either direction", () => {
    expect(sameCommit("abcdef1234567890", "abcdef123456")).toBe(true);
    expect(sameCommit("abcdef123456", "abcdef1234567890")).toBe(true);
    expect(sameCommit("111111", "222222")).toBe(false);
  });

  it("marks matching installed commits fresh", () => {
    expect(
      rendererStampVerdict({
        stamp: { buildId: "b", commit: "abcdef1234567890" },
        developHead: "abcdef1234567890",
      }),
    ).toEqual({
      verdict: "FRESH",
      reason: "installed commit matches develop",
    });
  });

  it("marks mismatched installed commits stale", () => {
    expect(
      rendererStampVerdict({
        stamp: { buildId: "b", commit: "111111111111" },
        developHead: "222222222222",
      }),
    ).toMatchObject({
      verdict: "STALE",
      reason: expect.stringContaining("111111111111 != develop 222222222222"),
    });
  });

  it("marks missing stamps unknown", () => {
    expect(rendererStampVerdict({ stamp: null, developHead: "abc" })).toEqual({
      verdict: "UNKNOWN",
      reason: "no installed renderer stamp",
    });
  });

  it("ignores host-unavailable n/a rows for require-fresh", () => {
    const rows = [
      buildDeviceStatusRow({
        platform: "ios-sim",
        id: "simctl",
        name: "iOS simulator n/a",
        kind: "n/a",
        stamp: null,
        developHead: "abc",
        source: "not macOS",
      }),
    ];
    expect(hasNonFreshDevice(rows)).toBe(false);
  });

  it("formats a reviewer-readable table", () => {
    const row = buildDeviceStatusRow({
      platform: "android",
      id: "emulator-5554",
      name: "emulator-5554",
      kind: "emulator",
      stamp: { buildId: "buildabcdef", commit: "abcdef1234567890" },
      developHead: "abcdef1234567890",
      source: "adb",
      lease: { pid: 42, sessionId: "runner" },
    });
    expect(formatDeviceStatusTable([row])).toContain("emulator-5554");
    expect(formatDeviceStatusTable([row])).toContain("FRESH");
    expect(formatDeviceStatusTable([row])).toContain("pid 42");
  });
});
