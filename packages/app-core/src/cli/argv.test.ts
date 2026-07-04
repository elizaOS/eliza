/**
 * CLI argv parsing. argv is [node, script, ...args]; the helpers must respect
 * the `--` terminator, support `--flag value` and `--flag=value`, and the
 * state-migration gate must skip read-only subcommands (health/status/agent).
 */
import { describe, expect, it } from "vitest";
import {
  getCommandPath,
  getFlagValue,
  getPositiveIntFlagValue,
  getPrimaryCommand,
  getVerboseFlag,
  hasFlag,
  hasHelpOrVersion,
  shouldMigrateState,
  shouldMigrateStateFromPath,
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

describe("flag values", () => {
  it("reads `--flag value` and `--flag=value`, null when valueless, undefined when absent", () => {
    expect(getFlagValue(cli("--port", "8080"), "--port")).toBe("8080");
    expect(getFlagValue(cli("--port=8080"), "--port")).toBe("8080");
    expect(getFlagValue(cli("--port"), "--port")).toBeNull(); // no value follows
    expect(getFlagValue(cli("start"), "--port")).toBeUndefined();
  });

  it("getPositiveIntFlagValue parses the value", () => {
    expect(getPositiveIntFlagValue(cli("--n", "5"), "--n")).toBe(5);
    expect(getPositiveIntFlagValue(cli("start"), "--n")).toBeUndefined();
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

describe("state-migration gate", () => {
  it("skips read-only subcommands, migrates otherwise", () => {
    expect(shouldMigrateStateFromPath([])).toBe(true);
    expect(shouldMigrateStateFromPath(["health"])).toBe(false);
    expect(shouldMigrateStateFromPath(["status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["agent"])).toBe(false);
    expect(shouldMigrateStateFromPath(["memory", "status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["memory", "list"])).toBe(true);
    expect(shouldMigrateStateFromPath(["start"])).toBe(true);
    expect(shouldMigrateState(cli("health"))).toBe(false);
    expect(shouldMigrateState(cli("start"))).toBe(true);
  });
});
