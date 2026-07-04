/**
 * Covers `isSafeExecutableValue`: it accepts bare executable names and explicit
 * paths while rejecting shell-metacharacter, flag-leading, and quoted values so
 * an executable string can never smuggle in a shell command. Uses fast-check to
 * fuzz that any injected metacharacter is always unsafe and that accepted bare
 * names match the documented `[A-Za-z0-9._+-]` (non-dash-leading) character set.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isSafeExecutableValue } from "./exec-safety";

describe("isSafeExecutableValue", () => {
  it.each([
    "bun",
    "node",
    "python3.12",
    "eliza-cli",
    "tool_name",
    "tool+debug",
    "/usr/local/bin/bun",
    "./scripts/run-task",
    "../bin/tool",
    "~/bin/tool",
    "C:\\Program Files\\Eliza\\eliza.exe",
  ])("accepts bare executable names and explicit paths: %s", (value) => {
    expect(isSafeExecutableValue(value)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "-rf",
    "--help",
    "bun --version",
    "bun; rm -rf /",
    "bun && whoami",
    "bun | cat",
    "bun`whoami`",
    "bun $(whoami)",
    "bun\nwhoami",
    "bun\rwhoami",
    "bun\0whoami",
    "'bun'",
    '"bun"',
    "<script>",
    "/tmp/tool --flag",
    "/usr/bin/env node",
    "./run task --verbose",
    "C:\\Tools\\node.exe --version",
  ])("rejects shell-like executable values: %s", (value) => {
    expect(isSafeExecutableValue(value)).toBe(false);
  });

  it("fuzzes dangerous shell metacharacters as always unsafe", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.constantFrom(
          "\0",
          "\r",
          "\n",
          ";",
          "&",
          "|",
          "`",
          "$",
          "<",
          ">",
          '"',
          "'",
        ),
        fc.string({ maxLength: 40 }),
        (left, marker, right) => {
          const value = `${left}${marker}${right}`;
          fc.pre(value.trim().includes(marker));

          expect(isSafeExecutableValue(value)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("fuzzes accepted bare names to the documented character set", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (value) => {
        fc.pre(value.trim() === value);
        fc.pre(value.length > 0);
        fc.pre(!value.includes("/") && !value.includes("\\"));
        fc.pre(!value.startsWith(".") && !value.startsWith("~"));

        const accepted = isSafeExecutableValue(value);
        expect(accepted).toBe(
          /^[A-Za-z0-9._+-]+$/.test(value) && !value.startsWith("-"),
        );
      }),
      { numRuns: 500 },
    );
  });
});
