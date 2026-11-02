/**
 * Command-path extraction when a global flag value precedes the command.
 *
 * The CLI accepts `--profile <name>` before the command (the profile
 * scanner in profile.ts consumes its value). `getCommandPath` used to
 * skip flag tokens but not their values, so the profile name itself was
 * read as the command: `eliza --profile work start` classified as the
 * one-shot command "work", which made run-main install the fail-fast
 * error handlers for a long-running server command (a background
 * rejection then exits the server instead of hitting the crash guards),
 * and made the pre-action hook miss the banner suppression for
 * `eliza --profile work update`.
 */

import { describe, expect, it } from "vitest";
import { getCommandPath, getPrimaryCommand } from "./argv";

function argv(...args: string[]): string[] {
  return ["node", "eliza", ...args];
}

describe("getPrimaryCommand with pre-command flags", () => {
  it("reads a bare command", () => {
    expect(getPrimaryCommand(argv("start"))).toBe("start");
  });

  it("reads the command after a boolean global flag", () => {
    expect(getPrimaryCommand(argv("--dev", "start"))).toBe("start");
  });

  it("reads the command after the =-form of --profile", () => {
    expect(getPrimaryCommand(argv("--profile=work", "start"))).toBe("start");
  });

  it("reads the command after the space form of --profile", () => {
    expect(getPrimaryCommand(argv("--profile", "work", "start"))).toBe("start");
  });

  it("reads an update command after the space form of --profile", () => {
    expect(getPrimaryCommand(argv("--profile", "work", "update"))).toBe(
      "update",
    );
  });

  it("stops at the -- terminator", () => {
    expect(getPrimaryCommand(argv("--", "start")) ?? null).toBeNull();
  });
});

describe("getCommandPath with pre-command flags", () => {
  it("returns the two-level path after the space form of --profile", () => {
    expect(getCommandPath(argv("--profile", "work", "update"), 2)).toEqual([
      "update",
    ]);
  });

  it("keeps subcommand tokens after the command", () => {
    expect(getCommandPath(argv("agent", "start"), 2)).toEqual([
      "agent",
      "start",
    ]);
  });
});
