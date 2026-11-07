import {
  ChannelType,
  type ContextEvent,
  conversationClientUserMemoryId,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { appendPriorDialogueEvents } from "./dialogue-context";
import {
  historicalActionResults,
  historicalNavigationReceipts,
  historicalReceiptGroups,
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
      historicalReceiptGroups(
        historicalActionResults(original, current, "agent"),
      ).effects,
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
      historicalReceiptGroups(
        historicalActionResults(original, current, "agent"),
      ).effects,
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
      const tableSegment = input.promptSegments.find(
        (segment) => segment.label === "runtime:historical_navigation_table",
      );
      const table = JSON.parse(tableSegment?.content.trim() ?? "{}");
      expect(table.columns).toEqual(["requestSourceEventId", "navigation"]);
      expect(table.receiptColumns).toEqual(["success", "receipt"]);
      const decodedRows = table.rows.map(
        ([source, navigation]: [string, [boolean, [number, unknown[]]][]]) => [
          source,
          navigation.map(([success, [shape, values]]) => [
            success,
            JSON.stringify(
              Object.fromEntries(
                table.receiptShapes[shape].map((key: string, index: number) => [
                  key,
                  values[index],
                ]),
              ),
            ),
          ]),
        ],
      );
      expect(decodedRows).toEqual(
        receipts.map((receipt) => [
          receipt.requestSourceEventId,
          receipt.navigation.map(
            (entry: { success: boolean; receipt: string }) => [
              entry.success,
              entry.receipt,
            ],
          ),
        ]),
      );
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

describe("aliased navigation history", () => {
  function aliased(status = "delivered") {
    return {
      actionName: "VIEWS",
      success: true,
      text: JSON.stringify({
        effect: "view_navigation",
        status,
        viewId: "automations",
        stepId: null,
        handoffId: "handoff-workflows",
        label: "Automations",
        resolvedAlias: "workflows",
      }),
      values: {
        completedActionDelivered: status === "delivered",
        completedActionHandoffId: "handoff-workflows",
      },
    };
  }
  it("retains Workflows then Home for a later Back request without relabeling preparation", () => {
    expect(historicalNavigationReceipts([aliased()])).toHaveLength(1);
    const previous = request(1),
      home = request(2),
      back = request(3);
    back.content.text = "go back";
    const set = (m: Memory, result: unknown) => {
      const marker = m.content.chatIdempotency as { outcomeJson: string };
      marker.outcomeJson = JSON.stringify({
        userMessageId: m.id,
        actionResults: [result],
      });
    };
    set(previous, aliased());
    set(home, {
      actionName: "VIEWS",
      success: true,
      text: JSON.stringify({
        effect: "view_navigation",
        status: "delivered",
        viewId: "chat",
        stepId: null,
        handoffId: "handoff-home",
        label: "Home",
      }),
      values: {
        completedActionDelivered: true,
        completedActionHandoffId: "handoff-home",
      },
    });
    const events: ContextEvent[] = [];
    appendPriorDialogueEvents(
      events,
      { agentId: "agent" } as IAgentRuntime,
      {
        values: {},
        text: "",
        data: {
          providers: {
            RECENT_MESSAGES: { data: { recentMessages: [previous, home] } },
          },
        },
      } as State,
      back,
    );
    const history = JSON.stringify(events);
    expect(history).toContain("workflows");
    expect(history).toContain("automations");
    expect(history).toContain("chat");
    const prepared = historicalNavigationReceipts([aliased("prepared")]);
    expect(prepared).toHaveLength(1);
    expect(JSON.parse(prepared[0].receipt).status).toBe("prepared");
  });
  it("rejects invalid aliases, unknown keys and mismatched delivery proof", () => {
    for (const resolvedAlias of [123, "", null]) {
      const value = aliased();
      value.text = JSON.stringify({ ...JSON.parse(value.text), resolvedAlias });
      expect(historicalNavigationReceipts([value])).toEqual([]);
    }
    const unknown = aliased();
    unknown.text = JSON.stringify({
      ...JSON.parse(unknown.text),
      forged: true,
    });
    expect(historicalNavigationReceipts([unknown])).toEqual([]);
    const mismatch = aliased();
    mismatch.values.completedActionHandoffId = "wrong";
    expect(historicalNavigationReceipts([mismatch])).toEqual([]);
    expect(historicalNavigationReceipts([])).toEqual([]);
  });
});
