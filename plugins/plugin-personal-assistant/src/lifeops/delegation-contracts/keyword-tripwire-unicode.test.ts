import { describe, expect, it } from "vitest";
import {
  type DelegationContract,
  type DelegationInboundTurn,
  evaluateDelegationContract,
} from "./index.ts";

const contractWithKeywords = (
  keywords: readonly string[],
): DelegationContract => ({
  contractId: "contract-1",
  objective: "handle vendor mail",
  scope: { kind: "thread", channel: "email", threadId: "thread-1" },
  autonomyLevel: "draft_only",
  tripwires: [{ kind: "keyword", label: "keyword tripwire", keywords }],
  createdAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2027-10-01T00:00:00.000Z",
  ownerUserId: "owner",
  requestedBy: "owner",
});

const turnWithText = (text: string): DelegationInboundTurn => ({
  channel: "email",
  threadId: "thread-1",
  sender: "vendor@example.com",
  text,
  receivedAt: "2026-10-12T00:00:00.000Z",
});

const outcomeFor = (keywords: readonly string[], text: string) =>
  evaluateDelegationContract({
    contract: contractWithKeywords(keywords),
    turn: turnWithText(text),
    nowIso: "2026-10-12T00:00:00.000Z",
  }).outcome;

describe("keyword tripwire Unicode matching", () => {
  it("does not escalate unrelated turns for a non-Latin keyword", () => {
    expect(outcomeFor(["계약"], "hello, lunch tomorrow?")).toBe("in_bounds");
    expect(outcomeFor(["계약"], "내일 회의실에서 만나요")).toBe("in_bounds");
  });

  it("escalates when the non-Latin keyword appears in the turn text", () => {
    expect(outcomeFor(["계약"], "계약 갱신 논의 부탁드립니다")).toBe(
      "escalate_owner",
    );
  });

  it("does not escalate for keywords that normalize to empty", () => {
    expect(outcomeFor(["🚨"], "hello, lunch tomorrow?")).toBe("in_bounds");
    expect(outcomeFor(["★"], "hello there")).toBe("in_bounds");
    expect(outcomeFor(["!!!"], "anything at all")).toBe("in_bounds");
    expect(outcomeFor(["【】"], "hello there")).toBe("in_bounds");
    expect(outcomeFor([""], "hello there")).toBe("in_bounds");
    expect(outcomeFor(["   "], "hello there")).toBe("in_bounds");
    expect(outcomeFor(["🚨", "renewal"], "the renewal date moved")).toBe(
      "escalate_owner",
    );
  });

  it("keeps ASCII keyword and price-shaped keyword behavior", () => {
    expect(outcomeFor(["renewal"], "the renewal date moved")).toBe(
      "escalate_owner",
    );
    expect(outcomeFor(["renewal"], "hello there")).toBe("in_bounds");
    expect(outcomeFor(["$500"], "they quoted $500 total")).toBe(
      "escalate_owner",
    );
    expect(outcomeFor(["$500"], "they quoted $900 total")).toBe("in_bounds");
  });
});
