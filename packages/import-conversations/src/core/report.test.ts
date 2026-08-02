/** Unit tests for the plan/apply ReportBuilder counters and summary shape. Deterministic. */

import { describe, expect, it } from "vitest";
import {
  notImported,
  ReportBuilder,
  SKIP_REASON_NO_MESSAGES,
  summarizeReport,
} from "./report.ts";

describe("ReportBuilder", () => {
  it("tallies counts across outcomes", () => {
    const b = new ReportBuilder("chatgpt", "batch-1", false);
    b.record({ sourceConversationId: "c1", change: "added", documentCount: 2 });
    b.record({
      sourceConversationId: "c2",
      change: "unchanged",
      documentCount: 1,
    });
    b.record({
      sourceConversationId: "c3",
      change: "updated",
      documentCount: 3,
    });
    b.skip({ sourceConversationId: "c4", reason: SKIP_REASON_NO_MESSAGES });
    b.error({ sourceConversationId: "c5", reason: "boom" });

    const report = b.build();
    expect(report.summary).toEqual({
      total: 5,
      added: 1,
      unchanged: 1,
      updated: 1,
      skipped: 1,
      errors: 1,
      documentsStored: 2 + 1 + 3,
    });
  });

  it("marks dryRun", () => {
    const b = new ReportBuilder("hermes", "b", true);
    expect(b.build().dryRun).toBe(true);
  });

  it("attaches an unchanged reason automatically", () => {
    const b = new ReportBuilder("chatgpt", "b", false);
    b.record({
      sourceConversationId: "c1",
      change: "unchanged",
      documentCount: 0,
    });
    const item = b.build().items[0];
    expect(item.outcome).toBe("unchanged");
    expect(item.reason).toBeDefined();
  });
});

describe("notImported", () => {
  it("returns only skipped + errored items with reasons", () => {
    const b = new ReportBuilder("chatgpt", "b", false);
    b.record({ sourceConversationId: "ok", change: "added", documentCount: 1 });
    b.skip({ sourceConversationId: "empty", reason: SKIP_REASON_NO_MESSAGES });
    b.error({ sourceConversationId: "bad", reason: "parse failure" });
    const report = b.build();
    const missing = notImported(report);
    expect(missing.map((i) => i.sourceConversationId).sort()).toEqual([
      "bad",
      "empty",
    ]);
    expect(missing.every((i) => Boolean(i.reason))).toBe(true);
  });
});

describe("summarizeReport", () => {
  it("produces a compact one-liner", () => {
    const b = new ReportBuilder("chatgpt", "batch-9", false);
    b.record({ sourceConversationId: "c1", change: "added", documentCount: 1 });
    const line = summarizeReport(b.build());
    expect(line).toContain("chatgpt apply batch-9");
    expect(line).toContain("added=1");
    expect(line).toContain("docs=1");
  });
});
