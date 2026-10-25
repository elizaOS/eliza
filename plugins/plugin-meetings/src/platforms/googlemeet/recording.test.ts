/**
 * Participant-count polling error policy for the Google Meet recording loop.
 * Deterministic: the Playwright Page is a hand-rolled fake — no real browser.
 * Guards the fix that a failed `page.evaluate` must read as "unknown" (null),
 * never a fabricated `0` that would trip a premature auto-leave (#12275).
 */

import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { countParticipants } from "./recording.js";

function fakePage(evaluate: Page["evaluate"]): Page {
  return { evaluate } as unknown as Page;
}

describe("countParticipants", () => {
  it("returns the tile count when the DOM query succeeds", async () => {
    const page = fakePage((async () => 3) as Page["evaluate"]);
    expect(await countParticipants(page)).toBe(3);
  });

  it("returns 0 for a real empty-room reading (distinct from failure)", async () => {
    const page = fakePage((async () => 0) as Page["evaluate"]);
    expect(await countParticipants(page)).toBe(0);
  });

  it("returns null (unknown) when the page evaluate throws, not a fabricated 0", async () => {
    const page = fakePage((async () => {
      throw new Error("Execution context was destroyed");
    }) as Page["evaluate"]);
    expect(await countParticipants(page)).toBeNull();
  });
});
