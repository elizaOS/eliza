import { describe, expect, it } from "vitest";
import { isSafeExecutableValue } from "./exec-safety.js";

describe("isSafeExecutableValue", () => {
  describe("rejects null, undefined, empty, and whitespace-only", () => {
    it.each([null, undefined, "", "   ", "\t\n"])("rejects %j", (input) => {
      expect(isSafeExecutableValue(input)).toBe(false);
    });
  });

  describe("rejects shell metacharacters and control chars", () => {
    it.each([
      "echo; rm -rf /",
      "cmd & whoami",
      "a | b",
      "$(evil)",
      "foo`bar`",
      "cat < /etc/passwd",
      "x > /dev/null",
      'name"quoted"',
      "name'quoted'",
      "has\nnewline",
      "has\rcarriage",
      "has\0null",
    ])("rejects %j", (input) => {
      expect(isSafeExecutableValue(input)).toBe(false);
    });
  });

  describe("rejects values starting with dashes", () => {
    it.each(["--help", "-rf", "--version"])("rejects %j", (input) => {
      expect(isSafeExecutableValue(input)).toBe(false);
    });
  });

  describe("accepts safe bare executable names", () => {
    it.each(["python3", "node", "ffmpeg", "my-tool", "my_tool", "my.tool", "tool+extra", "a"])(
      "accepts %j",
      (input) => {
        expect(isSafeExecutableValue(input)).toBe(true);
      },
    );
  });

  describe("accepts path-like values", () => {
    it.each([
      "/usr/bin/python3",
      "/usr/local/bin/node",
      "./local-script",
      "../bin/tool",
      "~/bin/custom",
      "subdir/tool",
    ])("accepts %j", (input) => {
      expect(isSafeExecutableValue(input)).toBe(true);
    });
  });

  describe("accepts Windows-style paths", () => {
    it.each([
      "C:\\Program Files\\tool.exe",
      "D:\\bin\\node.exe",
      ".\\local\\script.bat",
      "sub\\dir\\tool",
    ])("accepts %j", (input) => {
      expect(isSafeExecutableValue(input)).toBe(true);
    });
  });

  it("trims leading/trailing whitespace before validation", () => {
    expect(isSafeExecutableValue("  node  ")).toBe(true);
    expect(isSafeExecutableValue("  /usr/bin/python  ")).toBe(true);
  });

  describe("rejects bare names with invalid characters", () => {
    it.each(["name with space", "hello world", "foo@bar", "x#y", "a%b"])(
      "rejects %j",
      (input) => {
        expect(isSafeExecutableValue(input)).toBe(false);
      },
    );
  });
});
