/**
 * Anthropic live-drift validation.
 *
 * Gated: needs ANTHROPIC_LIVE_TEST=1 (or TEST_LANE=post-merge) AND ANTHROPIC_API_KEY.
 * Excluded from the PR lane (`*.real.test.ts`); runs in the nightly
 * `external-api-live-drift.yml` lane.
 *
 * Asserts the live Anthropic response *shapes* that `packages/test/mocks/environments/anthropic.json`
 * mirrors, so a divergence between the wire-mock and reality surfaces as a
 * failed/flagged nightly run.
 */
import { describe, expect, it } from "vitest";

const LIVE =
  (process.env.ANTHROPIC_LIVE_TEST === "1" || process.env.TEST_LANE === "post-merge") &&
  !!process.env.ANTHROPIC_API_KEY?.trim();

const BASE = process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com/v1";
const KEY = process.env.ANTHROPIC_API_KEY ?? "";
const SMALL_MODEL = process.env.ANTHROPIC_SMALL_MODEL?.trim() || "claude-haiku-4-5-20251001";

const headers = {
  "x-api-key": KEY,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
};

describe.skipIf(!LIVE)("Anthropic live drift — mock shape vs reality", () => {
  it("POST /v1/messages returns content[0].text", async () => {
    const res = await fetch(`${BASE}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: SMALL_MODEL,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content?: Array<{ type?: string; text?: unknown }>;
    };
    const first = body.content?.[0];
    expect(first?.type).toBe("text");
    expect(typeof first?.text).toBe("string");
  });

  it("GET /v1/models returns a list of { id } entries", async () => {
    const res = await fetch(`${BASE}/models`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.data?.[0]?.id).toBe("string");
  });
});
