/**
 * BRIEF recalibration feedback loop — integration tests against the real
 * PGLite-backed LifeOps runtime. Covers the delivery-boundary `rendered`
 * impression write (only after a provided callback resolved), the owner
 * `recalibrate` / `reset_recalibration` verbs (targeted writes touch exactly
 * the named class), and the persisted markers driving demotion and
 * restoration in the next composed brief. Owner access is mocked; the
 * database, repository, editorial contract, and action handler are real.
 */

import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import {
  __resetDefaultTriageServiceForTests,
  EventType,
  getDefaultTriageService,
  runWithTrajectoryContext,
} from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { manageMessageAction } from "../../../packages/core/src/features/messaging/triage/actions/manageMessage.ts";
import { respondToMessageAction } from "../../../packages/core/src/features/messaging/triage/actions/respondToMessage.ts";
import { TrajectoriesService } from "../../../packages/core/src/features/trajectories/TrajectoriesService.ts";
import { GoogleGmailAdapter } from "../../plugin-google-workspace/src/lifeops-message-adapter.ts";

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/agent")>()),
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

import {
  __resetBriefComposersForTests,
  briefAction,
  mapCalendarFeedEventToBriefingItem,
  setBriefComposers,
} from "../src/actions/brief.js";
import { attributeBuiltInCalendarBriefReschedule } from "../src/actions/calendar.js";
import { structureBriefingItems } from "../src/lifeops/briefing/editorial-judgment.js";
import {
  retryBriefEngagementRewards,
  settleBriefEngagementReward,
} from "../src/lifeops/briefing/engagement-reward.js";
import { handleBriefMessageMutation } from "../src/lifeops/briefing/message-engagement-handler.js";
import { CalendarDomain } from "../src/lifeops/domains/calendar-service.js";
import { gmailBriefSourceId } from "../src/lifeops/domains/gmail-service.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { executeRawSql } from "../src/lifeops/sql.js";
import type {
  LifeOpsBriefing,
  LifeOpsBriefingSections,
} from "../src/types/briefing.js";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

const sections: LifeOpsBriefingSections = {
  calendar: [
    {
      id: "board-prep",
      title: "Board prep with investor questions",
      startAt: "2026-07-06T16:00:00.000Z",
      endAt: "2026-07-06T17:00:00.000Z",
    },
  ],
  inbox: [
    {
      id: "msg-newsletter",
      channel: "gmail",
      senderName: "Industry Roundup",
      snippet: "Weekly newsletter digest and promo updates.",
      urgency: "low",
      classification: "newsletter",
    },
  ],
};

const NEWSLETTER_CLASS = "inbox:newsletter-digest";
const CALENDAR_CLASS = "calendar:high-consequence";

function makeMessage(text = "brief housekeeping"): Memory {
  return {
    id: "msg-brief-recal-1" as UUID,
    entityId: "owner-1" as UUID,
    roomId: "room-brief-recal-1" as UUID,
    content: { text },
  } as Memory;
}

async function callBrief(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
  callback?: () => Promise<undefined>,
) {
  return briefAction.handler(
    runtime,
    makeMessage(),
    undefined,
    { parameters } as unknown as HandlerOptions,
    callback,
  );
}

function briefingFromResult(result: unknown): LifeOpsBriefing {
  const briefing = (result as { data?: { briefing?: LifeOpsBriefing } }).data
    ?.briefing;
  if (!briefing) throw new Error("action result carried no briefing");
  return briefing;
}

