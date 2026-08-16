/**
 * Completion-relay deliverable guarantee (2026-08-16 website-build cluster,
 * leg 1): the relay text handed to the origin room must carry the verified
 * deliverable URLs even when the sub-agent's narration describes its last
 * step instead of the deliverable. Pure-function coverage of
 * verifiedUrlCompletionFallback — deterministic, no runtime.
 */

import { describe, expect, it } from "vitest";

import { verifiedUrlCompletionFallback } from "../../src/services/sub-agent-router.js";

const HEADER = "[sub-agent: builder] relay this result; do not respawn";
const URL = "https://nubilio.org/apps/nubs/";

describe("verifiedUrlCompletionFallback — deliverable-first relay", () => {
  it("leads prose narration with the verified URL when the narration omits it (live receipt shape)", () => {
    const text = `${HEADER}\nUpdated app/layout.tsx metadata and verified the build output on disk.`;
    const out = verifiedUrlCompletionFallback(text, [URL]);
    const lines = out.split("\n");
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toBe(URL);
    expect(out).toContain("Updated app/layout.tsx");
  });

  it("leaves narration alone when it already names a user-facing URL", () => {
    const text = `${HEADER}\nDone — live at ${URL} with the new metadata.`;
    expect(verifiedUrlCompletionFallback(text, [URL])).toBe(text);
  });

  it("surfaces the public URL when narration only names the loopback variant", () => {
    const loopback = "http://127.0.0.1:3000/apps/nubs/";
    const text = `${HEADER}\nServed and checked at ${loopback}.`;
    const out = verifiedUrlCompletionFallback(text, [loopback, URL]);
    expect(out.split("\n")[1]).toBe(URL);
  });

  it("keeps the URL-only replacement branch intact", () => {
    const text = `${HEADER}\nhttp://127.0.0.1:3000/apps/nubs/`;
    const out = verifiedUrlCompletionFallback(text, [
      "http://127.0.0.1:3000/apps/nubs/",
      URL,
    ]);
    expect(out).toBe(`${HEADER}\n${URL}`);
  });

  it("keeps the empty-narration branch intact", () => {
    const out = verifiedUrlCompletionFallback(HEADER, [URL]);
    expect(out).toBe(`${HEADER}\n${URL}`);
  });
});
