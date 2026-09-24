import {
  ChannelType,
  type ContextEvent,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { conversationClientUserMemoryId } from "@elizaos/core/conversation-chat-marker";
import { describe, expect, it } from "vitest";
import { appendPriorDialogueEvents } from "./dialogue-context";
import {
  historicalActionResults,
  historicalEffectReceipts,
} from "./navigation-history";
import { renderMessageHandlerModelInput } from "./stage1-input";

function request(index: number): Memory {
  const scope = "agent:room:user";
  const clientMessageId = `navigation-${index}`;
  const id = conversationClientUserMemoryId(scope, clientMessageId);
  const receipt = JSON.stringify({
    effect: "view_navigation",
    status: "delivered",
    viewId: index % 2 ? "notes" : "calendar",
    stepId: `step-${index}`,
    handoffId: `handoff-${index}`,
    label: `Exact destination ${index} Ω`,
  });
  return {
    id,
    agentId: "agent",
    roomId: "room",
    entityId: "user",
    createdAt: index,
    content: {
      text: `Open destination ${index}.`,
      source: "client_chat",
      channelType: ChannelType.VOICE_DM,
      chatIdempotency: {
        version: 1,
        scope,
        clientMessageId,
        fingerprint: "a".repeat(64),
        outcomeJson: JSON.stringify({
          userMessageId: id,
          actionResults: [
            {
              actionName: "VIEWS_SHOW",
              success: true,
              text: receipt,
              values: {
                completedActionDelivered: true,
                completedActionHandoffId: `handoff-${index}`,
              },
            },
          ],
        }),
      },
    },
  } as Memory;
}

describe("historical navigation input", () => {
  it("retains partial committed effects only for the bound user and room", () => {
    const original = request(1);
    const current = request(2);
    const marker = original.content.chatIdempotency as { outcomeJson: string };
    const outcome = JSON.parse(marker.outcomeJson);
    const receipt = {
      receiptId: "delete-receipt",
      operation: "notes.note.delete",
      resource: { kind: "notes.note", id: "deleted-note" },
      artifacts: [],
      idempotency: { key: "delete-key", replayed: false },
      observedAt: "2026-09-24T03:03:21.000Z",
      outcome: "applied",
      commit: {
        kind: "durable",
        id: "deleted-note",
        committedAt: "2026-09-24T03:03:21.000Z",
      },
    };
    outcome.actionResults = [
      { actionName: "NOTES_DELETE", success: true, effectReceipts: [receipt] },
    ];
    marker.outcomeJson = JSON.stringify(outcome);
    expect(
      historicalEffectReceipts(
        historicalActionResults(original, current, "agent"),
      ),
    ).toEqual([{ actionName: "NOTES_DELETE", success: true, receipt }]);
    for (const changed of [
      { entityId: "other" },
      { roomId: "other" },
      { agentId: "other" },
    ]) {
      expect(
        historicalActionResults(
          original,
          { ...current, ...changed } as Memory,
          "agent",
        ),
      ).toEqual([]);
    }
    const events: ContextEvent[] = [];
    appendPriorDialogueEvents(
      events,
      { agentId: "agent" } as IAgentRuntime,
      {
        data: {
          providers: {
            RECENT_MESSAGES: { data: { recentMessages: [original] } },
          },
        },
      } as State,
      current,
    );
    const effects = events.find(
      (event) =>
        event.type === "segment" &&
        event.segment.label === "runtime:historical_effects",
    );
    expect(
      effects?.type === "segment" ? effects.segment.content : "",
    ).toContain("delete-receipt");
    outcome.actionResults[0].effectReceipts[0].commit = null;
    marker.outcomeJson = JSON.stringify(outcome);
    expect(
      historicalEffectReceipts(
        historicalActionResults(original, current, "agent"),
      ),
    ).toEqual([]);
  });
  it("shares one evidence rule without dropping or rewriting any authorized outcome", () => {
    const originals = Array.from({ length: 29 }, (_, i) => request(i));
    const current = { ...request(30), content: { text: "What did you open?" } };
    const before = structuredClone(originals);
    const events: ContextEvent[] = [];
    appendPriorDialogueEvents(
      events,
      { agentId: "agent" } as IAgentRuntime,
      {
        data: {
          providers: {
            RECENT_MESSAGES: { data: { recentMessages: originals } },
          },
        },
      } as State,
      current,
    );
    const receipts = events.flatMap((event) =>
      event.type === "segment" &&
      event.segment.label === "runtime:historical_navigation"
        ? [JSON.parse(event.segment.content)]
        : [],
    );
    expect(receipts).toHaveLength(originals.length);
    for (const [index, original] of originals.entries()) {
      const marker = original.content.chatIdempotency as {
        outcomeJson: string;
      };
      const result = JSON.parse(marker.outcomeJson).actionResults[0];
      expect(receipts[index]).toEqual({
        requestSourceEventId: `history:${original.id}`,
        navigation: [{ success: result.success, receipt: result.text }],
      });
    }
    events.push({
      id: "current-turn-boundary",
      type: "instruction",
      source: "message-service",
      content:
        "current_turn_boundary: only the current request authorizes work",
      stable: false,
    });
    for (const directMessage of [true, false]) {
      const input = renderMessageHandlerModelInput(
        { character: { name: "Eliza" } },
        { id: "turn", events },
        [],
        { directMessage },
      );
      const wire = input.messages.map((message) => message.content).join("\n");
      expect(
        wire.split(
          "never current work, a continuation request, or permission to act",
        ),
      ).toHaveLength(2);
      expect(wire.indexOf("runtime:historical_navigation_scope")).toBeLessThan(
        wire.indexOf("current_turn_boundary:"),
      );
      for (const receipt of receipts)
        expect(wire).toContain(JSON.stringify(receipt));
    }
    expect(originals).toEqual(before);
  });

  it("does not emit the evidence rule or receipts for foreign-room outcomes", () => {
    const original = request(1);
    const events: ContextEvent[] = [];
    appendPriorDialogueEvents(
      events,
      { agentId: "agent" } as IAgentRuntime,
      {
        data: {
          providers: {
            RECENT_MESSAGES: { data: { recentMessages: [original] } },
          },
        },
      } as State,
      { ...request(2), roomId: "other-room" } as Memory,
    );
    expect(
      events.filter((event) => event.id?.startsWith("historical-navigation")),
    ).toEqual([]);
  });
});
