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
} from "./power-state";

describe("parseXprintidleOutput", () => {
  it("converts milliseconds to seconds", () => {
    expect(parseXprintidleOutput("75000\n")).toBe(75);
  });

  it("uses the last non-empty line so stray warnings are tolerated", () => {
    expect(parseXprintidleOutput("warn: x11\n42000\n")).toBe(42);
  });

  it("returns null on non-numeric output", () => {
    expect(parseXprintidleOutput("no x display")).toBeNull();
  });
});

describe("parseLinuxLockedHintOutput", () => {
  it("parses `LockedHint=yes` as locked", () => {
    expect(parseLinuxLockedHintOutput("LockedHint=yes\n")).toBe(true);
  });

  it("parses `LockedHint=no` as not locked", () => {
    expect(parseLinuxLockedHintOutput("LockedHint=no\n")).toBe(false);
  });

  it("returns null when the hint is missing", () => {
    expect(parseLinuxLockedHintOutput("Id=12\nUser=1000")).toBeNull();
  });
});

describe("parseWindowsIdleTimeOutput", () => {
  it("converts milliseconds to seconds", () => {
    expect(parseWindowsIdleTimeOutput("120000")).toBe(120);
  });

  it("returns null for malformed output", () => {
    expect(parseWindowsIdleTimeOutput("error: access denied")).toBeNull();
  });
});

describe("parseWindowsLockStateOutput", () => {
  it("treats a non-zero logonui process count as locked", () => {
    expect(parseWindowsLockStateOutput("1")).toBe(true);
  });

  it("treats zero processes as unlocked", () => {
    expect(parseWindowsLockStateOutput("0")).toBe(false);
  });

  it("returns null for unparseable output", () => {
    expect(parseWindowsLockStateOutput("some error")).toBeNull();
  });
});

describe("existing macOS parsers still behave", () => {
  it("parses HID idle time", () => {
    expect(parseMacOsHidIdleTimeOutput('  "HIDIdleTime" = 5000000000'))
      .toBe(5);
  });
  it("parses session locked flag", () => {
    expect(
      parseMacOsSessionLockedOutput("CGSSessionScreenIsLocked=1"),
    ).toBe(true);
  });
  it("parses pmset power source", () => {
    expect(parseMacOsPowerSourceOutput("Now drawing from 'AC Power'")).toEqual({
      onBattery: false,
      known: true,
    });
  });
  it("parses windows power-line offline as on battery", () => {
    expect(parseWindowsPowerLineOutput("Offline")).toEqual({
      onBattery: true,
      known: true,
    });
  });
});
