import { describe, expect, it } from "vitest";
import { matchViewCommand } from "./view-command-matcher";

describe("matchViewCommand guard", () => {
  it("returns null for non-string number", () => {
    expect(matchViewCommand(123 as unknown as string)).toBeNull();
  });

  it("returns null for non-string object", () => {
    expect(matchViewCommand({} as unknown as string)).toBeNull();
  });

  it("returns null for non-string null", () => {
    expect(matchViewCommand(null as unknown as string)).toBeNull();
  });

  it("returns null for non-string array", () => {
    expect(matchViewCommand([] as unknown as string)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(matchViewCommand(undefined as unknown as string)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(matchViewCommand("")).toBeNull();
  });

  it("rejects flag-prefixed view-like string", () => {
    expect(matchViewCommand("-settings")).toBeNull();
    expect(matchViewCommand("--open settings")).toBeNull();
  });

  it("still matches valid string command", () => {
    expect(matchViewCommand("open settings")).toBe("settings");
  });

  it("still matches with extra whitespace", () => {
    expect(matchViewCommand("  go to calendar  ")).toBe("calendar");
  });

  it("returns null for overly long input", () => {
    expect(matchViewCommand("a".repeat(161))).toBeNull();
  });

  it("returns null for numeric string that is not a view", () => {
    expect(matchViewCommand("12345")).toBeNull();
  });
});
