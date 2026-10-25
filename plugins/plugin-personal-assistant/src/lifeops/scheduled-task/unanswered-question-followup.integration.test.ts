/**
 * Unanswered-question follow-up (#14676) against the real spine: a real
 * runtime (PA + scheduling plugins, DB-backed runner), models stubbed at the
 * runtime boundary. Covers registration from an agent reply, supersede,
 * owner-reply cancellation through the registered MESSAGE_RECEIVED handler,
 * and the fire path where the model_moment_check judge (#14677) decides —
 * including the quiet-hours hard constraint composing BEFORE the judge.
 */

import {
  ChannelType,
  EventType,
  type Memory,
  ModelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { ScheduledTask } from "@elizaos/plugin-scheduling";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.ts";
import { createOwnerFactStore } from "../owner/fact-store.js";
import { settleDeferredInboundScans } from "./deferred-inbound-scans.js";
import { getScheduledTaskRunner } from "./service.js";
import {
  cancelQuestionFollowupsOnOwnerReply,
  extractTrailingQuestion,
  isUnansweredQuestionFollowupTask,
  registerQuestionFollowupForAgentMessage,
  UNANSWERED_QUESTION_FOLLOWUP_DELAY_MINUTES,
} from "./unanswered-question-followup.js";

type Runtime = RealTestRuntimeResult["runtime"];

interface SeededRoom {
  roomId: UUID;
  ownerEntityId: UUID;
}

let seedCounter = 0;

async function seedOwnerRoom(runtime: Runtime): Promise<SeededRoom> {
  seedCounter += 1;
  const roomId = stringToUuid(`uqf-room-${seedCounter}`);
  const ownerEntityId = stringToUuid(`uqf-owner-${seedCounter}`);
  // hasRoleAccess fails CLOSED for senders whose role cannot be resolved, so
  // the owner gate needs the canonical-owner setting the production first-run
  // flow records (same pattern as scheduler.integration.test.ts).
  runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", ownerEntityId, false);
  await runtime.ensureConnection({
    entityId: ownerEntityId,
    roomId,
    worldId: stringToUuid(`uqf-world-${seedCounter}`),
    worldName: "UQF",
    userName: "Owner",
    name: "Owner",
    source: "test",
    type: ChannelType.DM,
    channelId: `uqf-${seedCounter}`,
  });
  return { roomId, ownerEntityId };
}

async function persistOwnerMessage(
  runtime: Runtime,
  room: SeededRoom,
  text: string,
): Promise<UUID> {
  seedCounter += 1;
  const id = stringToUuid(`uqf-inbound-${seedCounter}`);
  await runtime.createMemory(
    {
      id,
      agentId: runtime.agentId as UUID,
      roomId: room.roomId,
      entityId: room.ownerEntityId,
      content: { text, source: "test" },
      createdAt: Date.now() - 1_000,
    } as Memory,
    "messages",
  );
  return id;
}

function agentReply(
  runtime: Runtime,
  room: SeededRoom,
  text: string,
  inReplyTo?: UUID,
): Memory {
  seedCounter += 1;
  return {
    id: stringToUuid(`uqf-reply-${seedCounter}`),
    agentId: runtime.agentId as UUID,
    roomId: room.roomId,
    entityId: runtime.agentId as UUID,
    content: {
      text,
      source: "test",
      ...(inReplyTo ? { inReplyTo } : {}),
    },
    createdAt: Date.now(),
  } as Memory;
}

async function listQuestionFollowups(
  runtime: Runtime,
  roomId: string,
  status: ScheduledTask["state"]["status"] = "scheduled",
): Promise<ScheduledTask[]> {
  const runner = getScheduledTaskRunner(runtime, {
    agentId: String(runtime.agentId),
  });
  const tasks = await runner.list({ kind: "followup", status });
  return tasks.filter((task) => isUnansweredQuestionFollowupTask(task, roomId));
}

/** Register a TEXT_SMALL judge stub; returns the prompts it received. */
function stubMomentJudge(runtime: Runtime, output: string | Error): string[] {
  const prompts: string[] = [];
  runtime.registerModel(
    ModelType.TEXT_SMALL,
    async (_rt: unknown, params: { prompt: string }) => {
      prompts.push(params.prompt);
      if (output instanceof Error) throw output;
      return output;
    },
    "uqf-judge-stub",
  );
  return prompts;
}

describe("extractTrailingQuestion", () => {
  it("extracts the final question sentence", () => {
    expect(
      extractTrailingQuestion(
        "Booked the table for 7. Do you want me to invite Sam too?",
      ),
    ).toBe("Do you want me to invite Sam too?");
  });

  it("returns null when the reply does not end with a question", () => {
    expect(extractTrailingQuestion("Done! The table is booked.")).toBeNull();
    expect(
      extractTrailingQuestion("Is it raining? Yes — take an umbrella."),
    ).toBeNull();
    expect(extractTrailingQuestion("")).toBeNull();
  });

  it("allows closing quotes after the question mark", () => {
    expect(extractTrailingQuestion('She asked "are you coming?"')).toBe(
      'She asked "are you coming?"',
    );
  });
});

describe("unanswered-question follow-up — real spine", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("registers a once follow-up with judge-gated admission for an agent question", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const room = await seedOwnerRoom(runtime);
    const inboundId = await persistOwnerMessage(runtime, room, "any ideas?");

    const before = Date.now();
    const registration = await registerQuestionFollowupForAgentMessage(
      runtime,
      agentReply(runtime, room, "A few! What time works for you?", inboundId),
    );
    expect(registration).not.toBeNull();
    const fireAtMs = Date.parse(registration?.fireAtIso ?? "");
    expect(fireAtMs).toBeGreaterThanOrEqual(
      before + (UNANSWERED_QUESTION_FOLLOWUP_DELAY_MINUTES - 1) * 60_000,
    );
    expect(fireAtMs).toBeLessThanOrEqual(
      Date.now() + (UNANSWERED_QUESTION_FOLLOWUP_DELAY_MINUTES + 1) * 60_000,
    );

    const scheduled = await listQuestionFollowups(runtime, room.roomId);
    expect(scheduled).toHaveLength(1);
    const task = scheduled[0] as ScheduledTask;
    expect(task.kind).toBe("followup");
    expect(task.trigger.kind).toBe("once");
    expect(task.shouldFire?.compose).toBe("first_deny");
    expect(task.shouldFire?.gates.map((gate) => gate.kind)).toEqual([
      "quiet_hours",
      "model_moment_check",
    ]);
    expect(task.completionCheck?.kind).toBe("user_replied_within");
    expect(task.metadata?.pendingPromptRoomId).toBe(room.roomId);
    expect(task.metadata?.questionSnippet).toBe("What time works for you?");
    expect(task.ownerVisible).toBe(true);
    expect(task.promptInstructions).toContain("What time works for you?");
  });

  it("registers nothing without a trailing question or without an owner inbound", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const room = await seedOwnerRoom(runtime);
    const inboundId = await persistOwnerMessage(runtime, room, "thanks!");

    // No trailing question.
    expect(
      await registerQuestionFollowupForAgentMessage(
        runtime,
        agentReply(runtime, room, "You're welcome. All done.", inboundId),
      ),
    ).toBeNull();
    // Question, but not a reply to any inbound message.
    expect(
      await registerQuestionFollowupForAgentMessage(
        runtime,
        agentReply(runtime, room, "Want me to keep going?"),
      ),
    ).toBeNull();
    // Question, but the referenced inbound does not exist.
    expect(
      await registerQuestionFollowupForAgentMessage(
        runtime,
        agentReply(
          runtime,
          room,
          "Want me to keep going?",
          stringToUuid("uqf-missing-inbound"),
        ),
      ),
    ).toBeNull();
    // A non-agent message never registers.
    expect(
      await registerQuestionFollowupForAgentMessage(runtime, {
        id: stringToUuid("uqf-user-msg"),
        agentId: runtime.agentId as UUID,
        roomId: room.roomId,
        entityId: room.ownerEntityId,
        content: { text: "can you hear me?", inReplyTo: inboundId },
        createdAt: Date.now(),
      } as Memory),
    ).toBeNull();
    expect(await listQuestionFollowups(runtime, room.roomId)).toHaveLength(0);
  });

  it("a newer agent question supersedes the scheduled follow-up (one per room)", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const room = await seedOwnerRoom(runtime);
    const inboundId = await persistOwnerMessage(runtime, room, "hm");

    const first = await registerQuestionFollowupForAgentMessage(
      runtime,
      agentReply(runtime, room, "Should I book the flight?", inboundId),
    );
    const second = await registerQuestionFollowupForAgentMessage(
      runtime,
      agentReply(
        runtime,
        room,
        "Or would you rather take the train?",
        inboundId,
      ),
    );
    expect(first).not.toBeNull();
    expect(second?.supersededTaskIds).toEqual([first?.taskId]);

    const scheduled = await listQuestionFollowups(runtime, room.roomId);
    expect(scheduled.map((task) => task.taskId)).toEqual([second?.taskId]);
    const dismissed = await listQuestionFollowups(
      runtime,
      room.roomId,
      "dismissed",
    );
    expect(dismissed.map((task) => task.taskId)).toEqual([first?.taskId]);
  });

  it("an owner reply through MESSAGE_RECEIVED dismisses the scheduled follow-up", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const room = await seedOwnerRoom(runtime);
    const inboundId = await persistOwnerMessage(runtime, room, "let me think");

    const registration = await registerQuestionFollowupForAgentMessage(
      runtime,
      agentReply(runtime, room, "Take your time — red or blue?", inboundId),
    );
    expect(registration).not.toBeNull();

    // The REAL seam: the plugin's registered events[MESSAGE_RECEIVED] handler.
    await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      runtime,
      message: {
        id: stringToUuid("uqf-owner-answer"),
        agentId: runtime.agentId as UUID,
        roomId: room.roomId,
        entityId: room.ownerEntityId,
        content: { text: "blue", source: "test" },
        createdAt: Date.now(),
      } as Memory,
      source: "test",
    });
    // The dismissal scan runs detached off the awaited emit edge (#15255).
    await settleDeferredInboundScans();

    expect(await listQuestionFollowups(runtime, room.roomId)).toHaveLength(0);
    const dismissed = await listQuestionFollowups(
      runtime,
      room.roomId,
      "dismissed",
    );
    expect(dismissed.map((task) => task.taskId)).toEqual([
      registration?.taskId,
    ]);
  });

  it("the agent's own outbound never cancels the follow-up", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const room = await seedOwnerRoom(runtime);
    const inboundId = await persistOwnerMessage(runtime, room, "hm");
    await registerQuestionFollowupForAgentMessage(
      runtime,
      agentReply(runtime, room, "Should I proceed?", inboundId),
    );
    const dismissed = await cancelQuestionFollowupsOnOwnerReply(
      runtime,
      agentReply(runtime, room, "Still there?"),
    );
    expect(dismissed).toEqual([]);
    expect(await listQuestionFollowups(runtime, room.roomId)).toHaveLength(1);
  });

  it("fire path honors a judge drop verdict (task skipped, nothing dispatched)", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const prompts = stubMomentJudge(
      runtime,
      '{"decision":"drop","reason":"owner moved on"}',
    );
    const room = await seedOwnerRoom(runtime);
    const inboundId = await persistOwnerMessage(runtime, room, "hm");
    const registration = await registerQuestionFollowupForAgentMessage(
      runtime,
      agentReply(runtime, room, "Want the summary emailed?", inboundId),
    );

    const runner = getScheduledTaskRunner(runtime, {
      agentId: String(runtime.agentId),
    });
    const result = await runner.fireWithResult(String(registration?.taskId));
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") {
      expect(result.reason).toContain("model_moment_check");
      expect(result.reason).toContain("owner moved on");
    }
    // The judge saw the open question and the owner context.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Want the summary emailed?");
    expect(prompts[0]).toContain("last seen active");
  });

  it("fire path honors a judge send verdict (task fires and dispatches)", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    stubMomentJudge(runtime, '{"decision":"send","reason":"good moment"}');
    const room = await seedOwnerRoom(runtime);
    const inboundId = await persistOwnerMessage(runtime, room, "hm");
    const registration = await registerQuestionFollowupForAgentMessage(
      runtime,
      agentReply(runtime, room, "Want the summary emailed?", inboundId),
    );

    const runner = getScheduledTaskRunner(runtime, {
      agentId: String(runtime.agentId),
    });
    const result = await runner.fireWithResult(String(registration?.taskId));
    expect(result.kind).toBe("fired");
    if (result.kind === "fired") {
      expect(result.task.state.status).toBe("fired");
    }
  });

  it("owner-set quiet hours defer BEFORE the judge is ever consulted (hard constraint)", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const prompts = stubMomentJudge(
      runtime,
      new Error("judge must not be consulted inside quiet hours"),
    );
    // All-day quiet hours make the defer deterministic regardless of wall time.
    await createOwnerFactStore(runtime).update(
      {
        quietHours: {
          startLocal: "00:00",
          endLocal: "23:59",
          timezone: "UTC",
        },
      },
      { source: "profile_save", recordedAt: new Date().toISOString() },
    );
    const room = await seedOwnerRoom(runtime);
    const inboundId = await persistOwnerMessage(runtime, room, "hm");
    const registration = await registerQuestionFollowupForAgentMessage(
      runtime,
      agentReply(runtime, room, "Want the summary emailed?", inboundId),
    );

    const runner = getScheduledTaskRunner(runtime, {
      agentId: String(runtime.agentId),
    });
    const result = await runner.fireWithResult(String(registration?.taskId));
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") {
      expect(result.reason).toContain("quiet_hours");
    }
    expect(prompts).toHaveLength(0);
  });
});
