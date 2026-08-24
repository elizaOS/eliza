/**
 * Unit tests for shellArgv: validates POSIX/Windows shell argument tokenizer.
 */
import { describe, expect, it } from "vitest";
import { splitShellArgs } from "./shellArgv.ts";

describe("splitShellArgs", () => {
  it("splits basic whitespace-separated arguments", () => {
    expect(splitShellArgs("git commit -m msg")).toEqual([
      "git",
      "commit",
      "-m",
      "msg",
    ]);
    expect(splitShellArgs("   npm   run   build   ")).toEqual([
      "npm",
      "run",
      "build",
    ]);
  });

  it("preserves spaces inside single quotes", () => {
    expect(splitShellArgs("echo 'hello world'")).toEqual([
      "echo",
      "hello world",
    ]);
    expect(splitShellArgs("cmd 'foo bar' 'baz qux'")).toEqual([
      "cmd",
      "foo bar",
      "baz qux",
    ]);
  });

  it("preserves spaces inside double quotes", () => {
    expect(splitShellArgs('git commit -m "fix bug in parser"')).toEqual([
      "git",
      "commit",
      "-m",
      "fix bug in parser",
    ]);
  });

  it("handles backslash escapes outside quotes", () => {
    expect(splitShellArgs("path\\ with\\ spaces/file.txt")).toEqual([
      "path with spaces/file.txt",
    ]);
    expect(splitShellArgs('echo escaped\\"quote')).toEqual([
      "echo",
      'escaped"quote',
    ]);
  });

  it("returns null for unclosed quotes and trailing escapes", () => {
    expect(splitShellArgs('"unclosed double quote')).toBeNull();
    expect(splitShellArgs("'unclosed single quote")).toBeNull();
    expect(splitShellArgs("trailing escape\\")).toBeNull();
  });

  it("handles empty and whitespace-only strings", () => {
    expect(splitShellArgs("")).toEqual([]);
    expect(splitShellArgs("   \t\n  ")).toEqual([]);
  });
});
