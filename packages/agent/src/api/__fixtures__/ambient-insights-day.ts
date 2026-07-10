import { makeSourceSegment } from "@elizaos/shared";

/**
 * Synthetic all-day quality fixture. It deliberately mixes a work meeting,
 * errands, casual speech, and non-final lifecycle rows so evals exercise the
 * same noisy shape produced by always-on capture.
 */
export function syntheticAmbientDay(sessionId: string) {
  const rows = [
    [
      "Maya",
      "Let's ship the onboarding copy Friday. I will send the final draft today.",
    ],
    ["spk_1", "I'll review Maya's draft tomorrow morning."],
    [
      null,
      "Decision: keep the launch on Friday and remove the extra approval step.",
    ],
    [null, "Remember to pick up the prescription after lunch."],
    [null, "Also buy milk and coffee while we're out."],
    [null, "interim words that must never become an insight"],
    ["spk_0", "Can you follow up with Sam about the broken invite link?"],
    ["spk_1", "Yes, I'll message Sam before five."],
    [null, "That sunset over the park was incredible."],
    [null, "eager hypothesis that is not canonical yet"],
    [null, "We talked about a movie and what to cook for dinner."],
    [null, "No new tasks, just heading home now."],
  ] as const;
  return rows.map(([speakerLabel, text], ordinal) => ({
    ...makeSourceSegment({
      sessionId,
      ordinal,
      text,
      ...(speakerLabel ? { speakerLabel } : {}),
      atMs: Date.UTC(2026, 6, 10, 8 + ordinal, 0, 0),
    }),
    status:
      ordinal === 5
        ? ("pending" as const)
        : ordinal === 9
          ? ("eager" as const)
          : ("finalized" as const),
  }));
}
