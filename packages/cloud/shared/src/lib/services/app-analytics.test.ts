// Exercises app analytics behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import type { AppRequest } from "../../db/repositories/apps";
import { AppAnalyticsService } from "./app-analytics";

const BASE_REQUEST = {
  id: "00000000-0000-4000-8000-000000000001",
  app_id: "00000000-0000-4000-8000-000000000002",
  request_type: "pageview",
  source: "hosted_frontend",
  ip_address: "203.0.113.10",
  user_agent: "test-agent",
  country: null,
  city: null,
  user_id: null,
  model: null,
  input_tokens: 0,
  output_tokens: 0,
  credits_used: "0.000000",
  response_time_ms: null,
  status: "success",
  error_message: null,
  metadata: {},
  created_at: new Date("2026-07-02T12:00:00.000Z"),
} satisfies AppRequest;

function request(id: string, at: string, metadata: Record<string, unknown>): AppRequest {
  return {
    ...BASE_REQUEST,
    id,
    metadata,
    created_at: new Date(at),
  };
}

describe("AppAnalyticsService.buildSessionAnalytics", () => {
  test("groups pageviews by beacon session id and computes ordered funnel conversion", () => {
    const service = new AppAnalyticsService();
    const analytics = service.buildSessionAnalytics(
      [
        request("00000000-0000-4000-8000-000000000011", "2026-07-02T12:00:00Z", {
          visitor_id: "visitor-a",
          session_id: "session-a",
          page_url: "/",
        }),
        request("00000000-0000-4000-8000-000000000012", "2026-07-02T12:02:00Z", {
          visitor_id: "visitor-a",
          session_id: "session-a",
          page_url: "/pricing",
        }),
        request("00000000-0000-4000-8000-000000000013", "2026-07-02T12:04:00Z", {
          visitor_id: "visitor-a",
          session_id: "session-a",
          page_url: "/checkout",
        }),
        request("00000000-0000-4000-8000-000000000014", "2026-07-02T12:01:00Z", {
          visitor_id: "visitor-b",
          session_id: "session-b",
          page_url: "/",
        }),
        request("00000000-0000-4000-8000-000000000015", "2026-07-02T12:03:00Z", {
          visitor_id: "visitor-b",
          session_id: "session-b",
          page_url: "/pricing",
        }),
      ],
      ["/", "/pricing", "/checkout"],
    );

    expect(analytics.summary.totalSessions).toBe(2);
    expect(analytics.summary.uniqueVisitors).toBe(2);
    expect(analytics.summary.totalPageViews).toBe(5);
    expect(analytics.summary.avgPagesPerSession).toBe(2.5);
    expect(analytics.summary.bounceRatePercent).toBe(0);
    expect(analytics.sessions[0]?.entryPath).toBe("/");
    expect(analytics.sessions[0]?.exitPath).toBe("/pricing");

    expect(analytics.funnel.totalEntrants).toBe(2);
    expect(analytics.funnel.steps.map((s) => s.path)).toEqual(["/", "/pricing", "/checkout"]);
    expect(analytics.funnel.steps.map((s) => s.sessions)).toEqual([2, 2, 1]);
    expect(analytics.funnel.steps[2]?.conversionFromStartPercent).toBe(50);
    expect(analytics.funnel.steps[2]?.conversionFromPreviousPercent).toBe(50);
  });

  test("falls back to IP/hour buckets for legacy pageviews without beacon ids", () => {
    const service = new AppAnalyticsService();
    const analytics = service.buildSessionAnalytics([
      request("00000000-0000-4000-8000-000000000021", "2026-07-02T12:00:00Z", {
        page_url: "/docs?x=1",
      }),
      request("00000000-0000-4000-8000-000000000022", "2026-07-02T12:10:00Z", {
        pathname: "/docs/install",
      }),
    ]);

    expect(analytics.summary.totalSessions).toBe(1);
    expect(analytics.sessions[0]?.visitorId).toBe("203.0.113.10");
    expect(analytics.sessions[0]?.entryPath).toBe("/docs");
    expect(analytics.sessions[0]?.exitPath).toBe("/docs/install");
  });

  test("requires funnel steps to occur in order inside a session", () => {
    const service = new AppAnalyticsService();
    const analytics = service.buildSessionAnalytics(
      [
        request("00000000-0000-4000-8000-000000000031", "2026-07-02T12:00:00Z", {
          visitor_id: "visitor-a",
          session_id: "session-a",
          page_url: "/",
        }),
        request("00000000-0000-4000-8000-000000000032", "2026-07-02T12:01:00Z", {
          visitor_id: "visitor-a",
          session_id: "session-a",
          page_url: "/checkout",
        }),
        request("00000000-0000-4000-8000-000000000033", "2026-07-02T12:02:00Z", {
          visitor_id: "visitor-a",
          session_id: "session-a",
          page_url: "/pricing",
        }),
        request("00000000-0000-4000-8000-000000000034", "2026-07-02T12:00:30Z", {
          visitor_id: "visitor-b",
          session_id: "session-b",
          page_url: "/",
        }),
        request("00000000-0000-4000-8000-000000000035", "2026-07-02T12:01:30Z", {
          visitor_id: "visitor-b",
          session_id: "session-b",
          page_url: "/pricing",
        }),
        request("00000000-0000-4000-8000-000000000036", "2026-07-02T12:02:30Z", {
          visitor_id: "visitor-b",
          session_id: "session-b",
          page_url: "/checkout",
        }),
      ],
      ["/", "/pricing", "/checkout"],
    );

    expect(analytics.funnel.steps.map((s) => s.sessions)).toEqual([2, 2, 1]);
    expect(analytics.funnel.steps[2]?.visitors).toBe(1);
    expect(analytics.funnel.steps[2]?.conversionFromPreviousPercent).toBe(50);
  });

  test("splits legacy fallback sessions at the hour-bucket window boundary", () => {
    const service = new AppAnalyticsService();
    const analytics = service.buildSessionAnalytics([
      request("00000000-0000-4000-8000-000000000041", "2026-07-02T12:59:00Z", {
        page_url: "/a",
      }),
      request("00000000-0000-4000-8000-000000000042", "2026-07-02T13:01:00Z", {
        page_url: "/b",
      }),
    ]);

    // Same IP two minutes apart, but the pageviews land in different hour
    // buckets, so the fallback sessionizer produces two single-page sessions.
    expect(analytics.summary.totalSessions).toBe(2);
    expect(analytics.summary.uniqueVisitors).toBe(1);
    expect(analytics.summary.bounceRatePercent).toBe(100);
    expect(analytics.sessions.map((s) => s.pageViews)).toEqual([1, 1]);
  });

  test("keeps one session when a beacon session id spans the fallback window boundary", () => {
    const service = new AppAnalyticsService();
    const analytics = service.buildSessionAnalytics([
      request("00000000-0000-4000-8000-000000000051", "2026-07-02T12:59:00Z", {
        visitor_id: "visitor-a",
        session_id: "session-a",
        page_url: "/a",
      }),
      request("00000000-0000-4000-8000-000000000052", "2026-07-02T13:30:00Z", {
        visitor_id: "visitor-a",
        session_id: "session-a",
        page_url: "/b",
      }),
    ]);

    // Beacon-provided session ids own the session lifetime: the hour-bucket
    // fallback never splits rows that carry an explicit session id.
    expect(analytics.summary.totalSessions).toBe(1);
    expect(analytics.sessions[0]?.pageViews).toBe(2);
    expect(analytics.sessions[0]?.durationMs).toBe(31 * 60 * 1000);
    expect(analytics.sessions[0]?.entryPath).toBe("/a");
    expect(analytics.sessions[0]?.exitPath).toBe("/b");
  });
});
