import { describe, expect, test } from "vitest";

import { splitShellArgs } from "./shellArgv";

describe("splitShellArgs", () => {
  test("splits simple whitespace-separated args", () => {
    expect(splitShellArgs("git status")).toEqual(["git", "status"]);
    expect(splitShellArgs("a b c")).toEqual(["a", "b", "c"]);
    expect(splitShellArgs("  a   b  ")).toEqual(["a", "b"]);
    expect(splitShellArgs("")).toEqual([]);
    expect(splitShellArgs("   ")).toEqual([]);
  });

  test("handles single quotes as literal", () => {
    expect(splitShellArgs("echo 'hello world'")).toEqual([
      "echo",
      "hello world",
    ]);
    expect(splitShellArgs("'single' 'two words'")).toEqual([
      "single",
      "two words",
    ]);
    expect(splitShellArgs("cmd 'a b' c")).toEqual(["cmd", "a b", "c"]);
  });

  test("handles double quotes as literal", () => {
    expect(splitShellArgs('git commit -m "fix bug"')).toEqual([
      "git",
      "commit",
      "-m",
      "fix bug",
    ]);
    expect(splitShellArgs('"hello world"')).toEqual(["hello world"]);
    expect(splitShellArgs('a "b c" d')).toEqual(["a", "b c", "d"]);
  });

  test("handles backslash escapes outside quotes", () => {
    expect(splitShellArgs("path\\ with\\ spaces")).toEqual([
      "path with spaces",
    ]);
    expect(splitShellArgs("echo hello\\ world")).toEqual([
      "echo",
      "hello world",
    ]);
    expect(splitShellArgs("a\\ b c")).toEqual(["a b", "c"]);
  });

  test("backslash inside single quotes is literal", () => {
    expect(splitShellArgs("'a\\b'")).toEqual(["a\\b"]);
    expect(splitShellArgs("'a\\'b'")).toBeNull();
  });

  test("backslash inside double quotes is literal", () => {
    expect(splitShellArgs('"a\\b"')).toEqual(["a\\b"]);
    expect(splitShellArgs('"a\\n"')).toEqual(["a\\n"]);
  });

  test("handles mixed quotes and escapes", () => {
    expect(splitShellArgs(`cmd 'single "nested"' "double 'nested'"`)).toEqual([
      "cmd",
      'single "nested"',
      "double 'nested'",
    ]);
  });

  test("returns null for unclosed single quote", () => {
    expect(splitShellArgs("'unclosed")).toBeNull();
    expect(splitShellArgs("a 'b c")).toBeNull();
  });

  test("returns null for unclosed double quote", () => {
    expect(splitShellArgs('"unclosed')).toBeNull();
    expect(splitShellArgs('a "b c')).toBeNull();
  });

  test("returns null for trailing escape", () => {
    expect(splitShellArgs("abc\\")).toBeNull();
    expect(splitShellArgs("a b\\")).toBeNull();
  });

  test("handles empty quotes as empty token skipped", () => {
    expect(splitShellArgs("a '' b")).toEqual(["a", "b"]);
    expect(splitShellArgs('a "" b')).toEqual(["a", "b"]);
    expect(splitShellArgs("''")).toEqual([]);
  });

  test("handles tab and newline as separators", () => {
    expect(splitShellArgs("a\tb\nc")).toEqual(["a", "b", "c"]);
    expect(splitShellArgs("a \t b")).toEqual(["a", "b"]);
  });
});
