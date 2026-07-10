/**
 * Offline coverage for staging voice ops report helpers.
 *
 * These tests keep the redacted artifact math deterministic without requiring
 * staging credentials or live cloud endpoints.
 */

import { describe, expect, it } from "vitest";
import {
  joinUrl,
  metricSummaries,
  redactIdentifier,
  renderStagingMarkdown,
  type StagingReport,
} from "../src/staging-common.ts";
import { parseCurlTiming } from "../src/staging-batch.ts";

describe("staging helpers", () => {
  it("summarizes nullable metrics", () => {
    const runs = [{ ms: 10 }, { ms: 30 }, { ms: null }, { ms: 20 }];
    const summaries = metricSummaries(runs, ["ms"], (run) => run.ms);
    expect(summaries.ms.count).toBe(3);
    expect(summaries.ms.p50).toBe(20);
    expect(summaries.ms.p90).toBe(30);
    expect(summaries.ms.p95).toBe(30);
  });

  it("renders markdown without secret-like identifiers", () => {
    const report: StagingReport<
      "latencyMs",
      { metrics: { latencyMs: number } }
    > = {
      schemaVersion: 1,
      generatedAt: "2026-07-10T00:00:00.000Z",
      tool: "Staging Voice Test",
      target: {
        baseUrl: "https://staging.elizacloud.ai",
        paths: { tts: "/x" },
      },
      summaries: metricSummaries(
        [{ metrics: { latencyMs: 12 } }],
        ["latencyMs"],
        (run) => run.metrics.latencyMs,
      ),
      runs: [{ metrics: { latencyMs: 12 } }],
    };
    const markdown = renderStagingMarkdown(report, ["| Run |", "|---|"]);
    expect(markdown).toContain("latencyMs");
    expect(markdown).not.toContain("Bearer");
  });

  it("joins URLs and redacts long identifiers", () => {
    expect(joinUrl("https://staging.elizacloud.ai/", "/api/v1/voice/stt")).toBe(
      "https://staging.elizacloud.ai/api/v1/voice/stt",
    );
    expect(redactIdentifier("session_123456789")).toBe("sess...6789");
  });

  it("parses curl timing JSON into milliseconds", () => {
    expect(
      parseCurlTiming(
        '{"httpCode":"200","dns":"0.001","connect":"0.002","tls":"0.003","ttfb":"0.040","total":"0.050"}',
      ),
    ).toEqual({
      httpCode: 200,
      dnsMs: 1,
      connectMs: 2,
      tlsMs: 3,
      ttfbMs: 40,
      totalMs: 50,
    });
  });
});
