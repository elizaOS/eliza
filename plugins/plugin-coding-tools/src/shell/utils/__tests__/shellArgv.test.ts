import { describe, expect, it } from "vitest";
import { splitShellArgs } from "./shellArgv.ts";

describe("splitShellArgs", () => {
  it("splits simple commands", () => {
    expect(splitShellArgs("git commit -m")).toEqual(["git", "commit", "-m"]);
  });

  it("handles single quotes (literal)", () => {
    expect(splitShellArgs("echo 'hello world'")).toEqual([
      "echo",
      "hello world",
    ]);
  });

  it("handles double quotes", () => {
    expect(splitShellArgs('git commit -m "fix bug"')).toEqual([
      "git",
      "commit",
      "-m",
      "fix bug",
    ]);
  });

  it("handles backslash escapes outside quotes", () => {
    expect(splitShellArgs("path\\ with\\ spaces")).toEqual([
      "path with spaces",
    ]);
  });

  it("returns null for unclosed quotes and trailing escapes", () => {
    expect(splitShellArgs('"unclosed')).toBeNull();
    expect(splitShellArgs("'unclosed")).toBeNull();
    expect(splitShellArgs("trailing\\")).toBeNull();
  });

  it("collapses whitespace and handles empty input", () => {
    expect(splitShellArgs("  a   b  ")).toEqual(["a", "b"]);
    expect(splitShellArgs("")).toEqual([]);
  });

  it("preserves semicolons and metacharacters inside tokens", () => {
    expect(splitShellArgs("echo a;echo b")).toEqual(["echo", "a;echo", "b"]);
  });
});
