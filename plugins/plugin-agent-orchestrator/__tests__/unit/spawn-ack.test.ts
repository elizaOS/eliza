/**
 * spawn-ack.test.ts
 *
 * The spawn-ack prompt composition and output sanitation moved into the shared
 * phrasing seam `src/voice/phrase-for-user.ts` (characterVoiceSlice /
 * buildPhrasePrompt / validatePhrasedText — covered by its colocated
 * src/voice/phrase-for-user.test.ts). index.ts keeps only the fallback literal
 * and the delegation; the ack behavior itself is covered end-to-end by
 * progress-cadence.test.ts. This file pins what index.ts still owns.
 */

import { describe, expect, it } from "vitest";
import { SPAWN_ACK_FALLBACK } from "../../src/index.js";
import {
  characterVoiceSlice,
  validatePhrasedText,
} from "../../src/voice/phrase-for-user.js";

describe("SPAWN_ACK_FALLBACK", () => {
  it("is a short, neutral, non-empty literal", () => {
    expect(SPAWN_ACK_FALLBACK.trim().length).toBeGreaterThan(0);
    expect(SPAWN_ACK_FALLBACK.length).toBeLessThanOrEqual(24);
  });

  it("passes the shared post-validation (a model outage can always deliver it verbatim)", () => {
    expect(
      validatePhrasedText(
        SPAWN_ACK_FALLBACK,
        { intent: "confirm", facts: {} },
        120,
      ),
    ).toBe(true);
  });
});

describe("spawn-ack voice source", () => {
  it("derives the ack voice from the shared character slice (single prompt home)", () => {
    const slice = characterVoiceSlice({
      name: "Avery",
      bio: ["a terse, dry on-chain assistant"],
      adjectives: ["dry", "precise"],
      style: { chat: ["casual"], all: ["concise"] },
    });
    expect(slice).toContain("You are Avery.");
    expect(slice).toContain("a terse, dry on-chain assistant");
    expect(slice).toContain("dry");
    expect(slice).toContain("precise");
  });
});
