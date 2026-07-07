/**
 * Brief editorial-judgment tests cover the structured artifact that links
 * rendered brief items, engagement history, and deterministic recalibration.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  buildBriefEditorialContract,
  structureBriefingItems,
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
