import { describe, expect, it } from "vitest";
import { truncateWellFormed, toWellFormedUnicode } from "@elizaos/core";

const ONE_LINE_MAX = 240;

function buildDirective(status: {
  enteredAt?: string | null;
  reason?: string | null;
  resumeOn?: { kind?: string } | null;
}): string {
  const resumePhrase = status.resumeOn?.kind
    ? `the resume condition fires (${status.resumeOn.kind})`
    : "the resume condition fires";
  return (
    `This room is in handoff mode (since ${status.enteredAt ?? "earlier"}; reason: ${status.reason ?? "n/a"}). ` +
    `Do not respond unless ${resumePhrase}. Stay silent — defer to the human participants.`
  );
}

describe("room-policy surrogate truncation", () => {
  it("does not split surrogate pairs at ONE_LINE_MAX", () => {
    const directive = buildDirective({
      enteredAt: "earlier",
      reason: `a`.repeat(200) + "🦊" + `b`.repeat(100),
    });
    const text = truncateWellFormed(toWellFormedUnicode(directive), ONE_LINE_MAX);
    const isWellFormed = (value: string) =>
      (value as unknown as { isWellFormed(): boolean }).isWellFormed?.() ?? true;
    expect(isWellFormed(text)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(ONE_LINE_MAX);
  });
});
