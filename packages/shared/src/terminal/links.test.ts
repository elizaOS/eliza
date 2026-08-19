/**
 * Exercises OSC-8 terminal link formatting against control-byte injection and
 * verifies the non-TTY and documentation-link fallbacks.
 */
import { describe, expect, it } from "vitest";
import { formatDocsLink, formatTerminalLink } from "./links.ts";

describe("formatTerminalLink", () => {
  it("formats an OSC-8 hyperlink when forced", () => {
    expect(
      formatTerminalLink("Documentation", "https://docs.eliza.ai", {
        force: true,
      }),
    ).toBe(
      "\u001b]8;;https://docs.eliza.ai\u0007Documentation\u001b]8;;\u0007",
    );
  });

  it("removes ESC, BEL, remaining C0 bytes, and DEL from untrusted values", () => {
    const result = formatTerminalLink(
      "safe\u0007\u001b\n\u007f-label",
      "https://example.test/\u0007\u001b\r\u007f-path",
      { force: true },
    );

    expect(result).toBe(
      "\u001b]8;;https://example.test/-path\u0007safe-label\u001b]8;;\u0007",
    );
    expect(
      [...result]
        .map((character) => character.codePointAt(0))
        .filter((codePoint) => codePoint !== undefined && codePoint < 0x20),
    ).toEqual([0x1b, 0x07, 0x1b, 0x07]);
  });

  it("uses a readable non-TTY fallback", () => {
    expect(
      formatTerminalLink("Docs", "https://docs.eliza.ai", { force: false }),
    ).toBe("Docs (https://docs.eliza.ai)");
  });
});

describe("formatDocsLink", () => {
  it("resolves relative documentation paths", () => {
    expect(formatDocsLink("/guides/setup", undefined, { force: false })).toBe(
      "https://docs.eliza.ai/guides/setup",
    );
  });
});
