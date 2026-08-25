/**
 * Behavioral coverage for stripSystemReminderBlocks — the transport-metadata
 * strip that prevents <system-reminder> blocks from leaking into user-facing
 * replies (#16941). The function must remove every such block end-to-end
 * without touching surrounding text.
 */
import { describe, expect, it } from "vitest";
import { stripSystemReminderBlocks } from "../claude-cli";

describe("stripSystemReminderBlocks", () => {
  it("removes a single closed block and keeps surrounding text", () => {
    expect(
      stripSystemReminderBlocks(
        "On it.\n<system-reminder> Return exactly one JSON object </system-reminder>Done"
      )
    ).toBe("On it.\nDone");
  });

  it("removes multiple blocks in one string", () => {
    expect(
      stripSystemReminderBlocks(
        "a<system-reminder> one </system-reminder>b<system-reminder> two </system-reminder>c"
      )
    ).toBe("abc");
  });

  it("removes an unclosed block through end of string (harness injects without close)", () => {
    expect(
      stripSystemReminderBlocks("hello <system-reminder> Return exactly one JSON object ")
    ).toBe("hello ");
    expect(stripSystemReminderBlocks("prefix <system-reminder>trailing")).toBe("prefix ");
  });

  it("leaves text without any reminder untouched (including similar tags)", () => {
    expect(stripSystemReminderBlocks("hello world")).toBe("hello world");
    expect(stripSystemReminderBlocks("<system> not a reminder </system>")).toBe(
      "<system> not a reminder </system>"
    );
    expect(stripSystemReminderBlocks("")).toBe("");
  });

  it("handles block at start and end boundaries", () => {
    expect(stripSystemReminderBlocks("<system-reminder>block</system-reminder>")).toBe("");
    expect(stripSystemReminderBlocks("<system-reminder>block")).toBe("");
    expect(stripSystemReminderBlocks("prefix <system-reminder>block</system-reminder>")).toBe(
      "prefix "
    );
  });

  it("removes block spanning newlines and preserves other newlines", () => {
    const input = "before\n<system-reminder>\nmultiline\ncontent\n</system-reminder>\nafter";
    expect(stripSystemReminderBlocks(input)).toBe("before\n\nafter");
  });

  it("is not tricked by nested or partial markers", () => {
    expect(
      stripSystemReminderBlocks("a <system-reminder> b <system-reminder> c </system-reminder> d")
    ).toBe("a  d");
  });
});
