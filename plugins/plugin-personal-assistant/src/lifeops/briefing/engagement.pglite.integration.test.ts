/**
 * Real-PGLite coverage for briefing impression persistence, receipt-based
 * engagement attribution, deterministic ignore reconciliation, and durable
 * reset controls. The event payloads use production ACTION_COMPLETED shapes;
 * only the external owner actions themselves are represented as fixtures.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionEventPayload, AgentRuntime, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { LifeOpsRepository } from "../repository.js";
import {
  handleBriefEngagementActionCompleted,
  processBriefEngagementActionCompleted,
} from "./engagement.js";

const AGENT_ROOM_ID = "00000000-0000-4000-8000-000000000101" as UUID;
const WORLD_ID = "00000000-0000-4000-8000-000000000102" as UUID;
const MESSAGE_ID = "00000000-0000-4000-8000-000000000103" as UUID;

function completedPayload(args: {
  runtime: AgentRuntime;
  action: string;
  actionResult: Record<string, unknown>;
}): ActionEventPayload {
  return {
    runtime: args.runtime,
    roomId: AGENT_ROOM_ID,
    world: WORLD_ID,
    messageId: MESSAGE_ID,
    content: {
      text: `${args.action} completed`,
      actions: [args.action],
      actionStatus: "completed",
      actionResult: args.actionResult,
    },
  } as unknown as ActionEventPayload;
}

function briefPayload(args: {
  runtime: AgentRuntime;
  briefingId?: string;
  generatedAt: string;
  malformedItemId?: boolean;
}): ActionEventPayload {
  return completedPayload({
    runtime: args.runtime,
    action: "BRIEF",
    actionResult: {
      success: true,
      data: {
        briefing: {
          id: args.briefingId ?? "brief-observed",
          generatedAt: args.generatedAt,
          editorial: {
            items: [
              {
                itemId: args.malformedItemId
                  ? "life:foreign-occurrence"
                  : "life:occurrence-1",
                source: "life",
                kind: "todo",
                sourceId: "occurrence-1",
                itemClass: "life:todo",
              },
              {
                itemId: "calendar:event-1",
                source: "calendar",
                kind: "meeting",
                sourceId: "event-1",
                itemClass: "calendar:meeting",
              },
              {
                itemId: "inbox:newsletter-1",
                source: "inbox",
                kind: "message",
                sourceId: "newsletter-1",
                itemClass: "inbox:newsletter-digest",
              },
            ],
            decisions: [
              { itemId: "life:occurrence-1", action: "lead" },
              { itemId: "calendar:event-1", action: "include" },
              { itemId: "inbox:newsletter-1", action: "omit" },
            ],
          },
        },
      },
    },
  });
}

function appliedReceipt(args: {
  runtime: AgentRuntime;
  action: string;
  operation: string;
  resourceKind: string;
  resourceId: string;
  observedAt: string;
  data?: Record<string, unknown>;
}): ActionEventPayload {
  return completedPayload({
    runtime: args.runtime,
    action: args.action,
    actionResult: {
      success: true,
      data: args.data ?? {},
      effectReceipts: [
        {
          receiptId: `receipt:${args.operation}:${args.resourceId}`,
          operation: args.operation,
          resource: { kind: args.resourceKind, id: args.resourceId },
          artifacts: [],
          idempotency: { key: args.resourceId, replayed: false },
          observedAt: args.observedAt,
          outcome: "applied",
          commit: {
            kind: "durable",
            id: `commit:${args.resourceId}`,
            committedAt: args.observedAt,
          },
        },
      ],
    },
  });
}

async function seedRendered(args: {
  repository: LifeOpsRepository;
  runtime: AgentRuntime;
  briefingId: string;
  sourceId: string;
  itemClass: string;
  eventAt: string;
}): Promise<void> {
  await args.repository.recordBriefItemEngagement({
    agentId: args.runtime.agentId,
    briefingId: args.briefingId,
    itemId: `life:${args.sourceId}`,
    source: "life",
    kind: "todo",
    sourceId: args.sourceId,
    itemClass: args.itemClass,
    eventType: "rendered",
    eventAt: args.eventAt,
    weight: 1,
    metadata: {},
  });
}

describe("brief engagement — real PGLite", () => {
  let runtimeResult: RealTestRuntimeResult | undefined;

  afterEach(async () => {
    await runtimeResult?.cleanup();
    runtimeResult = undefined;
  });

  it("persists only surfaced identities and deduplicates event replay", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    await LifeOpsRepository.bootstrapSchema(runtimeResult.runtime);
    const payload = briefPayload({
      runtime: runtimeResult.runtime,
      generatedAt: "2026-07-01T08:00:00.000Z",
    });

    const [first, replayed] = await Promise.all([
      processBriefEngagementActionCompleted(payload),
      processBriefEngagementActionCompleted(payload),
    ]);
    expect(first.status).toBe("recorded");
    expect(replayed.status).toBe("recorded");

    const repository = new LifeOpsRepository(runtimeResult.runtime);
    const rows = await repository.listBriefItemEngagements(
      runtimeResult.runtime.agentId,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.itemId).sort()).toEqual([
      "calendar:event-1",
      "life:occurrence-1",
    ]);
    expect(rows.every((row) => row.eventType === "rendered")).toBe(true);

    const rejected = await processBriefEngagementActionCompleted(
      briefPayload({
        runtime: runtimeResult.runtime,
        briefingId: "brief-malformed",
        generatedAt: "2026-07-01T09:00:00.000Z",
        malformedItemId: true,
      }),
    );
    expect(rejected).toEqual({
      status: "rejected",
      reason: "Malformed briefing identity",
    });
    await expect(
      repository.recordBriefItemEngagement({
        agentId: "foreign-agent",
        briefingId: "brief-foreign",
        itemId: "life:foreign",
        source: "life",
        kind: "todo",
        sourceId: "foreign",
        itemClass: "life:todo",
        eventType: "rendered",
        eventAt: "2026-07-01T10:00:00.000Z",
        weight: 1,
        metadata: {},
      }),
    ).rejects.toMatchObject({
      code: "LIFEOPS_BRIEF_ENGAGEMENT_AGENT_MISMATCH",
    });
  });

  it("attributes only recent durable completion and time-change receipts", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    await LifeOpsRepository.bootstrapSchema(runtimeResult.runtime);
    await processBriefEngagementActionCompleted(
      briefPayload({
        runtime: runtimeResult.runtime,
        generatedAt: "2026-07-01T08:00:00.000Z",
      }),
    );

    const completed = appliedReceipt({
      runtime: runtimeResult.runtime,
      action: "OWNER_TODOS",
      operation: "lifeops.occurrence.completed",
      resourceKind: "lifeops.occurrence",
      resourceId: "occurrence-1",
      observedAt: "2026-07-02T08:00:00.000Z",
    });
    await processBriefEngagementActionCompleted(completed);
    await processBriefEngagementActionCompleted(completed);

    const rescheduled = await processBriefEngagementActionCompleted(
      appliedReceipt({
        runtime: runtimeResult.runtime,
        action: "CALENDAR_UPDATE_EVENT",
        operation: "calendar.event.update",
        resourceKind: "calendar.event",
        resourceId: "event-1",
        observedAt: "2026-07-02T09:00:00.000Z",
        data: {
          targetEvent: {
            startAt: "2026-07-03T09:00:00.000Z",
            endAt: "2026-07-03T10:00:00.000Z",
          },
          event: {
            startAt: "2026-07-03T11:00:00.000Z",
            endAt: "2026-07-03T12:00:00.000Z",
          },
        },
      }),
    );
    expect(rescheduled.status).toBe("recorded");

    const titleOnly = await processBriefEngagementActionCompleted(
      appliedReceipt({
        runtime: runtimeResult.runtime,
        action: "CALENDAR_UPDATE_EVENT",
        operation: "calendar.event.update",
        resourceKind: "calendar.event",
        resourceId: "event-1",
        observedAt: "2026-07-02T10:00:00.000Z",
        data: {
          targetEvent: {
            startAt: "2026-07-03T11:00:00.000Z",
            endAt: "2026-07-03T12:00:00.000Z",
          },
          event: {
            startAt: "2026-07-03T11:00:00.000Z",
            endAt: "2026-07-03T12:00:00.000Z",
          },
        },
      }),
    );
    expect(titleOnly.status).toBe("ignored");

    const foreign = await processBriefEngagementActionCompleted(
      appliedReceipt({
        runtime: runtimeResult.runtime,
        action: "OWNER_TODOS_COMPLETE",
        operation: "lifeops.occurrence.completed",
        resourceKind: "lifeops.occurrence",
        resourceId: "foreign-occurrence",
        observedAt: "2026-07-02T11:00:00.000Z",
      }),
    );
    expect(foreign.status).toBe("unmatched");

    const stale = await processBriefEngagementActionCompleted(
      appliedReceipt({
        runtime: runtimeResult.runtime,
        action: "OWNER_TODOS_COMPLETE",
        operation: "lifeops.occurrence.completed",
        resourceKind: "lifeops.occurrence",
        resourceId: "occurrence-1",
        observedAt: "2026-07-20T08:00:00.000Z",
      }),
    );
    expect(stale.status).toBe("unmatched");

    const repository = new LifeOpsRepository(runtimeResult.runtime);
    const rows = await repository.listBriefItemEngagements(
      runtimeResult.runtime.agentId,
    );
    expect(rows.filter((row) => row.eventType === "completed")).toHaveLength(1);
    expect(rows.filter((row) => row.eventType === "rescheduled")).toHaveLength(
      1,
    );
  });

  it("closes five ignored days deterministically while preserving positive classes", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    await LifeOpsRepository.bootstrapSchema(runtimeResult.runtime);
    const repository = new LifeOpsRepository(runtimeResult.runtime);
    for (let day = 1; day <= 5; day += 1) {
      await seedRendered({
        repository,
        runtime: runtimeResult.runtime,
        briefingId: `brief-ignored-${day}`,
        sourceId: `ignored-${day}`,
        itemClass: "life:habit",
        eventAt: `2026-07-0${day}T08:00:00.000Z`,
      });
    }
    await seedRendered({
      repository,
      runtime: runtimeResult.runtime,
      briefingId: "brief-positive",
      sourceId: "positive-1",
      itemClass: "life:todo",
      eventAt: "2026-07-01T09:00:00.000Z",
    });
    await repository.recordBriefItemEngagement({
      agentId: runtimeResult.runtime.agentId,
      briefingId: "brief-positive",
      itemId: "life:positive-1",
      source: "life",
      kind: "todo",
      sourceId: "positive-1",
      itemClass: "life:todo",
      eventType: "completed",
      eventAt: "2026-07-01T10:00:00.000Z",
      weight: 1,
      metadata: {},
    });

    const first = await repository.reconcileExpiredBriefItemEngagements({
      agentId: runtimeResult.runtime.agentId,
      asOfIso: "2026-07-10T08:00:00.000Z",
      ignoreAfterHours: 24,
    });
    const replay = await repository.reconcileExpiredBriefItemEngagements({
      agentId: runtimeResult.runtime.agentId,
      asOfIso: "2026-07-10T08:00:00.000Z",
      ignoreAfterHours: 24,
    });
    expect(first).toHaveLength(5);
    expect(replay).toHaveLength(0);
    expect(first.map((row) => row.eventAt)).toEqual([
      "2026-07-02T08:00:00.000Z",
      "2026-07-03T08:00:00.000Z",
      "2026-07-04T08:00:00.000Z",
      "2026-07-05T08:00:00.000Z",
      "2026-07-06T08:00:00.000Z",
    ]);

    const summaries = await repository.summarizeBriefItemEngagements(
      runtimeResult.runtime.agentId,
    );
    expect(summaries).toContainEqual(
      expect.objectContaining({
        itemClass: "life:habit",
        renderedCount: 5,
        ignoredCount: 5,
        actedOnCount: 0,
      }),
    );
    expect(summaries).toContainEqual(
      expect.objectContaining({
        itemClass: "life:todo",
        ignoredCount: 0,
        actedOnCount: 1,
      }),
    );

    await repository.recordBriefItemClassControls({
      agentId: runtimeResult.runtime.agentId,
      itemClasses: ["life:habit"],
      eventType: "restored",
      eventAt: "2026-07-10T09:00:00.000Z",
      metadata: { operation: "reset_recalibration" },
    });
    expect(
      await repository.summarizeBriefItemEngagements(
        runtimeResult.runtime.agentId,
      ),
    ).toContainEqual({
      itemClass: "life:habit",
      renderedCount: 0,
      ignoredCount: 0,
      actedOnCount: 0,
      lastEventAt: "2026-07-10T09:00:00.000Z",
    });

    await seedRendered({
      repository,
      runtime: runtimeResult.runtime,
      briefingId: "brief-after-reset",
      sourceId: "after-reset",
      itemClass: "life:habit",
      eventAt: "2026-07-11T08:00:00.000Z",
    });
    await repository.reconcileExpiredBriefItemEngagements({
      agentId: runtimeResult.runtime.agentId,
      asOfIso: "2026-07-13T08:00:00.000Z",
      ignoreAfterHours: 24,
    });
    const relearned = await repository.recordBriefItemClassControls({
      agentId: runtimeResult.runtime.agentId,
      itemClasses: ["life:habit"],
      eventType: "demoted",
      eventAt: "2026-07-13T09:00:00.000Z",
    });
    expect(relearned).toHaveLength(1);
    expect(relearned[0]?.eventType).toBe("demoted");
  });

  it("surfaces persistence failure through runtime diagnostics", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const reportError = vi.spyOn(runtimeResult.runtime, "reportError");
    const repository = {
      recordBriefItemEngagementsAtomic: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    } as unknown as LifeOpsRepository;

    await handleBriefEngagementActionCompleted(
      briefPayload({
        runtime: runtimeResult.runtime,
        generatedAt: "2026-07-01T08:00:00.000Z",
      }),
      repository,
    );

    expect(reportError).toHaveBeenCalledWith(
      "BriefEngagement.actionCompleted",
      expect.objectContaining({ message: "database unavailable" }),
      expect.objectContaining({ action: "BRIEF" }),
    );
  });

  it("retains engagement across a runtime reconstruction", async () => {
    const pgliteDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-brief-engagement-restart-"),
    );
    try {
      runtimeResult = await createLifeOpsTestRuntime({ pgliteDir });
      await LifeOpsRepository.bootstrapSchema(runtimeResult.runtime);
      await seedRendered({
        repository: new LifeOpsRepository(runtimeResult.runtime),
        runtime: runtimeResult.runtime,
        briefingId: "brief-before-restart",
        sourceId: "restart-item",
        itemClass: "life:todo",
        eventAt: "2026-07-01T08:00:00.000Z",
      });
      await runtimeResult.cleanup();
      runtimeResult = undefined;

      runtimeResult = await createLifeOpsTestRuntime({ pgliteDir });
      const rows = await new LifeOpsRepository(
        runtimeResult.runtime,
      ).listBriefItemEngagements(runtimeResult.runtime.agentId);
      expect(rows).toContainEqual(
        expect.objectContaining({
          briefingId: "brief-before-restart",
          itemId: "life:restart-item",
          eventType: "rendered",
        }),
      );
    } finally {
      await runtimeResult?.cleanup();
      runtimeResult = undefined;
      fs.rmSync(pgliteDir, { recursive: true, force: true });
    }
  });
});
