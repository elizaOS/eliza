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
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
  setBriefComposers,
} from "../src/actions/brief.js";
import { structureBriefingItems } from "../src/lifeops/briefing/editorial-judgment.js";
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
  }, 120_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  beforeEach(async () => {
    mocks.hasOwnerAccess.mockReset().mockResolvedValue(true);
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

  it("records one rendered impression per surfaced item only after a delivered compose", async () => {
    const result = await callBrief(
      runtime,
      { action: "compose_morning", format: "json" },
      async () => undefined,
    );
    expect(result).toMatchObject({ success: true });
    const briefing = briefingFromResult(result);

    const rows = await allRows();
    const surfaced = briefing.editorial.decisions.filter(
      (decision) => decision.action !== "omit",
    );
    expect(rows).toHaveLength(surfaced.length);
    expect(rows.every((row) => row.eventType === "rendered")).toBe(true);
    expect(rows.every((row) => row.briefingId === briefing.id)).toBe(true);
    expect(rows[0]?.metadata).toMatchObject({
      briefingKind: "morning",
      period: "today",
    });

    // No callback -> nothing was shown to the owner -> no impressions.
    const undelivered = await callBrief(runtime, {
      action: "compose_morning",
      format: "json",
    });
    expect(undelivered).toMatchObject({ success: true });
    expect(await allRows()).toHaveLength(surfaced.length);
  });

  async function seedRendered(itemClass: "newsletter" | "calendar") {
    const source =
      itemClass === "newsletter"
        ? { inbox: sections.inbox ?? [] }
        : { calendar: sections.calendar ?? [] };
    const [item] = structureBriefingItems(source);
    if (!item) throw new Error("fixture produced no structured item");
    for (let day = 1; day <= 5; day += 1) {
      await repository.recordBriefItemEngagement({
        agentId: runtime.agentId,
        briefingId: `seed-brief-${itemClass}-${day}`,
        itemId: item.itemId,
        source: item.source,
        kind: item.kind,
        sourceId: item.sourceId,
        itemClass: item.itemClass,
        eventType: "rendered",
        eventAt: `2026-07-0${day}T12:00:00.000Z`,
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
      eventAt: "2026-07-05T18:00:00.000Z",
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
});
