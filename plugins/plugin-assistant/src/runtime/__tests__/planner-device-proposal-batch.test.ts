/**
 * Nothing resumes a turn once the owner decides on a phone proposal, so a
 * request for two phone operations ("text Sam I'll be late, and set an alarm
 * for 7am") has to propose both before the turn ends. A phone proposal only
 * records a review the owner approves on the phone, so the proposals batched
 * behind the first are recorded too, and a batch that declared more work gets
 * one more planner round. Everything else keeps waiting for the owner.
 */
import type {
  Action,
  ContextEvent,
  ContextObject,
  JsonValue,
  PlannerToolCall,
  PlannerToolResult,
  RecordedStage,
  ToolDefinition,
  TrajectoryRecorder,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { ApprovalEnqueueResult } from "../../services/approval/types.ts";
import {
  DEVICE_APPROVAL_REVIEW_TEXT,
  deviceActionEffectReceipts,
  deviceApprovalPersistenceReceipt,
  isPersistedDeviceApprovalPause,
} from "../../services/device-actions/effect-receipts.ts";
import { runPlannerLoop } from "../planner-loop.ts";

const DEVICE = "PROPOSE_DEVICE_ACTION";
const TEXT_SAM = {
  type: "sms_compose",
  target: { kind: "contact", query: "Sam" },
  body: "I'll be late.",
};
const ALARM_AT_7 = {
  type: "clock_handoff",
  action: "set",
  hour: 7,
  minute: 0,
  label: "Alarm",
  timeZone: "America/Los_Angeles",
  days: [],
};
const NEW_FOLDER = { type: "notes_folder_create", name: "Trips" };
const ADD_SAM = {
  type: "contact_create",
  contact: {
    displayName: "Sam",
    phoneNumbers: ["+14155550100"],
    emailAddresses: [],
  },
};

/** The queue row a proposal leaves, pending until the owner decides. */
function queued(id: string, operation: unknown): ApprovalEnqueueResult {
  const at = new Date("2026-11-20T12:00:00.000Z");
  return {
    reused: false,
    request: {
      id,
      createdAt: at,
      updatedAt: at,
      state: "pending",
      requestedBy: "agent",
      subjectUserId: "owner",
      action: "device_action",
      payload: {
        action: "device_action",
        version: 1,
        installationId: "phone",
        enrollmentId: "enrollment",
        operation,
      } as ApprovalEnqueueResult["request"]["payload"],
      channel: "sms",
      reason: "The owner asked for it.",
      idempotencyKey: `device:${id}`,
      expiresAt: new Date(Date.now() + 600_000),
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
      execution: null,
    },
  };
}

/** What the device tool returns once its review is recorded, built from the
 * receipts the tool itself attaches. */
function pendingReview(id: string, operation: unknown): PlannerToolResult {
  const outcome = queued(id, operation);
  return {
    success: true,
    transcriptVisibility: "internal",
    modelReplyRequired: true,
    effectReceipts: deviceActionEffectReceipts(outcome),
    userFacingText: DEVICE_APPROVAL_REVIEW_TEXT,
    text: "Durable device proposal state: pending. This tool has performed no device operation.",
    data: {
      proposalId: id,
      state: "pending",
      executed: false,
      approvalPersistence: deviceApprovalPersistenceReceipt(outcome),
      awaitingUserInput: true,
      approvalRequired: true,
    },
  };
}

type Call = { name: string; arguments: Record<string, JsonValue> };
const propose = (
  operation: Record<string, JsonValue>,
  scope: "final" | "more_work_pending",
  name = DEVICE,
): Call => ({
  name,
  arguments: {
    operation,
    operationKey: `${operation.type}-${scope}`,
    reason: "The owner asked for it.",
    eliza_turn_scope: scope,
  },
});
const remind = (scope: "final" | "more_work_pending"): Call => ({
  name: "OWNER_REMINDERS_CREATE",
  arguments: { title: "Call Sam", eliza_turn_scope: scope },
});

const tool = (name: string): ToolDefinition => ({
  name,
  description: `${name}.`,
  parameters: { type: "object", properties: {} },
});

/** The tool as the message service lists it: with the action it came from. */
const exposed = (name: string, egress?: readonly string[]): ContextEvent => ({
  id: `tool:${name}`,
  type: "tool",
  source: "message-service",
  tool: {
    name,
    action: { name, ...(egress ? { egress } : {}) } as Action,
  },
});

async function run(
  rounds: Array<Call[] | Error>,
  options: {
    events?: ContextEvent[];
    tools?: string[];
    /** What each call returns; a recorded review unless stated. */
    execute?: (call: PlannerToolCall, index: number) => PlannerToolResult;
    /** Prompt tokens each planner call reports, and the turn's allowance. */
    promptTokens?: { perCall: number; allowed: number };
  } = {},
) {
  let plannerCalls = 0;
  let evaluations = 0;
  const executed: PlannerToolCall[] = [];
  const pauses: RecordedStage[] = [];
  const recorder: TrajectoryRecorder = {
    startTrajectory: () => "two-step",
    recordStage: async (_id, stage) => {
      if (stage.kind === "evaluation") pauses.push(stage);
    },
    endTrajectory: async () => {},
    load: async () => null,
    list: async () => [],
  };
  const context: ContextObject = {
    id: "two-step",
    events: options.events ?? [],
  };
  const result = await runPlannerLoop({
    runtime: {
      useModel: async () => {
        const round = rounds[plannerCalls++];
        if (!round) throw new Error("Unexpected planner call");
        if (round instanceof Error) throw round;
        return {
          text: "",
          toolCalls: round.map((call, index) => ({
            id: `call-${plannerCalls}-${index}`,
            ...call,
          })),
          ...(options.promptTokens
            ? {
                usage: {
                  promptTokens: options.promptTokens.perCall,
                  completionTokens: 1,
                  totalTokens: options.promptTokens.perCall + 1,
                },
              }
            : {}),
        };
      },
    },
    context,
    ...(options.promptTokens
      ? {
          config: { maxTrajectoryPromptTokens: options.promptTokens.allowed },
        }
      : {}),
    tools: [
      ...(options.tools ?? []),
      DEVICE,
      "OWNER_REMINDERS_CREATE",
      "REPLY",
    ].map(tool),
    executeToolCall: async (call) => {
      executed.push(call);
      return (
        options.execute?.(call, executed.length - 1) ??
        pendingReview(`proposal-${executed.length}`, call.params?.operation)
      );
    },
    evaluate: async () => {
      evaluations++;
      return { success: true, decision: "FINISH", thought: "Evaluated." };
    },
    recorder,
    trajectoryId: "two-step",
  });
  return {
    result,
    plannerCalls,
    evaluations,
    pauses,
    executed: executed.map((call) => ({
      name: call.name,
      type: (call.params?.operation as { type?: string } | undefined)?.type,
    })),
    queuedNames: result.trajectory.plannedQueue.map((call) => call.name),
  };
}

/** The turn ended waiting for the owner, and said so once. */
function expectOnePause(turn: Awaited<ReturnType<typeof run>>) {
  expect(turn.evaluations).toBe(0);
  expect(turn.pauses).toHaveLength(1);
  expect(turn.pauses[0].evaluation?.reason).toBe(
    "durable_approval_awaiting_user_input",
  );
  expect(turn.result.status).toBe("finished");
  expect(turn.result.finalMessage).toBe(DEVICE_APPROVAL_REVIEW_TEXT);
  expect(turn.result.evaluator).toMatchObject({
    success: false,
    decision: "FINISH",
    requestFullyCovered: false,
    replyEffectStatus: "non_applied",
    messageToUser: DEVICE_APPROVAL_REVIEW_TEXT,
  });
  expect(turn.result.evaluator?.thought).toContain(
    "no dependent operation ran",
  );
}

describe("phone proposals batched behind a recorded one", () => {
  it("records both proposals of one batch and pauses once", async () => {
    const turn = await run([
      [propose(TEXT_SAM, "final"), propose(ALARM_AT_7, "final")],
    ]);
    expect(turn.plannerCalls).toBe(1);
    expect(turn.executed).toEqual([
      { name: DEVICE, type: "sms_compose" },
      { name: DEVICE, type: "clock_handoff" },
    ]);
    expect(turn.queuedNames).toEqual([]);
    expectOnePause(turn);
    // Each is its own review on the phone; neither is approved or run here.
    const reviews = turn.result.trajectory.steps.map((step) => step.result);
    expect(reviews).toHaveLength(2);
    expect(reviews.every(isPersistedDeviceApprovalPause)).toBe(true);
    expect(
      new Set(reviews.map((review) => review?.data?.proposalId)).size,
    ).toBe(2);
    expect(turn.result.evaluator?.thought).toContain("2 durable device");
  });

  it("records a proposal that needs the first one's effect as its own review", async () => {
    // "Add Sam as a contact and text them": the text is reviewable before the
    // contact exists. Both stay pending and unexecuted; the phone resolves
    // the name only when the owner opens that review.
    const turn = await run([
      [propose(ADD_SAM, "final"), propose(TEXT_SAM, "final")],
    ]);
    expect(turn.executed.map((call) => call.type)).toEqual([
      "contact_create",
      "sms_compose",
    ]);
    for (const step of turn.result.trajectory.steps)
      expect(step.result?.data).toMatchObject({
        state: "pending",
        executed: false,
        approvalRequired: true,
      });
    expectOnePause(turn);
  });

  it("leaves a call that is not a phone proposal unrun", async () => {
    const turn = await run([[propose(TEXT_SAM, "final"), remind("final")]]);
    expect(turn.plannerCalls).toBe(1);
    expect(turn.executed).toEqual([{ name: DEVICE, type: "sms_compose" }]);
    expect(turn.queuedNames).toEqual(["OWNER_REMINDERS_CREATE"]);
    expectOnePause(turn);
  });

  it("stops at the first call that is not a phone proposal", async () => {
    const turn = await run([
      [
        propose(TEXT_SAM, "final"),
        remind("final"),
        propose(ALARM_AT_7, "final"),
      ],
    ]);
    expect(turn.executed).toEqual([{ name: DEVICE, type: "sms_compose" }]);
    expect(turn.queuedNames).toEqual(["OWNER_REMINDERS_CREATE", DEVICE]);
    expectOnePause(turn);
  });

  it("stops when a batched proposal is refused", async () => {
    const turn = await run(
      [
        [
          propose(TEXT_SAM, "final"),
          propose(ALARM_AT_7, "final"),
          propose(ADD_SAM, "final"),
        ],
      ],
      {
        execute: (call, index) =>
          index === 1
            ? {
                success: false,
                text: "Clock observation unavailable or changed",
              }
            : pendingReview(`proposal-${index}`, call.params?.operation),
      },
    );
    expect(turn.plannerCalls).toBe(1);
    expect(turn.executed.map((call) => call.type)).toEqual([
      "sms_compose",
      "clock_handoff",
    ]);
    expect(turn.queuedNames).toEqual([DEVICE]);
    // The recorded review still stands and is what the owner is told about.
    expectOnePause(turn);
  });

  it("does not record the same operation twice", async () => {
    const again = propose(TEXT_SAM, "final");
    again.arguments.operationKey = "a-second-key";
    const turn = await run([[propose(TEXT_SAM, "final"), again]]);
    expect(turn.executed).toEqual([{ name: DEVICE, type: "sms_compose" }]);
    expect(turn.queuedNames).toEqual([DEVICE]);
    expectOnePause(turn);
  });

  it("recognises a single-operation phone tool by what its action declares", async () => {
    const turn = await run(
      [
        [
          propose(TEXT_SAM, "final"),
          propose(NEW_FOLDER, "final", "DEVICE_FOLDER"),
          // Named like one, but it also reaches the network and runs at once.
          propose({ type: "fetch" }, "final", "DEVICE_FETCH"),
          propose(ALARM_AT_7, "final"),
        ],
      ],
      {
        tools: ["DEVICE_FOLDER", "DEVICE_FETCH"],
        events: [
          exposed(DEVICE, ["owner-device"]),
          exposed("DEVICE_FOLDER", ["owner-device"]),
          exposed("DEVICE_FETCH", ["owner-device", "public-network"]),
        ],
      },
    );
    expect(turn.executed.map((call) => call.name)).toEqual([
      DEVICE,
      "DEVICE_FOLDER",
    ]);
    expect(turn.queuedNames).toEqual(["DEVICE_FETCH", DEVICE]);
    expectOnePause(turn);
  });

  it("leaves a tool unrun when nothing declares it a phone proposal", async () => {
    const turn = await run(
      [
        [
          propose(TEXT_SAM, "final"),
          propose(NEW_FOLDER, "final", "DEVICE_FOLDER"),
        ],
      ],
      { tools: ["DEVICE_FOLDER"] },
    );
    expect(turn.executed.map((call) => call.name)).toEqual([DEVICE]);
    expect(turn.queuedNames).toEqual(["DEVICE_FOLDER"]);
    expectOnePause(turn);
  });
});

describe("a recorded proposal whose batch declared more work", () => {
  it("plans exactly once more and records what that round proposes", async () => {
    const turn = await run([
      [propose(TEXT_SAM, "more_work_pending")],
      // Still pending after the extra round: no third round follows.
      [propose(ALARM_AT_7, "more_work_pending")],
    ]);
    expect(turn.plannerCalls).toBe(2);
    expect(turn.executed).toEqual([
      { name: DEVICE, type: "sms_compose" },
      { name: DEVICE, type: "clock_handoff" },
    ]);
    expectOnePause(turn);
  });

  it("plans once more after a batch of several proposals too", async () => {
    const turn = await run([
      [
        propose(TEXT_SAM, "more_work_pending"),
        propose(ALARM_AT_7, "more_work_pending"),
      ],
      [propose(ADD_SAM, "final")],
    ]);
    expect(turn.plannerCalls).toBe(2);
    expect(turn.executed.map((call) => call.type)).toEqual([
      "sms_compose",
      "clock_handoff",
      "contact_create",
    ]);
    expectOnePause(turn);
  });

  it("runs nothing but phone proposals from the extra round", async () => {
    const turn = await run([
      [propose(TEXT_SAM, "more_work_pending")],
      [remind("final"), propose(ALARM_AT_7, "final")],
    ]);
    expect(turn.plannerCalls).toBe(2);
    expect(turn.executed).toEqual([{ name: DEVICE, type: "sms_compose" }]);
    expect(turn.queuedNames).toEqual(["OWNER_REMINDERS_CREATE", DEVICE]);
    expectOnePause(turn);
  });

  it("keeps the pause when the extra round only replies", async () => {
    const turn = await run([
      [propose(TEXT_SAM, "more_work_pending")],
      [
        {
          name: "REPLY",
          arguments: {
            text: "I texted Sam and set your alarm.",
            eliza_turn_scope: "final",
          },
        },
      ],
    ]);
    expect(turn.plannerCalls).toBe(2);
    expect(turn.executed).toEqual([{ name: DEVICE, type: "sms_compose" }]);
    // The round's own words never replace the review notice.
    expectOnePause(turn);
  });

  it("does not record the first operation again under a new key", async () => {
    const again = propose(TEXT_SAM, "final");
    again.arguments.operationKey = "a-second-key";
    const turn = await run([[propose(TEXT_SAM, "more_work_pending")], [again]]);
    expect(turn.plannerCalls).toBe(2);
    expect(turn.executed).toEqual([{ name: DEVICE, type: "sms_compose" }]);
    expectOnePause(turn);
  });

  it("keeps the pause when the extra round's model call is refused", async () => {
    // An outage, which the planner does not wait out and re-send.
    const refused = Object.assign(new Error("Unavailable"), { status: 503 });
    const turn = await run([[propose(TEXT_SAM, "more_work_pending")], refused]);
    expect(turn.plannerCalls).toBe(2);
    expect(turn.executed).toEqual([{ name: DEVICE, type: "sms_compose" }]);
    expect(turn.result.terminalFailure).toBeUndefined();
    expectOnePause(turn);
  });

  it("keeps the pause when the extra round spends the turn's prompt allowance", async () => {
    const turn = await run(
      [
        [propose(TEXT_SAM, "more_work_pending")],
        [propose(ALARM_AT_7, "final")],
      ],
      { promptTokens: { perCall: 60, allowed: 100 } },
    );
    expect(turn.plannerCalls).toBe(2);
    expect(turn.executed).toEqual([{ name: DEVICE, type: "sms_compose" }]);
    expect(turn.result.terminalFailure).toBeUndefined();
    expectOnePause(turn);
  });

  it("does not plan again while a call that is not a phone proposal waits", async () => {
    const turn = await run([
      [propose(TEXT_SAM, "more_work_pending"), remind("more_work_pending")],
    ]);
    expect(turn.plannerCalls).toBe(1);
    expect(turn.executed).toEqual([{ name: DEVICE, type: "sms_compose" }]);
    expect(turn.queuedNames).toEqual(["OWNER_REMINDERS_CREATE"]);
    expectOnePause(turn);
  });

  it("does not plan again after a batched proposal was refused", async () => {
    const turn = await run(
      [
        [
          propose(TEXT_SAM, "more_work_pending"),
          propose(ALARM_AT_7, "more_work_pending"),
        ],
      ],
      {
        execute: (call, index) =>
          index === 1
            ? { success: false, text: "Clock observation unavailable." }
            : pendingReview(`proposal-${index}`, call.params?.operation),
      },
    );
    expect(turn.plannerCalls).toBe(1);
    expect(turn.executed).toHaveLength(2);
    expectOnePause(turn);
  });
});

describe("a single proposal that declared the request covered", () => {
  it("pauses as before, with no extra round", async () => {
    const turn = await run([[propose(TEXT_SAM, "final")]]);
    expect(turn.plannerCalls).toBe(1);
    expect(turn.executed).toEqual([{ name: DEVICE, type: "sms_compose" }]);
    expect(turn.queuedNames).toEqual([]);
    expectOnePause(turn);
    expect(turn.result.evaluator).toEqual({
      success: false,
      decision: "FINISH",
      requestFullyCovered: false,
      replyEffectStatus: "non_applied",
      thought:
        "The durable device proposal is waiting for explicit owner input. Requested work remains incomplete; no dependent operation ran.",
      messageToUser: DEVICE_APPROVAL_REVIEW_TEXT,
    });
    expect(turn.result.trajectory.steps).toHaveLength(1);
  });
});
