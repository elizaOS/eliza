/**
 * Shell auto-approval guard tests for safe binary usage.
 * They pin the security boundary that only allowlisted executables without path-like or existing-file arguments may be auto-approved.
 */

import { describe, expect, it } from "vitest";
import { isSafeBinUsage, normalizeSafeBins } from "../approvals/analysis";
import type { CommandResolution } from "../approvals/types";

const res = (
  executableName: string,
  resolvedPath: string | undefined = `/usr/bin/${executableName}`
): CommandResolution => ({ rawExecutable: executableName, resolvedPath, executableName });
const noFiles = () => false;

describe("normalizeSafeBins", () => {
  it("trims, lowercases, drops empties, and dedups", () => {
    expect([...normalizeSafeBins([" LS ", "ls", "", "  ", "Cat"])].sort()).toEqual(["cat", "ls"]);
  });
  it("returns an empty set for non-array input", () => {
    expect(normalizeSafeBins(undefined).size).toBe(0);
  });
});

describe("isSafeBinUsage", () => {
  const safeBins = normalizeSafeBins(["ls", "cat"]);

  it("refuses when the safe-bin set is empty", () => {
    expect(
      isSafeBinUsage({
        argv: ["ls"],
        resolution: res("ls"),
        safeBins: new Set(),
        fileExists: noFiles,
      })
    ).toBe(false);
  });

  it("refuses a non-allowlisted executable", () => {
    expect(
      isSafeBinUsage({ argv: ["rm", "-rf"], resolution: res("rm"), safeBins, fileExists: noFiles })
    ).toBe(false);
  });

  it("refuses when the executable has no resolved path", () => {
    const unresolved: CommandResolution = { rawExecutable: "ls", executableName: "ls" };
    expect(
      isSafeBinUsage({ argv: ["ls"], resolution: unresolved, safeBins, fileExists: noFiles })
    ).toBe(false);
  });

  it("approves an allowlisted bin with only flags", () => {
    expect(
      isSafeBinUsage({
        argv: ["ls", "-la", "--color"],
        resolution: res("ls"),
        safeBins,
        fileExists: noFiles,
      })
    ).toBe(true);
  });

  it("refuses a path-like positional argument", () => {
    expect(
      isSafeBinUsage({
        argv: ["cat", "/etc/passwd"],
        resolution: res("cat"),
        safeBins,
        fileExists: noFiles,
      })
    ).toBe(false);
  });

  it("refuses a positional that names an existing file", () => {
    expect(
      isSafeBinUsage({
        argv: ["cat", "secrets"],
        resolution: res("cat"),
        safeBins,
        cwd: "/work",
        fileExists: () => true,
      })
    ).toBe(false);
  });

  it("refuses a --flag=<path> value", () => {
    expect(
      isSafeBinUsage({
        argv: ["ls", "--width=/etc/passwd"],
        resolution: res("ls"),
        safeBins,
        fileExists: noFiles,
      })
    ).toBe(false);
  });

  it("approves a non-path positional that does not exist", () => {
    expect(
      isSafeBinUsage({
        argv: ["ls", "subcmd"],
        resolution: res("ls"),
        safeBins,
        fileExists: noFiles,
      })
    ).toBe(true);
  });
});
