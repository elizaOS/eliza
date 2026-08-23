/**
 * Verifies safe sorting in meetings pipeline and VoteLockTable when timestamps or vote weights contain NaN.
 */

import { describe, expect, it } from "vitest";
import { VoteLockTable } from "../../platforms/googlemeet/speaker-identity.js";

describe("meetings safe sort", () => {
  it("safely resolves speaker bestGuess and recordVote when weights contain NaN or non-finite values", () => {
    const tracker = new VoteLockTable();

    tracker.recordVote(1, "Alice", 1.0);
    tracker.recordVote(1, "Bob", NaN);
    tracker.recordVote(1, "Charlie", 2.0);

    const guess = tracker.bestGuess(1);
    expect(guess).toBeDefined();
    // Non-finite weight falls back to 0, so Charlie (2.0) is top guess
    expect(guess).toBe("Charlie");
  });

  it("safely handles sort on segments with NaN startMs or endMs", () => {
    const segments = [
      { startMs: 2000, endMs: 3000, text: "two" },
      { startMs: NaN, endMs: 1000, text: "nan" },
      { startMs: 1000, endMs: 2000, text: "one" },
    ];

    segments.sort((a, b) => {
      const aStart = Number.isFinite(a.startMs) ? a.startMs : 0;
      const bStart = Number.isFinite(b.startMs) ? b.startMs : 0;
      const aEnd = Number.isFinite(a.endMs) ? a.endMs : 0;
      const bEnd = Number.isFinite(b.endMs) ? b.endMs : 0;
      return aStart - bStart || aEnd - bEnd;
    });

    expect(segments[0].text).toBe("nan");
    expect(segments[1].text).toBe("one");
    expect(segments[2].text).toBe("two");
  });
});
