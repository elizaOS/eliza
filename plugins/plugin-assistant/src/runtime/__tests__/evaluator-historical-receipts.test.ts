/**
 * The evaluator reads earlier requests' outcome records beside this turn's
 * evidence. Coverage cites this turn's intent and step IDs and a completed
 * change cites this turn's committed receipt IDs; neither is ever an earlier
 * record's field. The records print only what a later step reads, so the
 * evaluator still gets every ID it must cite and none it must not.
 */
import {
  ChannelType,
  type ContextEvent,
  type ContextObject,
  conversationClientUserMemoryId,
  type IAgentRuntime,
  type JSONSchema,
  type Memory,
  normalizeEffectReceipt,
  type PlannerTrajectory,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { appendPriorDialogueEvents } from "../../services/message/dialogue-context.ts";
import { runEvaluator, validatedOutcomeCoverage } from "../evaluator.ts";

const agent = "e0000000-0000-4000-8000-000000000001",
  room = "e0000000-0000-4000-8000-000000000002",
  owner = "e0000000-0000-4000-8000-000000000003",
  scope = `${agent}:${room}:${owner}`;
const earlier = normalizeEffectReceipt({
  receiptId: "earlier-receipt-5f1c",
  operation: "notes.note.create",
  resource: { kind: "notes.note", id: "note-groceries", version: "4" },
  artifacts: [],
  idempotency: { key: null, replayed: false },
  observedAt: "2026-11-20T21:15:04.179Z",
  outcome: "applied",
  commit: {
    kind: "durable",
    id: "note-groceries",
    committedAt: "2026-11-20T21:15:04.179Z",
  },
});
const currentReceipt = normalizeEffectReceipt({
  receiptId: "current-receipt",
  operation: "notes.note.update",
  resource: { kind: "notes.note", id: "note-groceries", version: "5" },
  artifacts: [],
  idempotency: { key: null, replayed: false },
  observedAt: "2026-11-20T21:16:00.000Z",
  outcome: "applied",
  commit: {
    kind: "durable",
    id: "note-groceries",
    committedAt: "2026-11-20T21:16:00.000Z",
  },
});

function turn(): PlannerTrajectory {
  const id = conversationClientUserMemoryId(scope, "make-groceries");
  const request = {
    id,
    agentId: agent,
    roomId: room,
    entityId: owner,
    createdAt: Date.UTC(2026, 10, 20, 21, 15, 0),
    content: {
      text: "Make a note called Groceries.",
      source: "client_chat",
      channelType: ChannelType.DM,
      chatIdempotency: {
        version: 1,
        scope,
        clientMessageId: "make-groceries",
        fingerprint: "a".repeat(64),
        outcomeJson: JSON.stringify({
          userMessageId: id,
          actionResults: [
            {
              actionName: "NOTES_CREATE",
              success: true,
              effectReceipts: [earlier],
            },
          ],
        }),
      },
    },
  } as Memory;
  const events: ContextEvent[] = [];
  appendPriorDialogueEvents(
    events,
    { agentId: agent } as IAgentRuntime,
    {
      data: {
        providers: { RECENT_MESSAGES: { data: { recentMessages: [request] } } },
      },
    } as never,
    {
      id: "current",
      agentId: agent,
      roomId: room,
      entityId: owner,
      content: { text: "Rename it to Shopping." },
    } as Memory,
  );
  const context: ContextObject = {
    id: "turn",
    events: [
      ...events,
      {
        id: "current",
        type: "message",
        message: {
          id: "current",
          role: "user",
          content: "Rename it to Shopping.",
        },
      },
    ],
  };
  return {
    context,
    modelBaseContext: context,
    outcomeIntents: ["Rename the Groceries note to Shopping"],
    steps: [
      {
        iteration: 1,
        toolCall: { id: "call", name: "NOTES_UPDATE", params: {} },
        result: { success: true, effectReceipts: [currentReceipt] },
      },
    ],
    archivedSteps: [],
    plannedQueue: [],
    evaluatorOutputs: [],
  } as unknown as PlannerTrajectory;
}

async function evaluate(verdict: Record<string, unknown>) {
  const trajectory = turn();
  const requests: {
    responseSchema: JSONSchema;
    messages: { role: string; content: unknown }[];
  }[] = [];
  const output = await runEvaluator({
    context: trajectory.context,
    trajectory,
    runtime: {
      useModel: async (_type: unknown, request: (typeof requests)[number]) => {
        requests.push(request);
        return JSON.stringify(verdict);
      },
    },
  } as never);
  expect(requests).toHaveLength(1);
  return {
    trajectory,
    output,
    prompt: requests[0].messages
      .map(({ content }) => String(content))
      .join("\n"),
  };
}

const finished = (effectReceiptIds: string[]) => ({
  thought: "The rename is recorded.",
  success: true,
  decision: "FINISH",
  requestFullyCovered: true,
  replyEffectStatus: "applied",
  messageToUser: "Renamed it to Shopping.",
  outcomeCoverage: [
    { intentId: "intent:1", status: "completed", evidenceStepIds: ["step:1"] },
  ],
  effectReceiptIds,
});

it("prints this turn's citable coverage and receipt IDs beside an earlier record that offers none", async () => {
  const { trajectory, output, prompt } = await evaluate(
    finished(["current-receipt"]),
  );
  // The earlier request's outcome: its record and kind, keyed by its source.
  expect(prompt).toContain(
    '["history:h1",[["NOTES_CREATE",true,[2,["notes.note.create",["notes.note","note-groceries"],"applied",["durable"]]]]]]',
  );
  expect(prompt).not.toContain("earlier-receipt-5f1c");
  expect(prompt).not.toContain("2026-11-20T21:15:04.179Z");
  // Everything coverage and proof may cite is this turn's.
  expect(prompt).toContain('Committed effect receipt IDs: ["current-receipt"]');
  expect(prompt).toContain("intent:1: Rename the Groceries note to Shopping");
  expect(prompt).toContain("step:1: NOTES_UPDATE; success=true");
  expect(output).toMatchObject({
    decision: "FINISH",
    success: true,
    effectReceiptIds: ["current-receipt"],
  });
  expect(
    validatedOutcomeCoverage({
      output,
      context: trajectory.context,
      trajectory,
    }),
  ).toBe(true);
});

it("refuses a completed change grounded in an earlier record's printed identity", async () => {
  for (const id of ["note-groceries", "earlier-receipt-5f1c", "history:h1"]) {
    const { output } = await evaluate(finished([id]));
    expect(output.decision).toBe("CONTINUE");
    expect(output.success).toBe(false);
    expect(output.effectReceiptIds).toBeUndefined();
  }
});
