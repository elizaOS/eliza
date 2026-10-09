/** Persisted interruption receipts are runtime state, including zero-token Stop. */
import type { ContextEvent, IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { appendPriorDialogueEvents } from "./dialogue-context.ts";
import { resolveExplicitContinuationRequestText } from "./direct-action-heuristics.ts";

function fixture(partial = "") {
  const request = {
    id: "request",
    agentId: "agent",
    roomId: "room",
    entityId: "user",
    createdAt: 1,
    content: { text: "Compare my notes." },
  } as Memory;
  const receipt = {
    id: "receipt",
    agentId: "agent",
    roomId: "room",
    entityId: "agent",
    createdAt: 2,
    content: { text: partial, interrupted: true, inReplyTo: "request" },
  } as Memory;
  const current = {
    id: "current",
    agentId: "agent",
    roomId: "room",
    entityId: "user",
    createdAt: 3,
    content: { text: "Hi." },
  } as Memory;
  return { request, receipt, current };
}
function render(memories: Memory[], current: Memory) {
  const events: ContextEvent[] = [];
  appendPriorDialogueEvents(
    events,
    { agentId: "agent", character: { name: "Eliza" } } as IAgentRuntime,
    {
      text: "",
      values: {},
      data: {
        providers: { RECENT_MESSAGES: { data: { recentMessages: memories } } },
      },
    } as State,
    current,
    { includeOwnReplies: true },
  );
  return events;
}
describe("interrupted turn context", () => {
  it.each(["", "I will compare them."])(
    "retains a terminal receipt independently of delivered text: %j",
    (partial) => {
      const f = fixture(partial);
      const before = JSON.stringify(f);
      const events = render([f.request, f.receipt], f.current);
      const status = events.find(
        (event) => event.id === "interrupted-turn:receipt",
      );
      expect(status).toMatchObject({
        type: "segment",
        source: "message-service",
        segment: { label: "runtime:interrupted_turn" },
      });
      if (!status || !("segment" in status)) throw Error("status missing");
      expect(JSON.parse(status.segment.content)).toMatchObject({
        requestText: "Compare my notes.",
        responseGeneration: "interrupted",
      });
      expect(
        events.find((event) => event.id === "history:request"),
      ).toMatchObject({ segment: { content: "user: Compare my notes." } });
      expect(JSON.stringify(f)).toBe(before);
    },
  );
  it.each([
    "user",
    "other-room",
    "other-agent",
    "unknown-request",
    "duplicate-request",
  ])("does not manufacture interruption provenance: %s", (variant) => {
    const f = fixture();
    if (variant === "user") f.receipt.entityId = "user" as Memory["entityId"];
    if (variant === "other-room")
      f.receipt.roomId = "other-room" as Memory["roomId"];
    if (variant === "other-agent")
      f.receipt.agentId = "other-agent" as Memory["agentId"];
    if (variant === "unknown-request") f.receipt.content.inReplyTo = "missing";
    const memories = [f.request, f.receipt];
    if (variant === "duplicate-request")
      memories.push({ ...f.request, content: { text: "Different request" } });
    expect(
      render(memories, f.current).some((event) =>
        event.id.startsWith("interrupted-turn:"),
      ),
    ).toBe(false);
  });
  it("does not treat an interrupted preview as approval but permits explicit resumption", () => {
    const f = fixture("Ready to compare them. Shall I continue?");
    expect(
      resolveExplicitContinuationRequestText(
        "yes",
        [f.request, f.receipt],
        "agent",
        "user",
        "current",
      ),
    ).toBeNull();
    expect(
      resolveExplicitContinuationRequestText(
        "continue",
        [f.request, f.receipt],
        "agent",
        "user",
        "current",
      ),
    ).toBe("Compare my notes.");
  });
});