describe("BRIEF recalibration feedback loop (real PGLite)", () => {
  let runtimeResult: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;
  let runtime: IAgentRuntime;
  let repository: LifeOpsRepository;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    await LifeOpsRepository.bootstrapSchema(runtime);
    repository = new LifeOpsRepository(runtime);
    runtime.registerEvent(
      EventType.MESSAGE_MUTATED,
      handleBriefMessageMutation,
    );
  }, 120_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  beforeEach(async () => {
    mocks.hasOwnerAccess.mockReset().mockResolvedValue(true);
    __resetDefaultTriageServiceForTests();
    __resetBriefComposersForTests();
    setBriefComposers({
      loadCalendar: async () => sections.calendar ?? [],
      loadInbox: async () => sections.inbox ?? [],
      loadLife: async () => [],
      loadMoney: async () => [],
      loadCompletedToday: async () => [],
    });
    await executeRawSql(
      runtime,
      "DELETE FROM app_lifeops.life_brief_item_engagements",
    );
  });

  async function allRows() {
    return repository.listBriefItemEngagements(runtime.agentId);
  }

  it("records only item titles actually present in the delivered narrative", async () => {
    vi.spyOn(runtime, "useModel").mockResolvedValueOnce(
      "Board prep with investor questions comes first. Industry Roundup via gmail can wait.",
    );
    const result = await runWithTrajectoryContext(
      {
        trajectoryId: "morning-brief-trajectory",
        trajectoryStepId: "morning-brief-step",
        purpose: "action",
      },
      () =>
        callBrief(
          runtime,
          { action: "compose_morning", format: "narrative" },
          async () => undefined,
        ),
    );
    expect(result).toMatchObject({ success: true });
    const briefing = briefingFromResult(result);

    const rows = await allRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.eventType === "rendered")).toBe(true);
    expect(rows.every((row) => row.briefingId === briefing.id)).toBe(true);
    expect(rows[0]?.metadata).toMatchObject({
      briefingKind: "morning",
      period: "today",
      trajectoryId: "morning-brief-trajectory",
      trajectoryStepId: "morning-brief-step",
    });

    // No callback -> nothing was shown to the owner -> no impressions.
    const undelivered = await callBrief(runtime, {
      action: "compose_morning",
      format: "json",
    });
    expect(undelivered).toMatchObject({ success: true });
    expect(await allRows()).toHaveLength(2);

    // A JSON callback exposes only the generic confirmation in chat. The
    // structured action result is not proof that every item was rendered.
    await callBrief(
      runtime,
      { action: "compose_morning", format: "json" },
      async () => undefined,
    );
    expect(await allRows()).toHaveLength(2);
  });

  async function seedRendered(itemClass: "newsletter" | "calendar") {
    const source =
      itemClass === "newsletter"
        ? { inbox: sections.inbox ?? [] }
        : { calendar: sections.calendar ?? [] };
    const [item] = structureBriefingItems(source);
    if (!item) throw new Error("fixture produced no structured item");
    for (let day = 1; day <= 5; day += 1) {
      const eventAt = new Date(Date.now() - (6 - day) * 24 * 60 * 60 * 1_000);
      eventAt.setUTCHours(12, 0, 0, 0);
      await repository.recordBriefItemEngagement({
        agentId: runtime.agentId,
        briefingId: `seed-brief-${itemClass}-${day}`,
        itemId: item.itemId,
        source: item.source,
        kind: item.kind,
        sourceId: item.sourceId,
        itemClass: item.itemClass,
        eventType: "rendered",
        eventAt: eventAt.toISOString(),
        weight: 0,
        metadata: { briefingKind: "morning", period: "today" },
      });
    }
    return item;
  }

  it("recalibrate demotes surfaced-never-acted classes visibly and reversibly", async () => {
    const newsletter = await seedRendered("newsletter");
    const calendar = await seedRendered("calendar");
    // The owner acted on the calendar class, so it must never auto-demote.
    await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "seed-brief-calendar-5",
      itemId: calendar.itemId,
      source: calendar.source,
      kind: calendar.kind,
      sourceId: calendar.sourceId,
      itemClass: calendar.itemClass,
      eventType: "completed",
      eventAt: new Date().toISOString(),
      weight: 1,
      metadata: {},
    });

    const result = await callBrief(
      runtime,
      { action: "recalibrate" },
      async () => undefined,
    );
    expect(result).toMatchObject({
      success: true,
      data: { demotedItemClasses: [NEWSLETTER_CLASS] },
    });
    expect(String((result as { text?: string }).text)).toContain(
      NEWSLETTER_CLASS,
    );
    expect(String((result as { text?: string }).text)).toContain("reversible");

    const markers = (await allRows()).filter(
      (row) => row.eventType === "demoted",
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      itemClass: NEWSLETTER_CLASS,
      itemId: newsletter.itemId,
    });

    await repository.finalizeExpiredBriefItemEngagements(runtime.agentId);

    // The next composed brief demotes the class through the real summary load.
    const composed = await callBrief(
      runtime,
      { action: "compose_morning", format: "json" },
      async () => undefined,
    );
    const briefing = briefingFromResult(composed);
    expect(briefing.editorial.demotedItemClasses).toContain(NEWSLETTER_CLASS);
    expect(briefing.editorial.demotedItemClasses).not.toContain(CALENDAR_CLASS);

    // reset_recalibration restores the class and the next brief reflects it.
    const reset = await callBrief(
      runtime,
      { action: "reset_recalibration", itemClass: NEWSLETTER_CLASS },
      async () => undefined,
    );
    expect(reset).toMatchObject({
      success: true,
      data: { restoredItemClasses: [NEWSLETTER_CLASS] },
    });
    const restored = briefingFromResult(
      await callBrief(
        runtime,
        { action: "compose_morning", format: "json" },
        async () => undefined,
      ),
    );
    expect(restored.editorial.demotedItemClasses).not.toContain(
      NEWSLETTER_CLASS,
    );
  });

  it("targeted recalibrate writes markers for exactly the named class", async () => {
    await seedRendered("newsletter");
    await seedRendered("calendar");

    const result = await callBrief(
      runtime,
      { action: "recalibrate", itemClass: CALENDAR_CLASS },
      async () => undefined,
    );
    expect(result).toMatchObject({
      success: true,
      data: { demotedItemClasses: [CALENDAR_CLASS] },
    });

    const markers = (await allRows()).filter(
      (row) => row.eventType === "demoted",
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]?.itemClass).toBe(CALENDAR_CLASS);
  });

  it("targeted recalibrate for an unknown class is a visible no-op", async () => {
    await seedRendered("newsletter");
    const result = await callBrief(
      runtime,
      { action: "recalibrate", itemClass: "life:unknown-class" },
      async () => undefined,
    );
    expect(result).toMatchObject({
      success: true,
      data: { error: "NO_ENGAGEMENT_HISTORY" },
    });
    expect(
      (await allRows()).filter((row) => row.eventType === "demoted"),
    ).toHaveLength(0);
  });

  it("does not let lifetime demotion history poison the current recency window", async () => {
    const [item] = structureBriefingItems({ inbox: sections.inbox ?? [] });
    if (!item) throw new Error("fixture produced no structured item");
    await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "current-recency-brief",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "rendered",
      eventAt: new Date().toISOString(),
      weight: 0,
      metadata: { briefingKind: "morning", period: "today" },
    });
    const oldAt = new Date(
      Date.now() - 60 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "old-lifetime-brief",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "demoted",
      eventAt: oldAt,
      weight: -1,
      metadata: {},
    });
    const briefing = briefingFromResult(
      await callBrief(
        runtime,
        { action: "compose_morning", format: "json" },
        async () => undefined,
      ),
    );
    expect(briefing.editorial.demotedItemClasses).not.toContain(
      NEWSLETTER_CLASS,
    );
  });

  it("attributes a committed same-day completion once and finalizes only expired unacted deliveries", async () => {
    const [calendar, inbox] = structureBriefingItems(sections);
    if (!calendar || !inbox) throw new Error("fixture items missing");
    for (const item of [calendar, inbox]) {
      await repository.recordBriefItemEngagement({
        agentId: runtime.agentId,
        briefingId: "brief-feedback-window",
        itemId: item.itemId,
        source: item.source,
        kind: item.kind,
        sourceId: item.sourceId,
        itemClass: item.itemClass,
        eventType: "rendered",
        eventAt: "2026-08-14T08:00:00.000Z",
        weight: 0,
        metadata: { trajectoryId: "trajectory-morning-brief" },
      });
    }

    const writes = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.attributeBriefItemEngagement({
          agentId: runtime.agentId,
          source: calendar.source,
          sourceId: calendar.sourceId,
          eventType: "kept",
          eventAt: "2026-08-14T17:00:00.000Z",
          domainEventId: "calendar-event-ended:board-prep",
          weight: 0.75,
        }),
      ),
    );
    expect(writes.every((row) => row?.id === writes[0]?.id)).toBe(true);
    const engagement = writes[0];
    if (!engagement) throw new Error("completion was not attributed");
    const applyReward = vi.fn(async () => true);
    const logger = {
      applyReward,
    };
    const rewardRuntime = {
      ...runtime,
      getService: () => logger,
      getServicesByType: () => [logger],
    } as unknown as IAgentRuntime;
    const settlements = await Promise.all(
      Array.from({ length: 8 }, () =>
        settleBriefEngagementReward({
          runtime: rewardRuntime,
          repository,
          engagement,
        }),
      ),
    );
    expect(settlements.filter(Boolean)).toHaveLength(1);
    expect(applyReward).toHaveBeenCalledTimes(1);
    expect(applyReward).toHaveBeenCalledWith({
      trajectoryId: "trajectory-morning-brief",
      idempotencyKey: `brief-engagement:${engagement.id}`,
      reward: 0.75,
      component: "briefEngagementReward",
    });

    expect(
      await repository.finalizeExpiredBriefItemEngagements(runtime.agentId, {
        asOfIso: "2026-08-15T09:00:00.000Z",
      }),
    ).toBe(1);
    expect(
      await repository.finalizeExpiredBriefItemEngagements(runtime.agentId, {
        asOfIso: "2026-08-15T09:00:00.000Z",
      }),
    ).toBe(0);
    const outcomes = (await allRows()).filter(
      (row) => row.eventType !== "rendered",
    );
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: calendar.itemId,
          eventType: "kept",
          metadata: expect.objectContaining({
            trajectoryId: "trajectory-morning-brief",
            domainEventId: "calendar-event-ended:board-prep",
          }),
        }),
        expect.objectContaining({
          itemId: inbox.itemId,
          eventType: "ignored",
        }),
      ]),
    );
  });

  it("uses a domain receipt as identity across retry timestamps and isolates collision domains", async () => {
    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-domain-retry",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "rendered",
      eventAt: "2026-08-17T08:00:00.000Z",
      weight: 0,
      metadata: {},
    });
    const first = await repository.attributeBriefItemEngagement({
      agentId: runtime.agentId,
      source: item.source,
      sourceId: item.sourceId,
      eventType: "rescheduled",
      eventAt: "2026-08-17T08:01:00.000Z",
      domainEventId: "provider-update-42",
      weight: 1,
    });
    const retry = await repository.attributeBriefItemEngagement({
      agentId: runtime.agentId,
      source: item.source,
      sourceId: item.sourceId,
      eventType: "rescheduled",
      eventAt: "2026-08-17T08:02:00.000Z",
      domainEventId: "provider-update-42",
      weight: 1,
    });
    expect(retry?.id).toBe(first?.id);

    const otherSource = await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-domain-retry",
      itemId: "other-item",
      source: "inbox",
      kind: "message",
      sourceId: "gmail:other",
      itemClass: "inbox:other",
      eventType: "replied",
      eventAt: "2026-08-17T08:02:00.000Z",
      weight: 1,
      metadata: { domainEventId: "provider-update-42" },
    });
    const otherAgent = await repository.recordBriefItemEngagement({
      agentId: "00000000-0000-4000-8000-000000000099",
      briefingId: "brief-domain-retry",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "rescheduled",
      eventAt: "2026-08-17T08:02:00.000Z",
      weight: 1,
      metadata: { domainEventId: "provider-update-42" },
    });
    expect(otherSource.id).not.toBe(first?.id);
    expect(otherAgent.id).not.toBe(first?.id);
  });

  it("serializes an expiry finalizer against an authoritative outcome", async () => {
    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-finalizer-race",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "rendered",
      eventAt: "2026-08-17T08:00:00.000Z",
      weight: 0,
      metadata: {},
    });
    await Promise.all([
      repository.attributeBriefItemEngagement({
        agentId: runtime.agentId,
        source: item.source,
        sourceId: item.sourceId,
        eventType: "kept",
        eventAt: "2026-08-17T08:30:00.000Z",
        domainEventId: "provider-race-outcome",
        weight: 0.75,
      }),
      repository.finalizeExpiredBriefItemEngagements(runtime.agentId, {
        asOfIso: "2026-08-18T09:00:00.000Z",
      }),
    ]);
    const outcomes = (await allRows()).filter((row) =>
      ["kept", "ignored"].includes(row.eventType),
    );
    expect(outcomes).toHaveLength(1);
  });

  it("releases a false reward settlement claim so a later retry can succeed", async () => {
    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    const engagement = await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-reward-retry",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "kept",
      eventAt: "2026-08-17T17:00:00.000Z",
      weight: 0.75,
      metadata: { trajectoryId: "retry-trajectory" },
    });
    const applyReward = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const rewardRuntime = {
      ...runtime,
      getService: () => ({ applyReward }),
      getServicesByType: () => [{ applyReward }],
    } as unknown as IAgentRuntime;

    expect(
      await settleBriefEngagementReward({
        runtime: rewardRuntime,
        repository,
        engagement,
      }),
    ).toBe(false);
    expect(
      await settleBriefEngagementReward({
        runtime: rewardRuntime,
        repository,
        engagement,
      }),
    ).toBe(true);
    expect(applyReward).toHaveBeenCalledTimes(2);
  });

  it("isolates explicit engagement ids and reward leases between agents", async () => {
    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    const sharedId = "shared-explicit-engagement-id";
    const engagement = await repository.recordBriefItemEngagement({
      id: sharedId,
      agentId: runtime.agentId,
      briefingId: "brief-tenant-a",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "kept",
      eventAt: "2026-08-17T17:00:00.000Z",
      weight: 0.75,
      metadata: { trajectoryId: "tenant-a-trajectory" },
    });
    const otherAgentId = "00000000-0000-4000-8000-000000000002";

    await expect(
      repository.recordBriefItemEngagement({
        id: sharedId,
        agentId: otherAgentId,
        briefingId: "brief-tenant-b",
        itemId: item.itemId,
        source: item.source,
        kind: item.kind,
        sourceId: item.sourceId,
        itemClass: item.itemClass,
        eventType: "kept",
        eventAt: "2026-08-17T17:00:00.000Z",
        weight: 0.75,
        metadata: { trajectoryId: "tenant-b-trajectory" },
      }),
    ).rejects.toThrow("Failed to reload brief engagement");
    expect(
      await repository.getBriefItemEngagement(runtime.agentId, sharedId),
    ).toMatchObject({ agentId: runtime.agentId, briefingId: "brief-tenant-a" });

    const tenantAClaim = await repository.claimBriefEngagementReward(
      engagement,
      { nowIso: "2026-08-17T18:00:00.000Z" },
    );
    const tenantBClaim = await repository.claimBriefEngagementReward(
      { ...engagement, agentId: otherAgentId, briefingId: "brief-tenant-b" },
      { nowIso: "2026-08-17T18:00:00.000Z" },
    );
    expect(tenantAClaim).not.toBeNull();
    expect(tenantBClaim).not.toBeNull();

    const markers = await executeRawSql(
      runtime,
      `SELECT id, agent_id
         FROM app_lifeops.life_brief_item_engagements
        WHERE event_type = 'rewarded'
        ORDER BY agent_id`,
    );
    expect(markers).toHaveLength(2);
    expect(new Set(markers.map((row) => row.id)).size).toBe(2);
    expect(markers.map((row) => row.agent_id)).toEqual(
      [runtime.agentId, otherAgentId].sort(),
    );
  });

  it("recovers an abandoned reward lease without letting its old owner erase the takeover", async () => {
    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    const engagement = await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-reward-lease",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "kept",
      eventAt: "2026-08-17T17:00:00.000Z",
      weight: 0.75,
      metadata: { trajectoryId: "lease-trajectory" },
    });
    const first = await repository.claimBriefEngagementReward(engagement, {
      nowIso: "2026-08-17T17:00:00.000Z",
      leaseSeconds: 60,
    });
    expect(first).not.toBeNull();
    expect(
      await repository.claimBriefEngagementReward(engagement, {
        nowIso: "2026-08-17T17:00:30.000Z",
        leaseSeconds: 60,
      }),
    ).toBeNull();
    const takeover = await repository.claimBriefEngagementReward(engagement, {
      nowIso: "2026-08-17T17:01:01.000Z",
      leaseSeconds: 60,
    });
    expect(takeover).not.toBeNull();
    if (!first || !takeover) throw new Error("reward lease fixture failed");
    await repository.releaseBriefEngagementRewardClaim(engagement, first);
    await repository.completeBriefEngagementRewardClaim(engagement, takeover);
    expect(
      await repository.claimBriefEngagementReward(engagement, {
        nowIso: "2026-08-18T17:00:00.000Z",
      }),
    ).toBeNull();
    const marker = (
      await repository.listBriefItemEngagements(runtime.agentId, {
        includeOperational: true,
      })
    ).find((row) => row.eventType === "rewarded");
    expect(marker?.metadata).toMatchObject({
      engagementEventId: engagement.id,
      rewardState: "completed",
      trajectoryRewardKey: `brief-engagement:${engagement.id}`,
    });
  });

  it("retries old unresolved rewards in a bounded batch without revisiting settled or zero-weight rows", async () => {
    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    const oldEventAt = "2026-06-01T17:00:00.000Z";
    const unresolved = await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-old-unresolved-reward",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "kept",
      eventAt: oldEventAt,
      weight: 0.75,
      metadata: { trajectoryId: "old-unresolved-trajectory" },
    });
    expect(
      await repository.claimBriefEngagementReward(unresolved, {
        nowIso: "2026-06-01T17:01:00.000Z",
        leaseSeconds: 60,
      }),
    ).not.toBeNull();
    const settled = await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-old-settled-reward",
      itemId: `${item.itemId}:settled`,
      source: item.source,
      kind: item.kind,
      sourceId: `${item.sourceId}:settled`,
      itemClass: item.itemClass,
      eventType: "kept",
      eventAt: oldEventAt,
      weight: 0.5,
      metadata: { trajectoryId: "old-settled-trajectory" },
    });
    const settledClaim = await repository.claimBriefEngagementReward(settled, {
      nowIso: "2026-06-01T17:01:00.000Z",
    });
    if (!settledClaim) throw new Error("settled claim fixture failed");
    await repository.completeBriefEngagementRewardClaim(settled, settledClaim);
    await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-old-zero-reward",
      itemId: `${item.itemId}:zero`,
      source: item.source,
      kind: item.kind,
      sourceId: `${item.sourceId}:zero`,
      itemClass: item.itemClass,
      eventType: "opened",
      eventAt: oldEventAt,
      weight: 0,
      metadata: { trajectoryId: "old-zero-trajectory" },
    });
    const applyReward = vi.fn(async () => true);
    const rewardRuntime = {
      ...runtime,
      getService: () => ({ applyReward }),
      getServicesByType: () => [{ applyReward }],
    } as unknown as IAgentRuntime;

    expect(
      await retryBriefEngagementRewards({
        runtime: rewardRuntime,
        repository,
        batchLimit: 1,
      }),
    ).toBe(1);
    expect(applyReward).toHaveBeenCalledTimes(1);
    expect(applyReward).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `brief-engagement:${unresolved.id}`,
      }),
    );
    expect(
      await repository.listPendingBriefEngagementRewards(runtime.agentId),
    ).toEqual([]);
  });

  it("does not let active leases or trajectory-less history starve a bounded reward batch", async () => {
    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    const record = async (args: {
      suffix: string;
      eventAt: string;
      trajectoryId?: string;
    }) =>
      repository.recordBriefItemEngagement({
        agentId: runtime.agentId,
        briefingId: `brief-starvation-${args.suffix}`,
        itemId: `${item.itemId}:${args.suffix}`,
        source: item.source,
        kind: item.kind,
        sourceId: `${item.sourceId}:${args.suffix}`,
        itemClass: item.itemClass,
        eventType: "kept",
        eventAt: args.eventAt,
        weight: 0.5,
        metadata: args.trajectoryId ? { trajectoryId: args.trajectoryId } : {},
      });
    await record({
      suffix: "missing-trajectory",
      eventAt: "2025-01-01T00:00:00.000Z",
    });
    const activelyClaimed = await record({
      suffix: "active-claim",
      eventAt: "2025-02-01T00:00:00.000Z",
      trajectoryId: "active-claim-trajectory",
    });
    expect(
      await repository.claimBriefEngagementReward(activelyClaimed, {
        nowIso: "2099-01-01T00:00:00.000Z",
        leaseSeconds: 60,
      }),
    ).not.toBeNull();
    const recoverable = await record({
      suffix: "recoverable",
      eventAt: "2025-03-01T00:00:00.000Z",
      trajectoryId: "recoverable-trajectory",
    });
    const applyReward = vi.fn(async () => true);
    const rewardRuntime = {
      ...runtime,
      getService: () => ({ applyReward }),
      getServicesByType: () => [{ applyReward }],
    } as unknown as IAgentRuntime;

    expect(
      await retryBriefEngagementRewards({
        runtime: rewardRuntime,
        repository,
        batchLimit: 1,
      }),
    ).toBe(1);
    expect(applyReward).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `brief-engagement:${recoverable.id}`,
      }),
    );
    expect(
      await repository.listPendingBriefEngagementRewards(runtime.agentId, {
        nowIso: "2099-01-01T00:00:30.000Z",
      }),
    ).toEqual([]);
    expect(
      await repository.listPendingBriefEngagementRewards(runtime.agentId, {
        nowIso: "2099-01-01T00:01:00.000Z",
      }),
    ).toEqual([activelyClaimed]);
    expect(
      await repository.listPendingBriefEngagementRewards(runtime.agentId, {
        nowIso: "2099-01-01T00:01:01.000Z",
      }),
    ).toEqual([activelyClaimed]);
  });

  it("rotates a failed oldest reward behind newer pending outcomes", async () => {
    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    const record = (suffix: string, eventAt: string) =>
      repository.recordBriefItemEngagement({
        agentId: runtime.agentId,
        briefingId: `brief-fair-retry-${suffix}`,
        itemId: `${item.itemId}:${suffix}`,
        source: item.source,
        kind: item.kind,
        sourceId: `${item.sourceId}:${suffix}`,
        itemClass: item.itemClass,
        eventType: "kept",
        eventAt,
        weight: 0.5,
        metadata: { trajectoryId: `${suffix}-trajectory` },
      });
    const oldest = await record("missing", "2025-01-01T00:00:00.000Z");
    const recoverable = await record("recoverable", "2025-02-01T00:00:00.000Z");
    const applyReward = vi.fn(
      async ({ trajectoryId }: { trajectoryId: string }) =>
        trajectoryId === "recoverable-trajectory",
    );
    const rewardRuntime = {
      ...runtime,
      getService: () => ({ applyReward }),
      getServicesByType: () => [{ applyReward }],
    } as unknown as IAgentRuntime;

    expect(
      await retryBriefEngagementRewards({
        runtime: rewardRuntime,
        repository,
        batchLimit: 1,
      }),
    ).toBe(0);
    expect(
      await retryBriefEngagementRewards({
        runtime: rewardRuntime,
        repository,
        batchLimit: 1,
      }),
    ).toBe(1);
    expect(applyReward.mock.calls.map(([args]) => args.trajectoryId)).toEqual([
      "missing-trajectory",
      "recoverable-trajectory",
    ]);
    expect(
      await repository.listPendingBriefEngagementRewards(runtime.agentId),
    ).toEqual([oldest]);
    expect(recoverable.id).not.toBe(oldest.id);
  });

  it("keeps released retry order monotonic across equal or backward clocks", async () => {
    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    const record = (suffix: string) =>
      repository.recordBriefItemEngagement({
        agentId: runtime.agentId,
        briefingId: `brief-retry-clock-${suffix}`,
        itemId: `${item.itemId}:${suffix}`,
        source: item.source,
        kind: item.kind,
        sourceId: `${item.sourceId}:${suffix}`,
        itemClass: item.itemClass,
        eventType: "kept",
        eventAt: "2025-01-01T00:00:00.000Z",
        weight: 0.5,
        metadata: { trajectoryId: `${suffix}-trajectory` },
      });
    const oldest = await record("oldest");
    const newer = await record("newer");
    const futureAttempt = "2099-01-01T00:00:00.000Z";
    const oldestToken = await repository.claimBriefEngagementReward(oldest, {
      nowIso: futureAttempt,
    });
    const newerToken = await repository.claimBriefEngagementReward(newer, {
      nowIso: futureAttempt,
    });
    if (!oldestToken || !newerToken) throw new Error("claim fixture failed");
    await executeRawSql(
      runtime,
      `UPDATE app_lifeops.life_brief_item_engagements
          SET event_at = '2020-01-01T00:00:00.000Z'
        WHERE event_type = 'rewarded'
          AND agent_id = '${runtime.agentId}'`,
    );

    await repository.releaseBriefEngagementRewardClaim(oldest, oldestToken);

    expect(
      await repository.listPendingBriefEngagementRewards(runtime.agentId, {
        limit: 1,
        nowIso: "2100-01-01T00:00:00.000Z",
      }),
    ).toEqual([newer]);
  });

  it("rotates by the agent watermark when different claims have skewed clocks", async () => {
    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    const record = (suffix: string) =>
      repository.recordBriefItemEngagement({
        agentId: runtime.agentId,
        briefingId: `brief-retry-skew-${suffix}`,
        itemId: `${item.itemId}:${suffix}`,
        source: item.source,
        kind: item.kind,
        sourceId: `${item.sourceId}:${suffix}`,
        itemClass: item.itemClass,
        eventType: "kept",
        eventAt: "2025-01-01T00:00:00.000Z",
        weight: 0.5,
        metadata: { trajectoryId: `${suffix}-trajectory` },
      });
    const firstReleased = await record("first-released");
    const lastReleased = await record("last-released");
    const firstToken = await repository.claimBriefEngagementReward(
      firstReleased,
      { nowIso: "2099-01-01T00:00:00.000Z" },
    );
    const lastToken = await repository.claimBriefEngagementReward(
      lastReleased,
      { nowIso: "2098-01-01T00:00:00.000Z" },
    );
    if (!firstToken || !lastToken) throw new Error("claim fixture failed");

    await repository.releaseBriefEngagementRewardClaim(
      firstReleased,
      firstToken,
    );
    await repository.releaseBriefEngagementRewardClaim(lastReleased, lastToken);

    expect(
      await repository.listPendingBriefEngagementRewards(runtime.agentId, {
        limit: 1,
        nowIso: "2100-01-01T00:00:00.000Z",
      }),
    ).toEqual([firstReleased]);
  });

  it("makes a released clock-ahead lease immediately eligible", async () => {
    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    const engagement = await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-released-clock-ahead",
      itemId: `${item.itemId}:released-clock-ahead`,
      source: item.source,
      kind: item.kind,
      sourceId: `${item.sourceId}:released-clock-ahead`,
      itemClass: item.itemClass,
      eventType: "kept",
      eventAt: "2025-01-01T00:00:00.000Z",
      weight: 0.5,
      metadata: { trajectoryId: "released-clock-ahead-trajectory" },
    });
    const claimToken = await repository.claimBriefEngagementReward(engagement, {
      nowIso: "2025-01-02T00:00:00.000Z",
    });
    if (!claimToken) throw new Error("claim fixture failed");

    // The releasing host's wall clock is later than the scanner's explicit
    // clock below. Released state, rather than that wall clock, controls retry.
    await repository.releaseBriefEngagementRewardClaim(engagement, claimToken);
    expect(
      await repository.listPendingBriefEngagementRewards(runtime.agentId, {
        nowIso: "2025-01-03T00:00:00.000Z",
      }),
    ).toEqual([engagement]);
    expect(
      await repository.claimBriefEngagementReward(engagement, {
        nowIso: "2025-01-03T00:00:00.000Z",
      }),
    ).not.toBeNull();
  });

  it("fails closed on an unknown reward marker state without parsing its lease", async () => {
    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    const engagement = await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-unknown-reward-state",
      itemId: `${item.itemId}:unknown-reward-state`,
      source: item.source,
      kind: item.kind,
      sourceId: `${item.sourceId}:unknown-reward-state`,
      itemClass: item.itemClass,
      eventType: "kept",
      eventAt: "2025-01-01T00:00:00.000Z",
      weight: 0.5,
      metadata: { trajectoryId: "unknown-reward-state-trajectory" },
    });
    expect(
      await repository.claimBriefEngagementReward(engagement, {
        nowIso: "2025-01-02T00:00:00.000Z",
      }),
    ).not.toBeNull();
    await executeRawSql(
      runtime,
      `UPDATE app_lifeops.life_brief_item_engagements
          SET event_at = 'not-a-time',
              metadata_json = '{"engagementEventId":"${engagement.id}","rewardState":"unknown"}'
        WHERE event_type = 'rewarded'
          AND agent_id = '${runtime.agentId}'`,
    );

    expect(
      await repository.listPendingBriefEngagementRewards(runtime.agentId, {
        nowIso: "2100-01-01T00:00:00.000Z",
      }),
    ).toEqual([]);
    expect(
      await repository.claimBriefEngagementReward(engagement, {
        nowIso: "2100-01-01T00:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("rejects invalid pending-reward limits, scan times, and leases", async () => {
    const rewardIndexes = await executeRawSql(
      runtime,
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'app_lifeops'
          AND indexname IN (
            'idx_life_brief_item_engagements_reward_queue',
            'idx_life_brief_item_engagements_reward_receipt',
            'idx_life_brief_item_engagements_reward_retry_order'
          )
        ORDER BY indexname`,
    );
    expect(rewardIndexes.map((row) => row.indexname)).toEqual([
      "idx_life_brief_item_engagements_reward_queue",
      "idx_life_brief_item_engagements_reward_receipt",
      "idx_life_brief_item_engagements_reward_retry_order",
    ]);
    for (const limit of [0, 1.5, 1_001, Number.NaN]) {
      await expect(
        repository.listPendingBriefEngagementRewards(runtime.agentId, {
          limit,
        }),
      ).rejects.toMatchObject({
        code: "LIFEOPS_BRIEF_REWARD_BATCH_LIMIT_INVALID",
      });
    }
    await expect(
      repository.listPendingBriefEngagementRewards(runtime.agentId, {
        nowIso: "not-a-time",
      }),
    ).rejects.toMatchObject({
      code: "LIFEOPS_BRIEF_REWARD_SCAN_TIME_INVALID",
    });

    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    const engagement = await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-invalid-reward-lease",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "kept",
      eventAt: "2026-08-17T17:00:00.000Z",
      weight: 0.5,
      metadata: { trajectoryId: "invalid-lease-trajectory" },
    });
    await expect(
      repository.claimBriefEngagementReward(engagement, {
        nowIso: "not-a-time",
      }),
    ).rejects.toMatchObject({ code: "LIFEOPS_BRIEF_REWARD_LEASE_INVALID" });
    await expect(
      repository.claimBriefEngagementReward(engagement, { leaseSeconds: 0 }),
    ).rejects.toMatchObject({ code: "LIFEOPS_BRIEF_REWARD_LEASE_INVALID" });
    await expect(
      repository.claimBriefEngagementReward(engagement, {
        nowIso: "+275760-09-13T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "LIFEOPS_BRIEF_REWARD_LEASE_INVALID" });
  });

  it("orders pending rewards by instants rather than timestamp spelling", async () => {
    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    const record = (suffix: string, eventAt: string) =>
      repository.recordBriefItemEngagement({
        agentId: runtime.agentId,
        briefingId: `brief-reward-time-order-${suffix}`,
        itemId: `${item.itemId}:${suffix}`,
        source: item.source,
        kind: item.kind,
        sourceId: `${item.sourceId}:${suffix}`,
        itemClass: item.itemClass,
        eventType: "kept",
        eventAt,
        weight: 0.5,
        metadata: { trajectoryId: `${suffix}-trajectory` },
      });
    const earlier = await record("earlier", "2026-01-01T01:00:00+02:00");
    const later = await record("later", "2025-12-31T23:30:00.000Z");
    const otherAgent = await repository.recordBriefItemEngagement({
      agentId: "00000000-0000-4000-8000-000000000099",
      briefingId: "brief-reward-time-order-other-agent",
      itemId: `${item.itemId}:other-agent`,
      source: item.source,
      kind: item.kind,
      sourceId: `${item.sourceId}:other-agent`,
      itemClass: item.itemClass,
      eventType: "kept",
      eventAt: "2020-01-01T00:00:00.000Z",
      weight: 0.5,
      metadata: { trajectoryId: "other-agent-trajectory" },
    });

    expect(
      await repository.listPendingBriefEngagementRewards(runtime.agentId),
    ).toEqual([earlier, later]);
    expect(
      await repository.listPendingBriefEngagementRewards(otherAgent.agentId),
    ).toEqual([otherAgent]);
  });

  it("uses a rolling delivery window across UTC midnight and ignores late actions", async () => {
    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-timezone-boundary",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "rendered",
      eventAt: "2026-08-17T23:45:00.000Z",
      weight: 0,
      metadata: {},
    });
    expect(
      await repository.attributeBriefItemEngagement({
        agentId: runtime.agentId,
        source: item.source,
        sourceId: item.sourceId,
        eventType: "kept",
        eventAt: "2026-08-18T00:15:00.000Z",
        domainEventId: "meeting-kept:cross-midnight",
        weight: 0.75,
      }),
    ).not.toBeNull();

    await executeRawSql(
      runtime,
      "DELETE FROM app_lifeops.life_brief_item_engagements WHERE event_type = 'kept'",
    );
    await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-timezone-boundary",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "kept",
      eventAt: "2026-08-19T00:00:00.000Z",
      weight: 0.75,
      metadata: { domainEventId: "meeting-kept:late" },
    });
    expect(
      await repository.finalizeExpiredBriefItemEngagements(runtime.agentId, {
        asOfIso: "2026-08-19T00:01:00.000Z",
      }),
    ).toBe(1);
    expect(
      (await allRows()).some(
        (row) =>
          row.briefingId === "brief-timezone-boundary" &&
          row.eventType === "ignored",
      ),
    ).toBe(true);
  });

  it("preserves distinct domain events at an identical type and timestamp", async () => {
    const [item] = structureBriefingItems({ calendar: sections.calendar });
    if (!item) throw new Error("fixture item missing");
    await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-domain-event-collapse",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "rendered",
      eventAt: "2026-08-17T08:00:00.000Z",
      weight: 0,
      metadata: {},
    });
    for (const domainEventId of ["provider-event-a", "provider-event-b"]) {
      await repository.attributeBriefItemEngagement({
        agentId: runtime.agentId,
        source: item.source,
        sourceId: item.sourceId,
        eventType: "rescheduled",
        eventAt: "2026-08-17T09:00:00.000Z",
        domainEventId,
        weight: 1,
      });
    }
    const rows = (await allRows()).filter(
      (row) => row.eventType === "rescheduled",
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.metadata.domainEventId).sort()).toEqual([
      "provider-event-a",
      "provider-event-b",
    ]);
  });

  it("keeps the Gmail adapter MessageRef id identical to mutation attribution", async () => {
    const externalId = "provider-message-42";
    const gmailService = {
      listGmailTriageMessages: vi.fn(async () => [
        {
          externalId,
          threadId: "provider-thread-9",
          from: "Alex",
          fromEmail: "alex@example.com",
          to: ["owner@example.com"],
          subject: "Decision needed",
          snippet: "Please approve today",
          receivedAt: "2026-08-17T08:00:00.000Z",
          isUnread: true,
          likelyReplyNeeded: true,
          labels: ["INBOX", "UNREAD"],
          htmlLink: null,
          metadata: {},
        },
      ]),
      searchGmailMessages: vi.fn(),
      getGmailMessageDetail: vi.fn(),
      sendGmailReply: vi.fn(),
      sendGmailMessage: vi.fn(),
      modifyGmailMessages: vi.fn(),
      createGmailFilterForSender: vi.fn(),
    };
    const adapterRuntime = {
      ...runtime,
      getService: (name: string) =>
        name === "google" ? gmailService : runtime.getService(name),
    } as unknown as IAgentRuntime;
    const [ref] = await new GoogleGmailAdapter().listMessages(adapterRuntime, {
      limit: 1,
    });
    if (!ref) throw new Error("Gmail adapter produced no MessageRef");
    const [item] = structureBriefingItems({
      inbox: [
        {
          id: ref.id,
          channel: ref.source,
          senderName: ref.from.displayName ?? ref.from.identifier,
          snippet: ref.snippet,
          urgency: "unknown",
          classification: "unread",
        },
      ],
    });
    if (!item) throw new Error("brief item mapping failed");
    await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-real-gmail-adapter",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "rendered",
      eventAt: "2026-08-17T08:01:00.000Z",
      weight: 0,
      metadata: {},
    });
    expect(ref.id).toBe(gmailBriefSourceId(externalId));
    expect(
      await repository.attributeBriefItemEngagement({
        agentId: runtime.agentId,
        source: "inbox",
        sourceId: gmailBriefSourceId(externalId),
        eventType: "opened",
        eventAt: "2026-08-17T08:02:00.000Z",
        domainEventId: "gmail-mark-read-provider-receipt",
        weight: 0.25,
      }),
    ).toMatchObject({ itemId: item.itemId, eventType: "opened" });
  });

  it("attributes Gmail mark-read through the production MESSAGE adapter path", async () => {
    const externalId = "provider-production-message";
    await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-production-gmail",
      itemId: "inbox:gmail:provider-production-message",
      source: "inbox",
      kind: "message",
      sourceId: gmailBriefSourceId(externalId),
      itemClass: "inbox:reply-needed",
      eventType: "rendered",
      eventAt: new Date(Date.now() - 1_000).toISOString(),
      weight: 0,
      metadata: {},
    });
    const modifyGmailMessages = vi.fn(async () => undefined);
    const sendGmailReply = vi.fn(async () => ({ messageId: "sent-reply-1" }));
    const adapterRuntime = {
      ...runtime,
      emitEvent: runtime.emitEvent.bind(runtime),
      reportError: runtime.reportError.bind(runtime),
      getService: (name: string) =>
        name === "google"
          ? {
              listGmailTriageMessages: vi.fn(async () => [
                {
                  externalId,
                  threadId: "provider-production-thread",
                  from: "Alex",
                  fromEmail: "alex@example.com",
                  to: ["owner@example.com"],
                  subject: "Production path",
                  snippet: "Please review",
                  receivedAt: new Date(Date.now() - 60_000).toISOString(),
                  isUnread: true,
                  likelyReplyNeeded: true,
                  labels: ["INBOX", "UNREAD"],
                  htmlLink: null,
                  metadata: {},
                },
              ]),
              searchGmailMessages: vi.fn(),
              getGmailMessageDetail: vi.fn(),
              sendGmailReply,
              sendGmailMessage: vi.fn(),
              modifyGmailMessages,
              createGmailFilterForSender: vi.fn(),
            }
          : runtime.getService(name),
    } as unknown as IAgentRuntime;
    const triageService = getDefaultTriageService();
    triageService.register(new GoogleGmailAdapter());
    await triageService.triage(adapterRuntime, { sources: ["gmail"] });
    const result = await manageMessageAction.handler(
      adapterRuntime,
      makeMessage("mark it read"),
      undefined,
      {
        parameters: {
          messageId: gmailBriefSourceId(externalId),
          source: "gmail",
          operation: "mark_read",
        },
      } as unknown as HandlerOptions,
      undefined,
    );
    expect(result).toMatchObject({ success: true });
    expect(modifyGmailMessages).toHaveBeenCalledTimes(1);
    expect(
      (await allRows()).filter((row) => row.eventType === "opened"),
    ).toHaveLength(1);
    const reply = await respondToMessageAction.handler(
      adapterRuntime,
      makeMessage("reply now"),
      undefined,
      {
        parameters: {
          messageId: gmailBriefSourceId(externalId),
          body: "Reviewed, thank you.",
        },
      } as unknown as HandlerOptions,
      undefined,
    );
    expect(reply).toMatchObject({ success: true });
    expect(sendGmailReply).toHaveBeenCalledTimes(1);
    expect(
      (await allRows()).filter((row) => row.eventType === "replied"),
    ).toHaveLength(1);
  });

  it("keeps the calendar feed event id identical through a real update bridge", async () => {
    const providerEvent = {
      id: "provider-calendar-event-7",
      title: "Board prep",
      startAt: "2026-08-17T08:00:00.000Z",
      endAt: "2026-08-17T09:00:00.000Z",
    };
    const briefingItem = mapCalendarFeedEventToBriefingItem(providerEvent, {
      startAt: providerEvent.startAt,
      endAt: providerEvent.endAt,
    });
    const [item] = structureBriefingItems({ calendar: [briefingItem] });
    if (!item) throw new Error("calendar brief mapping failed");
    await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-real-calendar-feed",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "rendered",
      eventAt: new Date(Date.now() - 1_000).toISOString(),
      weight: 0,
      metadata: {},
    });
    const calendarService = {
      mutationUpdatedAt: new Date().toISOString(),
      updateCalendarEvent: vi.fn(async () => ({
        ...providerEvent,
        startAt: new Date().toISOString(),
        updatedAt: calendarService.mutationUpdatedAt,
      })),
    };
    const bridgeRuntime = {
      ...runtime,
      getService: (name: string) =>
        name === "calendar" ? calendarService : runtime.getService(name),
      getServicesByType: () => [],
    } as unknown as IAgentRuntime;
    const domain = new CalendarDomain({
      runtime: bridgeRuntime,
      repository,
      agentId: () => runtime.agentId,
    } as never);
    await domain.updateCalendarEvent(new URL("http://127.0.0.1"), {
      eventId: providerEvent.id,
      startAt: new Date().toISOString(),
    });
    await domain.updateCalendarEvent(new URL("http://127.0.0.1"), {
      eventId: providerEvent.id,
      startAt: new Date().toISOString(),
    });
    expect(
      (await allRows()).filter(
        (row) =>
          row.sourceId === providerEvent.id && row.eventType === "rescheduled",
      ),
    ).toEqual([expect.objectContaining({ itemId: item.itemId })]);
  });

  it("attributes built-in calendar time updates without rewarding title-only edits", async () => {
    const renderedAt = new Date(Date.now() - 2_000).toISOString();
    const previous = {
      id: "agent-brief-recal:eliza:calendar:primary:event-7",
      provider: "eliza",
      title: "Board prep",
      startAt: new Date(Date.now() + 3_600_000).toISOString(),
      endAt: new Date(Date.now() + 7_200_000).toISOString(),
      updatedAt: renderedAt,
    } as unknown as LifeOpsCalendarEvent;
    const briefingItem = mapCalendarFeedEventToBriefingItem(previous, {
      startAt: previous.startAt,
      endAt: previous.endAt,
    });
    const [item] = structureBriefingItems({ calendar: [briefingItem] });
    if (!item) throw new Error("built-in calendar brief mapping failed");
    await repository.recordBriefItemEngagement({
      agentId: runtime.agentId,
      briefingId: "brief-built-in-calendar",
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "rendered",
      eventAt: renderedAt,
      weight: 0,
      metadata: {},
    });

    const rescheduled = {
      ...previous,
      startAt: new Date(Date.now() + 5_400_000).toISOString(),
      endAt: new Date(Date.now() + 9_000_000).toISOString(),
      updatedAt: new Date().toISOString(),
    } as LifeOpsCalendarEvent;
    await attributeBuiltInCalendarBriefReschedule({
      runtime,
      event: rescheduled,
      previous,
    });
    await attributeBuiltInCalendarBriefReschedule({
      runtime,
      event: {
        ...rescheduled,
        title: "Board prep renamed",
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
      },
      previous: rescheduled,
    });

    expect(
      (await allRows()).filter((row) => row.eventType === "rescheduled"),
    ).toEqual([
      expect.objectContaining({
        sourceId: previous.id,
        weight: 1,
      }),
    ]);
  });

  it("links delivered morning-brief output to a real trajectory and settles reward end to end", async () => {
    const service = new TrajectoriesService(runtime);
    service.setEnabled(true);
    await service.initialize();
    const trajectoryId = await service.startTrajectory(runtime.agentId, {
      source: "morning-brief-integration",
    });
    const stepId = service.startStep(trajectoryId, { timestamp: Date.now() });
    vi.spyOn(runtime, "useModel").mockResolvedValueOnce(
      "Board prep with investor questions comes first.",
    );
    await runWithTrajectoryContext(
      { trajectoryId, trajectoryStepId: stepId, purpose: "action" },
      () =>
        callBrief(
          runtime,
          { action: "compose_morning", format: "narrative" },
          async () => undefined,
        ),
    );
    service.completeStep(trajectoryId, stepId, {
      actionType: "action",
      actionName: "BRIEF",
      parameters: {},
      success: true,
    });
    await service.flushWriteQueue(trajectoryId);
    await service.endTrajectory(trajectoryId, "completed");

    const rendered = (await allRows()).find(
      (row) => row.itemId === "calendar:board-prep",
    );
    expect(rendered?.metadata).toMatchObject({
      trajectoryId,
      trajectoryStepId: stepId,
    });
    if (!rendered) throw new Error("rendered row missing");
    const engagement = await repository.attributeBriefItemEngagement({
      agentId: runtime.agentId,
      source: rendered.source,
      sourceId: rendered.sourceId,
      eventType: "kept",
      eventAt: new Date(Date.parse(rendered.eventAt) + 60_000).toISOString(),
      domainEventId: "meeting-kept:real-trajectory",
      weight: 0.75,
    });
    if (!engagement) throw new Error("engagement attribution missing");
    const rewardRuntime = {
      ...runtime,
      getService: () => service,
      getServicesByType: () => [service],
    } as unknown as IAgentRuntime;
    expect(
      await settleBriefEngagementReward({
        runtime: rewardRuntime,
        repository,
        engagement,
      }),
    ).toBe(true);
    const trajectory = await service.getTrajectoryDetail(trajectoryId);
    expect(trajectory).toMatchObject({
      metrics: { finalStatus: "completed" },
      totalReward: 0.75,
      rewardComponents: {
        components: { briefEngagementReward: 0.75 },
      },
    });
  });
});
