/**
 * Real-PGlite proof that a goal check-in reply is recorded when PA owns the
 * OWNER_GOALS surface (plugin-goals is registered without its actions), and
 * that the next computed goal review keeps the owner's reported progress.
 */
import type { HandlerCallback, Memory, UUID } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { createLifeOpsTestRuntime } from "../../../test/helpers/runtime.js";
import { ownerGoalsAction } from "../../actions/owner-surfaces.js";
import { LifeOpsService } from "../service.js";

it("records a goal check-in through PA OWNER_GOALS and keeps it on the next review", async () => {
  const fixture = await createLifeOpsTestRuntime();
  try {
    const { runtime } = fixture;
    const service = new LifeOpsService(runtime, {
      ownerEntityId: runtime.agentId,
    });
    const created = await service.createGoal({
      title: "Run a 10k",
      description: "Run a 10k",
      cadence: { kind: "weekly" },
      supportStrategy: { approach: "weekly_review" },
      successCriteria: { summary: "Run a 10k", metric: "review_completed" },
      metadata: { source: "goals-checkin-integration" },
    });
    const message = {
      id: crypto.randomUUID() as UUID,
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: crypto.randomUUID() as UUID,
      content: { source: "client_chat", text: "On track, ran 8k" },
    } as Memory;

    const result = await ownerGoalsAction.handler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          action: "checkin",
          target: "Run a 10k",
          note: "ran 8k",
          progress: "on_track",
        },
      },
      vi.fn<HandlerCallback>(async () => []),
    );
    expect(result?.success, JSON.stringify(result)).toBe(true);

    const recorded = (await service.getGoal(created.goal.id)).goal;
    expect(recorded.reviewState).toBe("on_track");
    expect(recorded.metadata.checkinLog).toEqual([
      expect.objectContaining({ note: "ran 8k", progress: "on_track" }),
    ]);

    // The overview recomputes every active goal's review state.
    await service.getOverview();
    expect((await service.getGoal(created.goal.id)).goal.reviewState).toBe(
      "on_track",
    );
  } finally {
    await fixture.cleanup();
  }
}, 180_000);
