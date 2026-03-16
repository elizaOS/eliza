import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getFlagValue,
  getCommandPath,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasHelpOrVersion,
  hasFlag,
  shouldMigrateState,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it("detects help/version flags", () => {
    expect(hasHelpOrVersion(["node", "milaidy", "--help"])).toBe(true);
    expect(hasHelpOrVersion(["node", "milaidy", "-V"])).toBe(true);
    expect(hasHelpOrVersion(["node", "milaidy", "config"])).toBe(false);
  });

  it("extracts command path ignoring flags and terminator", () => {
    expect(getCommandPath(["node", "milaidy", "config", "--json"], 2)).toEqual(["config"]);
    expect(getCommandPath(["node", "milaidy", "agents", "list"], 2)).toEqual(["agents", "list"]);
    expect(getCommandPath(["node", "milaidy", "config", "--", "ignored"], 2)).toEqual(["config"]);
  });

  it("returns primary command", () => {
    expect(getPrimaryCommand(["node", "milaidy", "agents", "list"])).toBe("agents");
    expect(getPrimaryCommand(["node", "milaidy"])).toBeNull();
  });

  it("parses boolean flags and ignores terminator", () => {
    expect(hasFlag(["node", "milaidy", "config", "--json"], "--json")).toBe(true);
    expect(hasFlag(["node", "milaidy", "--", "--json"], "--json")).toBe(false);
  });

  it("extracts flag values with equals and missing values", () => {
    expect(getFlagValue(["node", "milaidy", "config", "--timeout", "5000"], "--timeout")).toBe(
      "5000",
    );
    expect(getFlagValue(["node", "milaidy", "config", "--timeout=2500"], "--timeout")).toBe(
      "2500",
    );
    expect(getFlagValue(["node", "milaidy", "config", "--timeout"], "--timeout")).toBeNull();
    expect(getFlagValue(["node", "milaidy", "config", "--timeout", "--json"], "--timeout")).toBe(
      null,
    );
    expect(getFlagValue(["node", "milaidy", "--", "--timeout=99"], "--timeout")).toBeUndefined();
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "milaidy", "config", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "milaidy", "config", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "milaidy", "config", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it("parses positive integer flag values", () => {
    expect(getPositiveIntFlagValue(["node", "milaidy", "config"], "--timeout")).toBeUndefined();
    expect(
      getPositiveIntFlagValue(["node", "milaidy", "config", "--timeout"], "--timeout"),
    ).toBeNull();
    expect(
      getPositiveIntFlagValue(["node", "milaidy", "config", "--timeout", "5000"], "--timeout"),
    ).toBe(5000);
    expect(
      getPositiveIntFlagValue(["node", "milaidy", "config", "--timeout", "nope"], "--timeout"),
    ).toBeUndefined();
  });

  it("builds parse argv from raw args", () => {
    const nodeArgv = buildParseArgv({
      programName: "milaidy",
      rawArgs: ["node", "milaidy", "config"],
    });
    expect(nodeArgv).toEqual(["node", "milaidy", "config"]);

    const versionedNodeArgv = buildParseArgv({
      programName: "milaidy",
      rawArgs: ["node-22", "milaidy", "config"],
    });
    expect(versionedNodeArgv).toEqual(["node-22", "milaidy", "config"]);

    const versionedNodeWindowsArgv = buildParseArgv({
      programName: "milaidy",
      rawArgs: ["node-22.2.0.exe", "milaidy", "config"],
    });
    expect(versionedNodeWindowsArgv).toEqual(["node-22.2.0.exe", "milaidy", "config"]);

    const versionedNodePatchlessArgv = buildParseArgv({
      programName: "milaidy",
      rawArgs: ["node-22.2", "milaidy", "config"],
    });
    expect(versionedNodePatchlessArgv).toEqual(["node-22.2", "milaidy", "config"]);

    const versionedNodeWindowsPatchlessArgv = buildParseArgv({
      programName: "milaidy",
      rawArgs: ["node-22.2.exe", "milaidy", "config"],
    });
    expect(versionedNodeWindowsPatchlessArgv).toEqual(["node-22.2.exe", "milaidy", "config"]);

    const versionedNodeWithPathArgv = buildParseArgv({
      programName: "milaidy",
      rawArgs: ["/usr/bin/node-22.2.0", "milaidy", "config"],
    });
    expect(versionedNodeWithPathArgv).toEqual(["/usr/bin/node-22.2.0", "milaidy", "config"]);

    const nodejsArgv = buildParseArgv({
      programName: "milaidy",
      rawArgs: ["nodejs", "milaidy", "config"],
    });
    expect(nodejsArgv).toEqual(["nodejs", "milaidy", "config"]);

    const nonVersionedNodeArgv = buildParseArgv({
      programName: "milaidy",
      rawArgs: ["node-dev", "milaidy", "config"],
    });
    expect(nonVersionedNodeArgv).toEqual(["node", "milaidy", "node-dev", "milaidy", "config"]);

    const directArgv = buildParseArgv({
      programName: "milaidy",
      rawArgs: ["milaidy", "config"],
    });
    expect(directArgv).toEqual(["node", "milaidy", "config"]);

    const bunArgv = buildParseArgv({
      programName: "milaidy",
      rawArgs: ["bun", "src/entry.ts", "config"],
    });
    expect(bunArgv).toEqual(["bun", "src/entry.ts", "config"]);
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "milaidy",
      fallbackArgv: ["config"],
    });
    expect(fallbackArgv).toEqual(["node", "milaidy", "config"]);
  });

  it("decides when to migrate state", () => {
    expect(shouldMigrateState(["node", "milaidy", "memory", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "milaidy", "agent", "--message", "hi"])).toBe(false);
    expect(shouldMigrateState(["node", "milaidy", "agents", "list"])).toBe(true);
    expect(shouldMigrateState(["node", "milaidy", "message", "send"])).toBe(true);
  });

  it("reuses command path for migrate state decisions", () => {
    expect(shouldMigrateStateFromPath(["agents", "list"])).toBe(true);
  });
});
