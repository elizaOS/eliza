import { describe, expect, it, vi } from "vitest";

vi.mock("../../../utils/message-text.ts", () => ({
  normalizeUserMessageText: (m: { content?: { text?: string } }) =>
    m.content?.text ?? "",
}));

import {
  looksLikeRelationshipFollowUpReminder,
  normalizeMessageText,
} from "./non-actionable-chatter.ts";

function msg(text: string) {
  return { content: { text } } as never;
}

describe("normalizeMessageText", () => {
  it("normalizes the message text", () => {
    expect(normalizeMessageText(msg("hello"))).toBe("hello");
  });
});

describe("looksLikeRelationshipFollowUpReminder", () => {
  it("matches follow-up with time cues", () => {
    expect(looksLikeRelationshipFollowUpReminder(msg("follow up with dave next week"))).toBe(true);
    expect(looksLikeRelationshipFollowUpReminder(msg("follow up with ann tomorrow"))).toBe(true);
    expect(looksLikeRelationshipFollowUpReminder(msg("follow up with bob on monday"))).toBe(true);
  });

  it("rejects missing time cues", () => {
    expect(looksLikeRelationshipFollowUpReminder(msg("follow up with dave"))).toBe(false);
  });

  it("rejects recurring cadence", () => {
    expect(looksLikeRelationshipFollowUpReminder(msg("follow up with dave every week"))).toBe(false);
  });

  it("rejects unrelated text", () => {
    expect(looksLikeRelationshipFollowUpReminder(msg("call me later"))).toBe(false);
  });
});
