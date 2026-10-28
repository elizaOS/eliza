/** A Discord reply's referenced message is part of the current turn, so Stage 1
 * renders it with the current message instead of ahead of the task, where it
 * read as stale context. */
import type { ContextEvent, IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  appendPriorDialogueEvents,
  currentMessageContentForContext,
  replyReferenceEventForContext,
} from "./dialogue-context";
import { renderMessageHandlerModelInput } from "./stage1-input";

const runtime = {
  agentId: "agent",
  character: { name: "Eliza" },
} as IAgentRuntime;
const prior = {
  id: "prior",
  roomId: "room",
  agentId: "agent",
  entityId: "user",
  createdAt: 1,
  content: { text: "anyone around?", senderName: "Sam", source: "discord" },
} as Memory;
const message = {
  id: "current",
  roomId: "room",
  agentId: "agent",
  entityId: "user",
  createdAt: 2,
  content: {
    text: "what did you mean by this",
    senderName: "Sam",
    source: "discord",
    replyToMessageText: "the build is green on develop",
    replyToSenderName: "Eliza",
    replyToExternalMessageId: "1428000000000000001",
  },
} as Memory;

function render(): ContextEvent[] {
  const events: ContextEvent[] = [];
  appendPriorDialogueEvents(
    events,
    runtime,
    {
      data: {
        providers: {
          RECENT_MESSAGES: { data: { recentMessages: [prior] } },
        },
      },
    } as unknown as State,
    message,
  );
  const reference = replyReferenceEventForContext(message);
  if (!reference) throw Error("reply reference");
  events.push(reference, {
    id: "current-message",
    type: "message",
    source: "discord",
    createdAt: message.createdAt,
    message: {
      id: message.id,
      role: "user",
      content: currentMessageContentForContext(message),
    },
  });
  return events;
}

describe("Stage 1 reply reference", () => {
  it("renders the referenced message directly before the current message", () => {
    const input = renderMessageHandlerModelInput(
      { character: { name: "Eliza" } },
      { id: "turn", events: render() },
      [],
      { groupTriage: true },
    );
    const wire = input.messages.map((entry) => entry.content).join("\n\n");
    const task = wire.indexOf("# Task");
    const conversation = wire.indexOf("# Conversation");
    const reference = wire.indexOf(
      "reply_reference:\nEliza: the build is green on develop\n(platform message id: 1428000000000000001)",
    );
    const current = wire.indexOf("# Current message");
    expect(task).toBeGreaterThanOrEqual(0);
    expect(wire.indexOf("anyone around?")).toBeGreaterThan(conversation);
    expect(reference).toBeGreaterThan(conversation);
    expect(conversation).toBeGreaterThan(task);
    expect(current).toBeGreaterThan(reference);
    expect(wire.slice(reference, current)).not.toContain("# ");
  });
});
