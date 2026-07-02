/**
 * Unit tests for the shared relay sanitizer (issue elizaOS/eliza#11578).
 *
 * The swarm-synthesis relay path posted sub-agent finalText VERBATIM to the
 * connector, leaking the orchestrator's own `[tool output: …]` envelope blocks
 * to the user. This module centralizes stripping them; these tests pin the
 * robustness cases (empty titles, unterminated blocks, multiple blocks, long
 * remnants) that the router-private copy did not cover.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_RELAY_CHARS,
  elideLongBlocks,
  sanitizeCompletionRelay,
  stripToolTranscript,
} from "../../src/services/transcript-sanitizer.ts";

describe("stripToolTranscript", () => {
  it("strips a normal well-formed envelope block, keeping prose", () => {
    const input =
      "Done building the app.\n" +
      "[tool output: bash]\n$ ls\nfile.txt\n[/tool output]\n" +
      "All set.";
    const out = stripToolTranscript(input);
    expect(out).toContain("Done building the app.");
    expect(out).toContain("All set.");
    expect(out).not.toContain("[tool output:");
    expect(out).not.toContain("[/tool output]");
    expect(out).not.toContain("file.txt");
  });

  it("strips an empty-title envelope block", () => {
    const input =
      'prefix\n[tool output: ""]\nsecret body\n[/tool output]\nsuffix';
    const out = stripToolTranscript(input);
    expect(out).toContain("prefix");
    expect(out).toContain("suffix");
    expect(out).not.toContain("secret body");
    expect(out).not.toContain("tool output");
  });

  it("strips a bare-colon empty-title envelope block", () => {
    const input = "a\n[tool output:]\nbody\n[/tool output]\nb";
    const out = stripToolTranscript(input);
    expect(out).toBe("a\n\nb");
  });

  it("strips MULTIPLE envelope blocks", () => {
    const input =
      "start\n" +
      "[tool output: one]\naaa\n[/tool output]\n" +
      "middle\n" +
      "[tool output: two]\nbbb\n[/tool output]\n" +
      "end";
    const out = stripToolTranscript(input);
    expect(out).toContain("start");
    expect(out).toContain("middle");
    expect(out).toContain("end");
    expect(out).not.toContain("aaa");
    expect(out).not.toContain("bbb");
    expect(out).not.toContain("[tool output:");
  });

  it("strips an UNTERMINATED trailing block to end of string", () => {
    const input =
      "here is the result\n[tool output: truncated]\nhalf a body that never closes";
    const out = stripToolTranscript(input);
    expect(out).toBe("here is the result");
    expect(out).not.toContain("[tool output:");
    expect(out).not.toContain("half a body");
  });

  it("preserves prose and plain URLs", () => {
    const input =
      "PR opened: https://github.com/elizaos/eliza/pull/123 — see the diff.";
    const out = stripToolTranscript(input);
    expect(out).toBe(input.trim());
    expect(out).toContain("https://github.com/elizaos/eliza/pull/123");
  });

  it("returns empty string for empty input", () => {
    expect(stripToolTranscript("")).toBe("");
  });
});

describe("elideLongBlocks", () => {
  it("passes short text through unchanged", () => {
    expect(elideLongBlocks("short", 2000)).toBe("short");
  });

  it("elides a remnant over the cap into a length marker", () => {
    const big = "x".repeat(DEFAULT_MAX_RELAY_CHARS + 500);
    const out = elideLongBlocks(big);
    expect(out).toBe(`[output elided — ${big.length} chars]`);
    expect(out.length).toBeLessThan(60);
  });

  it("keeps text exactly at the cap", () => {
    const exact = "y".repeat(DEFAULT_MAX_RELAY_CHARS);
    expect(elideLongBlocks(exact)).toBe(exact);
  });
});

describe("sanitizeCompletionRelay", () => {
  it("strips envelopes then elides an oversized remnant", () => {
    const remnant = "z".repeat(DEFAULT_MAX_RELAY_CHARS + 100);
    const input = `${remnant}\n[tool output: t]\nbody\n[/tool output]`;
    const out = sanitizeCompletionRelay(input);
    expect(out).toBe(`[output elided — ${remnant.length} chars]`);
  });

  it("returns empty when the whole payload was tool output", () => {
    const input = "[tool output: t]\nonly a tool dump\n[/tool output]";
    expect(sanitizeCompletionRelay(input)).toBe("");
  });

  it("returns empty for nullish input", () => {
    expect(sanitizeCompletionRelay(undefined)).toBe("");
    expect(sanitizeCompletionRelay(null)).toBe("");
  });
});
