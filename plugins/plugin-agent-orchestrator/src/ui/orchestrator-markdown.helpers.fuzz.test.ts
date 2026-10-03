// Security fuzz for the markdown URL sanitizer. It is the boundary that keeps
// agent-authored link hrefs from becoming live javascript:/data: execution
// sinks. The invariant under any input: the result is either null, a
// relative/anchor form, or an absolute URL whose protocol is http/https/mailto
// -- and NEVER a dangerous scheme. A seeded LCG makes failures reproducible.

import { describe, expect, it } from "vitest";
import { sanitizeMarkdownUrl } from "./orchestrator-markdown.helpers";

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Whitespace + a zero-width / control char to probe scheme-smuggling attempts.
const WS = String.fromCharCode(0, 9, 10, 13, 0x200b);
const FRAGMENTS = [
  "javascript:",
  "JaVaScRiPt:",
  "java",
  "script:",
  "data:",
  "vbscript:",
  "file:",
  "http:",
  "https:",
  "mailto:",
  "//",
  "/",
  "./",
  "../",
  "#",
  "evil.com",
  "localhost",
  "alert(1)",
  "text/html,<script>",
  "a@b.com",
  ":",
  ".",
  WS,
  " ",
];

const DANGEROUS = /^\s*(?:javascript|data|vbscript|file)\s*:/i;

describe("sanitizeMarkdownUrl security fuzz", () => {
  it("never returns a dangerous-scheme URL on any input", () => {
    const rng = makeRng(0x5af3);
    for (let i = 0; i < 6000; i++) {
      const parts: string[] = [];
      const len = 1 + Math.floor(rng() * 8);
      for (let j = 0; j < len; j++) {
        parts.push(FRAGMENTS[Math.floor(rng() * FRAGMENTS.length)]);
      }
      const input = parts.join("");
      const out = sanitizeMarkdownUrl(input);
      if (out === null) continue;

      // A non-null result must never read as a dangerous scheme...
      expect(DANGEROUS.test(out)).toBe(false);

      // ...and is either a relative/anchor form or a safe absolute URL.
      const isRelative =
        (out.startsWith("/") && !out.startsWith("//")) ||
        out.startsWith("./") ||
        out.startsWith("../") ||
        out.startsWith("#");
      if (!isRelative) {
        const protocol = new URL(out).protocol;
        expect(["http:", "https:", "mailto:"]).toContain(protocol);
      }
    }
  });
});
