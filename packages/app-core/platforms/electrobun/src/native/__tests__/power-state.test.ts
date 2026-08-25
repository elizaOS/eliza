/** Verifies desktop power and idle-state parsers with deterministic platform command output. */

import { describe, expect, it } from "vitest";
import {
  parseLinuxLockedHintOutput,
  parseMacOsHidIdleTimeOutput,
  parseMacOsPowerSourceOutput,
  parseMacOsSessionLockedOutput,
  parseWindowsIdleTimeOutput,
  parseWindowsLockStateOutput,
  parseWindowsPowerLineOutput,
  parseXprintidleOutput,
} from "../power-state.ts";

describe("parseWindowsPowerLineOutput", () => {
  it("parses Offline as on battery", () => {
    expect(parseWindowsPowerLineOutput("Offline")).toEqual({
      onBattery: true,
      known: true,
    });
  });

  it("parses Online and Unknown as AC", () => {
    expect(parseWindowsPowerLineOutput("Online")).toEqual({
      onBattery: false,
      known: true,
    });
    expect(parseWindowsPowerLineOutput("Unknown")).toEqual({
      onBattery: false,
      known: true,
    });
  });

  it("takes the last non-empty line and rejects garbage", () => {
    expect(parseWindowsPowerLineOutput("warning line\nOffline")).toEqual({
      onBattery: true,
      known: true,
    });
    expect(parseWindowsPowerLineOutput("garbage")).toEqual({
      onBattery: false,
      known: false,
    });
    expect(parseWindowsPowerLineOutput("")).toEqual({
      onBattery: false,
      known: false,
    });
  });
});

describe("parseMacOsPowerSourceOutput", () => {
  it("detects battery and AC power", () => {
    expect(
      parseMacOsPowerSourceOutput("Current Power Source: Battery Power"),
    ).toEqual({
      onBattery: true,
      known: true,
    });
    expect(
      parseMacOsPowerSourceOutput("Current Power Source: AC Power"),
    ).toEqual({
      onBattery: false,
      known: true,
    });
    expect(parseMacOsPowerSourceOutput("weird")).toEqual({
      onBattery: false,
      known: false,
    });
  });
});

describe("parseMacOsHidIdleTimeOutput", () => {
  it("parses HIDIdleTime ns to seconds", () => {
    expect(parseMacOsHidIdleTimeOutput('"HIDIdleTime" = 5000000000')).toBe(5);
  });

  it("returns null for missing or malformed output", () => {
    expect(parseMacOsHidIdleTimeOutput("nothing")).toBeNull();
    expect(parseMacOsHidIdleTimeOutput('"HIDIdleTime" = abc')).toBeNull();
  });
});

describe("parseMacOsSessionLockedOutput", () => {
  it("parses locked/unlocked", () => {
    expect(parseMacOsSessionLockedOutput("CGSSessionScreenIsLocked = 1")).toBe(
      true,
    );
    expect(parseMacOsSessionLockedOutput("screenIsLocked = 0")).toBe(false);
    expect(parseMacOsSessionLockedOutput("nothing")).toBeNull();
  });
});

describe("parseXprintidleOutput", () => {
  it("parses ms to seconds", () => {
    expect(parseXprintidleOutput("5000")).toBe(5);
    expect(parseXprintidleOutput("idle\n12345")).toBe(12);
  });

  it("returns null for garbage", () => {
    expect(parseXprintidleOutput("abc")).toBeNull();
    expect(parseXprintidleOutput("")).toBeNull();
    expect(parseXprintidleOutput("-1")).toBeNull();
    expect(parseXprintidleOutput("1.5")).toBeNull();
    expect(parseXprintidleOutput("9".repeat(400))).toBeNull();
  });
});

describe("parseLinuxLockedHintOutput", () => {
  it("parses yes/no and true/false", () => {
    expect(parseLinuxLockedHintOutput("LockedHint=yes")).toBe(true);
    expect(parseLinuxLockedHintOutput("LockedHint=no")).toBe(false);
    expect(parseLinuxLockedHintOutput("LockedHint=true")).toBe(true);
    expect(parseLinuxLockedHintOutput("LockedHint=false")).toBe(false);
    expect(parseLinuxLockedHintOutput("LockedHint=maybe")).toBeNull();
  });
});

describe("parseWindowsIdleTimeOutput", () => {
  it("parses ms to seconds", () => {
    expect(parseWindowsIdleTimeOutput("90000")).toBe(90);
  });

  it("returns null for garbage", () => {
    expect(parseWindowsIdleTimeOutput("nope")).toBeNull();
    expect(parseWindowsIdleTimeOutput("-1")).toBeNull();
    expect(parseWindowsIdleTimeOutput("1.5")).toBeNull();
    expect(parseWindowsIdleTimeOutput("9".repeat(400))).toBeNull();
  });
});

describe("parseWindowsLockStateOutput", () => {
  it("parses count as locked signal", () => {
    expect(parseWindowsLockStateOutput("1")).toBe(true);
    expect(parseWindowsLockStateOutput("0")).toBe(false);
    expect(parseWindowsLockStateOutput("abc")).toBeNull();
  });
});
