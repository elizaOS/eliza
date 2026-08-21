/**
 * Brief editorial-judgment tests cover the structured artifact that links
 * rendered brief items, engagement history, and deterministic recalibration.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  buildBriefEditorialContract,
  recalibrateBriefItemClasses,
  selectRecalibrationCandidates,
  structureBriefingItems,
  summarizeBriefEngagementRows,
} from "../src/lifeops/briefing/editorial-judgment.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import type { LifeOpsBriefingSections } from "../src/types/briefing.js";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

const sections: LifeOpsBriefingSections = {
  calendar: [
    {
      id: "board-prep",
      title: "Board prep with investor questions",
      startAt: "2026-07-06T16:00:00.000Z",
      endAt: "2026-07-06T17:00:00.000Z",
    },
    {
      id: "newsletter-review",
      title: "Newsletter digest review",
      startAt: "2026-07-06T18:00:00.000Z",
      endAt: "2026-07-06T18:30:00.000Z",
    },
  ],
  inbox: [
    {
      id: "msg-approval",
      channel: "gmail",
      senderName: "Mara",
      snippet: "Please approve the vendor SOW by 3pm.",
      urgency: "high",
      classification: "needs_reply",
    },
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

describe("brief editorial judgment", () => {
  let runtimeResult:
    | Awaited<ReturnType<typeof createLifeOpsTestRuntime>>
    | undefined;

  afterEach(async () => {
    await runtimeResult?.cleanup();
    runtimeResult = undefined;
  });

  it("assigns structural item identities and leads with the highest consequence item", () => {
    const contract = buildBriefEditorialContract({ sections, maxItems: 3 });

    expect(contract.items.map((item) => item.itemId)).toContain(
      "calendar:board-prep",
    );
    expect(contract.items.map((item) => item.itemId)).toContain(
      "inbox:msg-newsletter",
    );
    expect(contract.decisions[0]).toMatchObject({
      itemId: "calendar:board-prep",
      action: "lead",
    });
    expect(contract.decisions).toContainEqual(
      expect.objectContaining({
        itemId: "inbox:msg-newsletter",
        action: "omit",
      }),
    );
  });

  it("demotes repeatedly ignored item classes without hiding the reason", () => {
    const contract = buildBriefEditorialContract({
      sections,
      maxItems: 4,
      engagementSummaries: [
        {
          itemClass: "inbox:newsletter-digest",
          renderedCount: 5,
          ignoredCount: 5,
          actedOnCount: 0,
          lastEventAt: "2026-07-05T12:00:00.000Z",
          lastDemotedAt: null,
          lastRestoredAt: null,
        },
      ],
    });

    expect(contract.demotedItemClasses).toEqual(["inbox:newsletter-digest"]);
    expect(contract.decisions).toContainEqual(
      expect.objectContaining({
        itemId: "inbox:msg-newsletter",
        action: "demote",
        reason:
          "inbox:newsletter-digest has repeated ignore history with no acted-on signal",
      }),
    );
  });

  it("tracks explicit demoted/restored markers and gives them precedence over ignore counts", () => {
    const rows = [
      {
        itemClass: "inbox:newsletter-digest",
        eventType: "rendered" as const,
        eventAt: "2026-07-01T12:00:00.000Z",
      },
      {
        itemClass: "inbox:newsletter-digest",
        eventType: "demoted" as const,
        eventAt: "2026-07-02T12:00:00.000Z",
      },
      {
        itemClass: "life:habit",
        eventType: "ignored" as const,
        eventAt: "2026-07-02T12:00:00.000Z",
      },
    ];
    const summaries = summarizeBriefEngagementRows(rows);
    const newsletter = summaries.find(
      (summary) => summary.itemClass === "inbox:newsletter-digest",
    );
    expect(newsletter).toMatchObject({
      lastDemotedAt: "2026-07-02T12:00:00.000Z",
      lastRestoredAt: null,
    });

    // Explicit demoted marker demotes even though ignoredCount is below the
    // automatic threshold.
    expect(recalibrateBriefItemClasses(summaries)).toEqual([
      "inbox:newsletter-digest",
    ]);

    // A later restored marker reverses the demotion regardless of counts —
    // including a same-instant reset, which must win.
    const reset = summarizeBriefEngagementRows([
      ...rows,
      {
        itemClass: "inbox:newsletter-digest",
        eventType: "restored" as const,
        eventAt: "2026-07-02T12:00:00.000Z",
      },
    ]);
    expect(recalibrateBriefItemClasses(reset)).toEqual([]);

    // A restored marker also overrides the automatic ignore rule.
    const restoredDespiteIgnores = summarizeBriefEngagementRows(
      Array.from({ length: 5 }, (_, index) => ({
        itemClass: "inbox:newsletter-digest",
        eventType: "ignored" as const,
        eventAt: `2026-07-0${index + 1}T12:00:00.000Z`,
      })).concat([
        {
          itemClass: "inbox:newsletter-digest",
          eventType: "restored" as const,
          eventAt: "2026-07-06T12:00:00.000Z",
        },
      ]),
    );
    expect(recalibrateBriefItemClasses(restoredDespiteIgnores)).toEqual([]);
  });

  it("selects recalibration candidates by revealed preference and exact targeted class", () => {
    const summaries = summarizeBriefEngagementRows([
      // Rendered five times, never acted on -> untargeted candidate.
      ...Array.from({ length: 5 }, (_, index) => ({
        itemClass: "inbox:newsletter-digest",
        eventType: "rendered" as const,
        eventAt: `2026-07-0${index + 1}T12:00:00.000Z`,
      })),
      // Rendered five times but acted on -> never an untargeted candidate.
      ...Array.from({ length: 5 }, (_, index) => ({
        itemClass: "calendar:meeting",
        eventType: "rendered" as const,
        eventAt: `2026-07-0${index + 1}T13:00:00.000Z`,
      })),
      {
        itemClass: "calendar:meeting",
        eventType: "completed" as const,
        eventAt: "2026-07-05T14:00:00.000Z",
      },
      // Barely surfaced -> below the threshold.
      {
        itemClass: "life:habit",
        eventType: "rendered" as const,
        eventAt: "2026-07-05T15:00:00.000Z",
      },
      // Ignore markers close rendered delivery windows; they are not extra
      // impressions and cannot lift a class above the surfaced threshold.
      ...Array.from({ length: 3 }, (_, index) => [
        {
          itemClass: "inbox:three-deliveries",
          eventType: "rendered" as const,
          eventAt: `2026-07-0${index + 1}T16:00:00.000Z`,
        },
        {
          itemClass: "inbox:three-deliveries",
          eventType: "ignored" as const,
          eventAt: `2026-07-0${index + 2}T16:00:00.000Z`,
        },
      ]).flat(),
    ]);

    expect(
      selectRecalibrationCandidates(summaries).map((s) => s.itemClass),
    ).toEqual(["inbox:newsletter-digest"]);

    // A targeted command selects exactly the named class and nothing else,
    // even when that class would not qualify automatically.
    expect(
      selectRecalibrationCandidates(summaries, {
        itemClass: "life:habit",
      }).map((s) => s.itemClass),
    ).toEqual(["life:habit"]);
    expect(
      selectRecalibrationCandidates(summaries, {
        itemClass: "calendar:meeting",
      }).map((s) => s.itemClass),
    ).toEqual(["calendar:meeting"]);
  });

  it("persists engagement rows and summarizes recalibration signals", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    await LifeOpsRepository.bootstrapSchema(runtimeResult.runtime);
    const repository = new LifeOpsRepository(runtimeResult.runtime);
    const newsletterSource = sections.inbox?.[1] ?? sections.inbox?.[0];
    expect(newsletterSource).toBeDefined();
    const [newsletter] = structureBriefingItems({
      inbox: newsletterSource ? [newsletterSource] : [],
    });
    if (!newsletter) {
      throw new Error("newsletter fixture did not produce a structured item");
    }

    for (let day = 1; day <= 5; day += 1) {
      const eventAt = `2026-07-0${day}T12:00:00.000Z`;
      await repository.recordBriefItemEngagement({
        agentId: runtimeResult.runtime.agentId,
        briefingId: `brief-${day}`,
        itemId: newsletter.itemId,
        source: newsletter.source,
        kind: newsletter.kind,
        sourceId: newsletter.sourceId,
        itemClass: newsletter.itemClass,
        eventType: "ignored",
        eventAt,
        weight: -1,
        metadata: { scenario: "ignore-pattern" },
      });
    }

    const rows = await repository.listBriefItemEngagements(
      runtimeResult.runtime.agentId,
      { itemClass: "inbox:newsletter-digest" },
    );
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      itemId: "inbox:msg-newsletter",
      eventType: "ignored",
      metadata: { scenario: "ignore-pattern" },
    });

    const summaries = await repository.summarizeBriefItemEngagements(
      runtimeResult.runtime.agentId,
    );
    expect(summaries).toEqual([
      {
        itemClass: "inbox:newsletter-digest",
        renderedCount: 0,
        ignoredCount: 5,
        actedOnCount: 0,
        lastEventAt: "2026-07-05T12:00:00.000Z",
        lastDemotedAt: null,
        lastRestoredAt: null,
      },
    ]);
    expect(
      buildBriefEditorialContract({
        sections,
        engagementSummaries: summaries,
      }).demotedItemClasses,
    ).toEqual(["inbox:newsletter-digest"]);
  });
});
