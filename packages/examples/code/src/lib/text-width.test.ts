// @vitest-environment node
//
// #11294: padEndVisible pads to VISIBLE width, ignoring ANSI SGR — the fix for
// box-border misalignment (TaskPane/ChatPane padded chalk-colored strings with
// String.padEnd, which counts invisible escape bytes → under-padded → the right
// │ border collapsed inward on every styled row).

import { describe, expect, it } from "bun:test";
import chalk from "chalk";
import { padEndVisible } from "./text-width.js";

describe("padEndVisible (#11294)", () => {
  it("pads a plain string exactly like padEnd", () => {
    expect(padEndVisible("hi", 5)).toBe("hi   ");
  });

  it("pads a chalk-colored string to its VISIBLE width, not raw length", () => {
    const prev = chalk.level;
    chalk.level = 3; // force SGR codes
    try {
      const colored = chalk.cyan("hi"); // visible width 2, raw length ~11
      const padded = padEndVisible(colored, 5);
      // Ends with exactly 3 spaces (5 - 2 visible), NOT fewer.
      expect(padded.endsWith("   ")).toBe(true);
      // The SGR prefix is preserved (still colored).
      expect(padded.startsWith(colored)).toBe(true);
      // String.padEnd would have added ZERO spaces here (raw length already > 5).
      expect(colored.padEnd(5)).toBe(colored);
      expect(padded).not.toBe(colored);
    } finally {
      chalk.level = prev;
    }
  });

  it("returns the string unchanged when it already meets/exceeds the target", () => {
    expect(padEndVisible("hello", 3)).toBe("hello");
    expect(padEndVisible("abc", 3)).toBe("abc");
  });
});
