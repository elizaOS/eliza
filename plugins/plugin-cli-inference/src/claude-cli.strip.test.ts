/**
 * Unit tests for stripSystemReminderBlocks — the pure helper that removes
 * Claude Code harness <system-reminder> blocks from CLI stdout before the
 * runtime ever sees the text (#16941). The harness can echo a block verbatim
 * or leave an unterminated tail when the stream is cut; both must be stripped
 * so they never reach the agent's reply synthesis or planner routing.
 */

import { describe, expect, it } from "vitest";
import { stripSystemReminderBlocks } from "./claude-cli.ts";

describe("stripSystemReminderBlocks", () => {
  it("strips a single complete block", () => {
    expect(
      stripSystemReminderBlocks(
        "On it. <system-reminder> Return exactly one JSON object. </system-reminder> done."
      )
    ).toBe("On it.  done.");
  });

  it("strips an unterminated tail (harness cut mid-block)", () => {
    expect(stripSystemReminderBlocks("Done.\n<system-reminder> truncated harness")).toBe("Done.\n");
  });

  it("strips multiple blocks in one string", () => {
    expect(
      stripSystemReminderBlocks(
        "a <system-reminder>one</system-reminder> b <system-reminder>two</system-reminder> c"
      )
    ).toBe("a  b  c");
  });

  it("strips a block at the start and at the end", () => {
    expect(
      stripSystemReminderBlocks(
        "<system-reminder>start</system-reminder>middle<system-reminder>end"
      )
    ).toBe("middle");
  });

  it("returns empty string for empty input", () => {
    expect(stripSystemReminderBlocks("")).toBe("");
  });

  it("leaves text without any block untouched", () => {
    expect(stripSystemReminderBlocks("hello world. no reminders here")).toBe(
      "hello world. no reminders here"
    );
  });

  it("strips a block that contains newlines and special chars", () => {
    expect(
      stripSystemReminderBlocks(
        "pre\n<system-reminder>\n line1 \n line2 \n</system-reminder>\npost"
      )
    ).toBe("pre\n\npost");
  });

  it("does not strip a similar-looking tag with different name", () => {
    expect(stripSystemReminderBlocks("a <system-reminderX>not stripped</system-reminderX> b")).toBe(
      "a <system-reminderX>not stripped</system-reminderX> b"
    );
  });
});
