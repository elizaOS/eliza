/**
 * The planner's phone instruction says which tool takes which request. The
 * evaluator calls no tools, and that instruction follows the conversation, so
 * an evaluator that received it would be charged for all of it on every call.
 * It judges a phone turn from one constant note instead.
 */
import { readFileSync } from "node:fs";
import {
  type Action,
  type ContextObject,
  ContextRegistry,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { proposeDeviceAction } from "../../services/device-actions/action.ts";

const binding = vi.hoisted(() => ({ turn: undefined as unknown }));
vi.mock("../../services/device-actions/service.ts", async (original) => ({
  ...(await original<
    typeof import("../../services/device-actions/service.ts")
  >()),
  getDeviceActionTurn: () => binding.turn,
  currentAppRecordSource: () => "runtime",
  readDeviceConversationReceipts: async () => [],
  deviceAppRecordOperationAvailable: () => true,
}));

import { createV5MessageContextObject } from "../../services/message/context-assembly.ts";
import { runEvaluator } from "../evaluator.ts";

const PHONE_NOTE_LEAD =
  "This turn is bound to the owner's authenticated phone: a device proposal only asks the owner to approve it on the phone,";
const STAGE1_NOTE =
  "Stage 1 named candidate tools for the current request. " +
  "Candidate names are not authorization. Honor the complete request and its constraints. " +
  "If only a preview, confirmation question, or terminal answer is appropriate, propose REPLY without executing an effect; completion evaluation will check outstanding intents.";
const TOOL_REQUIRED =
  "The Stage 1 router marked this current turn as requiring a tool. " +
  "prior_dialogue_policy: " +
  "Do not answer directly from memory, chat history, prior attachments, or prior tool output. " +
  "Call at least one exposed non-terminal tool that can attempt the current request.";

const notes = {
  name: "NOTES_UPDATE",
  description: "Update a canonical note.",
  contexts: ["notes"],
  parameters: [],
} as unknown as Action;

/** The planner's context for one phone turn, as the message service builds it. */
async function plannerContext(
  options: Record<string, unknown>,
  phone = true,
): Promise<ContextObject> {
  const runtime = {
    agentId: "agent",
    character: { name: "Alpha", bio: [], system: "Answer." },
    contexts: new ContextRegistry([
      { id: "general", description: "General tasks" },
      { id: "notes", description: "Saved notes" },
    ]),
    actions: [notes, proposeDeviceAction],
    providers: [],
    getSetting: () => null,
    getService: () => null,
    getRoom: async () => null,
    getModelRegistrations: () => [],
    reportError: vi.fn(),
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
  binding.turn = phone
    ? {
        runtime,
        credential: {
          capabilities: [
            "notes.local-record.v1",
            "calendar.next-read.v1",
            "clock.handoff.v2",
            "phone.call.v1",
            "sms.compose.v1",
            "contacts.show.v1",
            "open_view",
            "create_note",
          ],
        },
        viewProfile: { views: ["notes", "home"] },
        isCurrent: () => true,
      }
    : undefined;
  const context = await createV5MessageContextObject({
    runtime,
    message: {
      id: "message",
      roomId: "room",
      agentId: "agent",
      entityId: "owner",
      content: { text: "What's on my calendar tomorrow?" },
    } as Memory,
    state: { values: {}, data: {}, text: "" },
    userRoles: ["OWNER"],
    includeTools: true,
    providerPhase: "planning",
    ...options,
  });
  return {
    ...context,
    events: [
      ...context.events,
      // The two notes the message pipeline appends under one id prefix.
      {
        id: "tool-required:1",
        type: "instruction",
        source: "message-service",
        createdAt: 1,
        content: STAGE1_NOTE,
      },
      {
        id: "tool-required:2",
        type: "instruction",
        source: "message-service",
        createdAt: 2,
        content: TOOL_REQUIRED,
      },
    ],
  };
}

async function evaluatorMessages(context: ContextObject) {
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  await runEvaluator({
    context,
    trajectory: {
      context,
      modelBaseContext: context,
      outcomeIntents: ["read tomorrow's calendar"],
      steps: [],
      archivedSteps: [],
      plannedQueue: [],
      evaluatorOutputs: [],
    },
    runtime: {
      useModel: async (_type: unknown, request: (typeof requests)[number]) => {
        requests.push(request);
        return JSON.stringify({
          thought: "Done",
          success: true,
          decision: "FINISH",
          replyEffectStatus: "none",
          messageToUser: "",
        });
      },
    },
  } as never);
  expect(requests).toHaveLength(1);
  const [system, first, ...rest] = requests[0].messages.map((message) => ({
    role: message.role,
    text: String(message.content),
  }));
  return { system: system.text, first: first.text, rest };
}

function phoneInstruction(context: ContextObject): string {
  const event = context.events.find(
    (event) => event.id === "authenticated-phone-capability",
  );
  if (!event || !("content" in event)) throw new Error("no phone instruction");
  return String(event.content);
}

it("judges a phone turn from one constant note, not the planner's routing instruction", async () => {
  const withDeviceTool = await plannerContext({
    selectedContexts: ["general"],
    preselectedActions: [proposeDeviceAction],
  });
  const withoutDeviceTool = await plannerContext({
    selectedContexts: ["notes"],
    preselectedActions: [notes],
  });
  // The planner is told different things on the two turns.
  expect(phoneInstruction(withDeviceTool)).not.toBe(
    phoneInstruction(withoutDeviceTool),
  );
  const systems: string[] = [];
  for (const context of [withDeviceTool, withoutDeviceTool]) {
    const instruction = phoneInstruction(context);
    expect(instruction).toContain("PROPOSE_DEVICE_ACTION");
    const { system, first, rest } = await evaluatorMessages(context);
    for (const text of [system, first, ...rest.map((message) => message.text)])
      expect(text).not.toContain(instruction);
    expect(first).not.toContain("PROPOSE_DEVICE_ACTION");
    expect(first).not.toContain(PHONE_NOTE_LEAD);
    expect(system.split(PHONE_NOTE_LEAD)).toHaveLength(2);
    expect(system).toContain(
      "a proposal, preview or pending receipt is not completion and only a native receipt for that operation establishes it",
    );
    // The planner's own context keeps its instruction for the next round.
    expect(phoneInstruction(context)).toBe(instruction);
    systems.push(system);
  }
  // One note for every phone turn, so the system text is reusable across them.
  expect(systems[0]).toBe(systems[1]);
});

it("drops the planner's candidate-tool note and keeps a tool requirement", async () => {
  const context = await plannerContext({
    selectedContexts: ["notes"],
    preselectedActions: [notes],
  });
  const { system, first } = await evaluatorMessages(context);
  expect(`${system}\n${first}`).not.toContain("Stage 1 named candidate tools");
  expect(first).toContain(TOOL_REQUIRED);
  // The note is matched by how the message pipeline begins it.
  expect(
    readFileSync(
      new URL("../../services/message/pipeline.ts", import.meta.url),
      "utf8",
    ),
  ).toContain('"Stage 1 named candidate tools for the current request. "');
});

it("adds nothing about a phone to a turn that has none", async () => {
  const context = await plannerContext(
    { selectedContexts: ["notes"], preselectedActions: [notes] },
    false,
  );
  expect(
    context.events.some(
      (event) => event.id === "authenticated-phone-capability",
    ),
  ).toBe(false);
  const { system, first } = await evaluatorMessages(context);
  expect(`${system}\n${first}`).not.toContain("authenticated phone");
});
