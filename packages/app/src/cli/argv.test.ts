/**
 * CLI argv parsing. argv is [node, script, ...args]; the helpers must respect
 * the `--` terminator when detecting flags and collecting the command path.
 */
import { describe, expect, it } from "vitest";
import {
  getCommandPath,
  getPrimaryCommand,
  getVerboseFlag,
  hasFlag,
  hasHelpOrVersion,
} from "./argv.js";

const cli = (...args: string[]): string[] => ["node", "eliza", ...args];

describe("flag presence", () => {
  it("hasHelpOrVersion / hasFlag honor flags and the -- terminator", () => {
    expect(hasHelpOrVersion(cli("--help"))).toBe(true);
    expect(hasHelpOrVersion(cli("-v"))).toBe(true);
    expect(hasHelpOrVersion(cli("run"))).toBe(false);
    expect(hasFlag(cli("--verbose"), "--verbose")).toBe(true);
    expect(hasFlag(cli("--", "--verbose"), "--verbose")).toBe(false); // after terminator
  });

  it("getVerboseFlag opts into --debug only when asked", () => {
    expect(getVerboseFlag(cli("--verbose"))).toBe(true);
    expect(getVerboseFlag(cli("--debug"))).toBe(false);
    expect(getVerboseFlag(cli("--debug"), { includeDebug: true })).toBe(true);
  });
});

describe("command path", () => {
  it("collects positional commands up to depth, skipping flags and --", () => {
    expect(getCommandPath(cli("agent", "start", "--flag"), 2)).toEqual([
      "agent",
      "start",
    ]);
    expect(getCommandPath(cli("--verbose", "db", "migrate"), 2)).toEqual([
      "db",
      "migrate",
    ]);
    expect(getCommandPath(cli("run", "--", "x"), 2)).toEqual(["run"]);
    expect(getPrimaryCommand(cli("start"))).toBe("start");
    expect(getPrimaryCommand(cli())).toBeFalsy();
  });
});
