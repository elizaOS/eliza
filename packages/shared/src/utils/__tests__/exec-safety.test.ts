import { describe, expect, it } from "vitest";
import { isSafeExecutableValue } from "./exec-safety.ts";

describe("isSafeExecutableValue", () => {
  it("rejects shell metacharacters", () => {
    for (const bad of [
      "ls; rm -rf /",
      "echo $(whoami)",
      "cat /etc/passwd | grep root",
      "foo&bar",
      "a`b",
      "a<b",
      "a>b",
      'a"b',
      "a'b",
      "a\nb",
      "a\u0000b",
    ]) {
      expect(isSafeExecutableValue(bad)).toBe(false);
    }
  });

  it("rejects non-string values and empty strings", () => {
    expect(isSafeExecutableValue(42)).toBe(false);
    expect(isSafeExecutableValue(null)).toBe(false);
    expect(isSafeExecutableValue(undefined)).toBe(false);
    expect(isSafeExecutableValue({})).toBe(false);
    expect(isSafeExecutableValue("")).toBe(false);
    expect(isSafeExecutableValue("   ")).toBe(false);
  });

  it("rejects flag-like and command-with-args shapes", () => {
    expect(isSafeExecutableValue("-rf")).toBe(false);
    expect(isSafeExecutableValue("--force")).toBe(false);
    expect(isSafeExecutableValue("git commit -m x")).toBe(false);
  });

  it("accepts bare names and paths", () => {
    expect(isSafeExecutableValue("ffmpeg")).toBe(true);
    expect(isSafeExecutableValue("python3.12")).toBe(true);
    expect(isSafeExecutableValue("./scripts/run.sh")).toBe(true);
    expect(isSafeExecutableValue("/usr/bin/env")).toBe(true);
    expect(isSafeExecutableValue("~/bin/tool")).toBe(true);
    expect(isSafeExecutableValue("C:\\tools\\ffmpeg.exe")).toBe(true);
  });
});
