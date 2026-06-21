/**
 * OpenAI live-drift validation.
 *
 * Gated: needs OPENAI_LIVE_TEST=1 (or TEST_LANE=post-merge) AND OPENAI_API_KEY.
 * Excluded from the PR lane (`*.real.test.ts`); runs in the nightly
 * `external-api-live-drift.yml` lane.
 *
 * Asserts the live OpenAI response *shapes* that `packages/test/mocks/environments/openai.json`
 * mirrors, so a divergence between the wire-mock and reality surfaces as a
 * failed/flagged nightly run.
 */
import { describe, expect, it } from "vitest";

const LIVE =
  (process.env.OPENAI_LIVE_TEST === "1" || process.env.TEST_LANE === "post-merge") &&
  !!process.env.OPENAI_API_KEY?.trim();

const BASE = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
const KEY = process.env.OPENAI_API_KEY ?? "";
const SMALL_MODEL = process.env.OPENAI_SMALL_MODEL?.trim() || "gpt-4o-mini";
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";

describe.skipIf(!LIVE)("OpenAI live drift — mock shape vs reality", () => {
  it("GET /v1/models returns a list of { id, object } entries", async () => {
    const res = await fetch(`${BASE}/models`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.data?.[0]?.id).toBe("string");
  });

  it("POST /v1/chat/completions returns choices[0].message.content", async () => {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: SMALL_MODEL,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 5,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    expect(typeof body.choices?.[0]?.message?.content).toBe("string");
  });

  it("POST /v1/embeddings returns data[].embedding numeric vectors", async () => {
    const res = await fetch(`${BASE}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: "drift check" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: Array<{ embedding?: unknown }>;
    };
    const embedding = body.data?.[0]?.embedding;
    expect(Array.isArray(embedding)).toBe(true);
    expect(typeof (embedding as number[])[0]).toBe("number");
  });
});
