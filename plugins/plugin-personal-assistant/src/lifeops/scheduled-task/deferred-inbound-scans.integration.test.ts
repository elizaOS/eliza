/**
 * Acceptance for #15255 on the real runtime bus: proves a PA `MESSAGE_RECEIVED`
 * turn's awaited edge is independent of scheduled-task scan latency, and that
 * the trajectory-stamp constraint (synchronous stamping stays on the awaited
 * edge) still holds. Uses the real PA + scheduling plugins over a DB-backed
 * runner (createLifeOpsTestRuntime); an artificially slow scan is injected
 * through `runtime.registerEvent` so the 1000ms sleep is real, not stubbed.
 */

import {
  EventType,
  type IAgentRuntime,
  type Memory,
  type MessagePayload,
  stringToUuid,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.ts";
import { resolvePendingPromptsStore } from "../pending-prompts/store.ts";
import { LifeOpsRepository } from "../repository.ts";
import {
  detachInboundScan,
  settleDeferredInboundScans,
} from "./deferred-inbound-scans.ts";
import type { ScheduledTask } from "./index.ts";

type Runtime = RealTestRuntimeResult["runtime"];

const OWNER_ENTITY_ID = "owner-entity-1";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Owner-gated so the completion pass's owner check resolves (same pattern as
 * scheduler.integration.test.ts / inbound-reply-completion.integration.test.ts). */
async function createOwnerScopedRuntime(): Promise<RealTestRuntimeResult> {
  const result = await createLifeOpsTestRuntime();
  result.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", OWNER_ENTITY_ID, false);
  return result;
}

async function seedFiredUserRepliedTask(
  runtime: Runtime,
  roomId: string,
): Promise<ScheduledTask> {
  const repo = new LifeOpsRepository(runtime);
  const task: ScheduledTask = {
    taskId: `st_fired_${Math.random().toString(36).slice(2, 10)}`,
    kind: "checkin",
    promptInstructions: "How did it go?",
    trigger: { kind: "manual" },
    priority: "medium",
    respectsGlobalPause: false,
    source: "user_chat",
    createdBy: runtime.agentId,
    ownerVisible: true,
    completionCheck: { kind: "user_replied_within" },
    metadata: { pendingPromptRoomId: roomId },
    state: {
      status: "fired",
      firedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      followupCount: 0,
    },
  };
  await repo.upsertScheduledTask(runtime.agentId, task);
  await resolvePendingPromptsStore(runtime).record({
    roomId,
    taskId: task.taskId,
    promptSnippet: task.promptInstructions,
    firedAt: task.state.firedAt as string,
    expectedReplyKind: "free_form",
  });
  return task;
}

function ownerReply(runtime: Runtime, roomId: string): Memory {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    entityId: OWNER_ENTITY_ID,
    roomId,
    agentId: runtime.agentId,
    content: { text: "done!" },
    createdAt: Date.now(),
  } as unknown as Memory;
}

async function persistedStatus(
  runtime: Runtime,
  taskId: string,
): Promise<string | undefined> {
  const repo = new LifeOpsRepository(runtime);
  const task = await repo.getScheduledTask(runtime.agentId, taskId);
  return task?.state.status;
}

describe("deferred inbound scans — TTFT independence (#15255)", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    // Drain any scans still in flight before tearing the runtime down so a late
    // scan can't touch a disposed store.
    await settleDeferredInboundScans();
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("a 1000ms scan does not delay the awaited MESSAGE_RECEIVED edge, yet the completion still lands", async () => {
    runtimeResult = await createOwnerScopedRuntime();
    const { runtime } = runtimeResult;
    const roomId = "room-ttft-1";
    const task = await seedFiredUserRepliedTask(runtime, roomId);

    // Inject a genuinely slow scan on the real bus, wrapped exactly as the PA
    // handlers are, so it is deferred and drained the same way.
    let slowScanRan = false;
    runtime.registerEvent(
      EventType.MESSAGE_RECEIVED,
      detachInboundScan("acceptance-slow-scan", async () => {
        await sleep(1000);
        slowScanRan = true;
      }),
    );

    const startedAt = performance.now();
    await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      message: ownerReply(runtime, roomId),
    });
    const emitMs = performance.now() - startedAt;

    // The awaited edge returns before the 1000ms scan finishes — TTFT is
    // independent of scan latency.
    expect(slowScanRan).toBe(false);
    expect(emitMs).toBeLessThan(500);

    // Scans still run: drain them and confirm both the injected scan and the
    // real PA completion landed.
    await settleDeferredInboundScans();
    expect(slowScanRan).toBe(true);
    expect(await persistedStatus(runtime, task.taskId)).toBe("completed");
    expect(await resolvePendingPromptsStore(runtime).list(roomId)).toHaveLength(
      0,
    );
  }, 180_000);

  it("synchronous trajectory stamping stays on the awaited edge while scans are deferred", async () => {
    runtimeResult = await createOwnerScopedRuntime();
    const { runtime } = runtimeResult;

    // Mirror the core trajectories handler: stamp trajectoryStepId synchronously
    // (no await) so message.ts can read it the instant emitEvent resolves.
    const stampedStepId = stringToUuid("stamp-guard-step");
    (runtime as IAgentRuntime).registerEvent(
      EventType.MESSAGE_RECEIVED,
      async (payload: MessagePayload) => {
        const message = payload.message;
        if (!message.metadata) {
          message.metadata = { type: "message" };
        }
        (message.metadata as Record<string, unknown>).trajectoryStepId =
          stampedStepId;
      },
    );

    let slowScanRan = false;
    runtime.registerEvent(
      EventType.MESSAGE_RECEIVED,
      detachInboundScan("stamp-guard-slow", async () => {
        await sleep(1000);
        slowScanRan = true;
      }),
    );

    const message = ownerReply(runtime, "room-stamp-guard");
    await runtime.emitEvent(EventType.MESSAGE_RECEIVED, { message });

    // The stamp is present immediately after emitEvent resolves...
    expect((message.metadata as Record<string, unknown>).trajectoryStepId).toBe(
      stampedStepId,
    );
    // ...even though the deferred scan has not finished.
    expect(slowScanRan).toBe(false);

    await settleDeferredInboundScans();
    expect(slowScanRan).toBe(true);
  }, 180_000);
});
