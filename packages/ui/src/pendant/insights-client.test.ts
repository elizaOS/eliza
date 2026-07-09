/** Validates the insight HTTP boundary, including opt-in and malformed responses. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithCsrf = vi.hoisted(() => vi.fn());
vi.mock("../api/csrf-client", () => ({ fetchWithCsrf }));

import { HttpInsightsClient } from "./insights-client";

const segment = {
  id: "session-1:segment:0",
  sessionId: "session-1",
  ordinal: 0,
  revision: 0,
  text: "hello",
};

beforeEach(() => {
  fetchWithCsrf.mockReset();
});

describe("HttpInsightsClient", () => {
  it("sends the explicit opt-in and canonical session identity", async () => {
    fetchWithCsrf.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, reason: "too-few-segments" }), {
        status: 200,
      }),
    );
    const client = new HttpInsightsClient();
    const result = await client.requestInsights({
      sessionId: "session-1",
      segments: [segment],
    });
    expect(result).toEqual({
      ok: false,
      skipped: true,
      reason: "too-few-segments",
    });
    const init = fetchWithCsrf.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      enabled: true,
      sessionId: "session-1",
      segments: [segment],
    });
  });

  it("fails explicitly on malformed JSON", async () => {
    fetchWithCsrf.mockResolvedValue(new Response("not-json", { status: 200 }));
    const result = await new HttpInsightsClient().requestInsights({
      sessionId: "session-1",
      segments: [segment],
    });
    expect(result).toMatchObject({
      ok: false,
      skipped: false,
      error: expect.stringMatching(/invalid pendant insights JSON/),
    });
  });

  it("fails closed when success provenance is missing", async () => {
    fetchWithCsrf.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          insights: {
            schemaVersion: 1,
            summary: "hello",
            actionItems: [],
            topics: [],
            peopleMentioned: [],
            notableQuotes: [],
            generatedAt: 1,
            transcriptRange: {
              startOrdinal: 0,
              endOrdinal: 0,
              segmentCount: 1,
              startedAtMs: 0,
              endedAtMs: 0,
            },
          },
        }),
        { status: 200 },
      ),
    );
    const result = await new HttpInsightsClient().requestInsights({
      sessionId: "session-1",
      segments: [segment],
    });
    expect(result).toMatchObject({
      ok: false,
      skipped: false,
    });
  });
});
