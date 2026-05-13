/**
 * Tests for the shared CerebrasJudge transport. These cover:
 *   - tolerant JSON parsing (strict, fenced, prose+JSON, garbage)
 *   - canonical verdict mapping from `score` and from `verdict` strings
 *   - retry on 429 / 5xx (with backoff)
 *   - fail-fast on 4xx other than 429
 *   - `response_format: { type: "json_object" }` opt-in
 *
 * The HTTP boundary is mocked with `vi.spyOn(globalThis, "fetch")` so no
 * network is touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CerebrasJudge,
  extractBalancedJsonObject,
  normalizeVerdict,
  tolerantJsonParse,
  verdictFromScore,
} from "./cerebras-judge.ts";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetchOnceJson(content: string, status = 200): void {
  const body = JSON.stringify({
    choices: [{ message: { content } }],
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function mockFetchOnceError(status: number, errorBody = "rate limited"): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(errorBody, {
      status,
      headers: { "Content-Type": "text/plain" },
    }),
  );
}

describe("tolerantJsonParse", () => {
  it("parses strict JSON", () => {
    expect(tolerantJsonParse('{"score":0.8,"reason":"ok"}')).toEqual({
      score: 0.8,
      reason: "ok",
    });
  });

  it("parses JSON inside a ```json fence", () => {
    const text = '```json\n{"score":1,"reason":"yes"}\n```';
    expect(tolerantJsonParse(text)).toEqual({ score: 1, reason: "yes" });
  });

  it("parses JSON preceded by prose", () => {
    const text = 'Here we go: {"verdict":"PASS","reason":"x"}';
    expect(tolerantJsonParse(text)).toEqual({
      verdict: "PASS",
      reason: "x",
    });
  });

  it("parses JSON followed by trailing prose", () => {
    const text = '{"score":0.5,"reason":"meh"} thanks!';
    expect(tolerantJsonParse(text)).toEqual({ score: 0.5, reason: "meh" });
  });

  it("returns null on garbage and arrays", () => {
    expect(tolerantJsonParse("")).toBeNull();
    expect(tolerantJsonParse("not json")).toBeNull();
    expect(tolerantJsonParse('["a","b"]')).toBeNull();
  });
});

describe("extractBalancedJsonObject", () => {
  it("respects string boundaries and escapes", () => {
    const raw = 'pre {"reason":"has }-brace and \\"quoted\\""} post';
    expect(extractBalancedJsonObject(raw)).toBe(
      '{"reason":"has }-brace and \\"quoted\\""}',
    );
  });

  it("returns null on no object", () => {
    expect(extractBalancedJsonObject("no braces here")).toBeNull();
  });
});

describe("verdictFromScore + normalizeVerdict", () => {
  it("maps high scores to PASS", () => {
    expect(verdictFromScore(0.9)).toBe("PASS");
    expect(verdictFromScore(0.75)).toBe("PASS");
  });
  it("maps low scores to FAIL", () => {
    expect(verdictFromScore(0)).toBe("FAIL");
    expect(verdictFromScore(0.25)).toBe("FAIL");
  });
  it("maps middle scores to REVIEW", () => {
    expect(verdictFromScore(0.5)).toBe("REVIEW");
  });
  it("normalizes verdict strings", () => {
    expect(normalizeVerdict("YES")).toBe("PASS");
    expect(normalizeVerdict("pass")).toBe("PASS");
    expect(normalizeVerdict("NO")).toBe("FAIL");
    expect(normalizeVerdict("fail")).toBe("FAIL");
    expect(normalizeVerdict("NEEDS_REVIEW")).toBe("REVIEW");
    expect(normalizeVerdict("review")).toBe("REVIEW");
    expect(normalizeVerdict("MAYBE")).toBeUndefined();
    expect(normalizeVerdict(42)).toBeUndefined();
  });
});

describe("CerebrasJudge", () => {
  beforeEach(() => {
    process.env.CEREBRAS_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("constructs with explicit options (no env required)", () => {
    delete process.env.CEREBRAS_API_KEY;
    const judge = new CerebrasJudge({
      apiKey: "explicit-key",
      baseUrl: "http://example/v1",
      model: "gpt-oss-120b",
    });
    expect(judge).toBeInstanceOf(CerebrasJudge);
  });

  it("throws when no apiKey is available", () => {
    delete process.env.CEREBRAS_API_KEY;
    expect(() => new CerebrasJudge()).toThrow(/CEREBRAS_API_KEY/);
  });

  it("parses strict JSON output, derives verdict from score", async () => {
    mockFetchOnceJson('{"score":0.9,"reason":"good"}');
    const judge = new CerebrasJudge();
    const result = await judge.judge("test prompt");
    expect(result.raw).toBe('{"score":0.9,"reason":"good"}');
    expect(result.score).toBe(0.9);
    expect(result.verdict).toBe("PASS");
    expect(result.reason).toBe("good");
  });

  it("parses fenced JSON output", async () => {
    mockFetchOnceJson('```json\n{"verdict":"FAIL","reason":"nope"}\n```');
    const judge = new CerebrasJudge();
    const result = await judge.judge("test prompt");
    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toBe("nope");
  });

  it("parses prose + JSON tail", async () => {
    mockFetchOnceJson(
      'Sure, here you go: {"score":0.5,"reason":"mixed"} thanks',
    );
    const judge = new CerebrasJudge();
    const result = await judge.judge("test prompt");
    expect(result.json).toEqual({ score: 0.5, reason: "mixed" });
    expect(result.verdict).toBe("REVIEW");
  });

  it("returns json:null on garbage output", async () => {
    mockFetchOnceJson("complete gibberish, no braces at all");
    const judge = new CerebrasJudge();
    const result = await judge.judge("test prompt");
    expect(result.json).toBeNull();
    expect(result.verdict).toBeUndefined();
    expect(result.score).toBeUndefined();
  });

  it("retries on 429 then succeeds", async () => {
    mockFetchOnceError(429);
    mockFetchOnceJson('{"score":1,"reason":"ok"}');
    const judge = new CerebrasJudge({ maxRetries: 2 });
    const result = await judge.judge("test prompt");
    expect(result.score).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 500 then succeeds", async () => {
    mockFetchOnceError(503);
    mockFetchOnceJson('{"score":0.8,"reason":"ok"}');
    const judge = new CerebrasJudge({ maxRetries: 2 });
    const result = await judge.judge("test prompt");
    expect(result.score).toBe(0.8);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("fails fast on 400/401/403", async () => {
    mockFetchOnceError(401, "bad key");
    const judge = new CerebrasJudge({ maxRetries: 2 });
    await expect(judge.judge("test prompt")).rejects.toThrow(/401/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting retries", async () => {
    mockFetchOnceError(429);
    mockFetchOnceError(429);
    mockFetchOnceError(429);
    const judge = new CerebrasJudge({ maxRetries: 2 });
    await expect(judge.judge("test prompt")).rejects.toThrow(/429/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("sets response_format when jsonObjectMode is true", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"score":0.5,"reason":"x"}' } }],
        }),
        { status: 200 },
      ),
    );
    const judge = new CerebrasJudge();
    await judge.judge("test prompt", { jsonObjectMode: true });
    const callArgs = fetchSpy.mock.calls[0];
    expect(callArgs).toBeDefined();
    const initArg = callArgs?.[1];
    const body = JSON.parse(
      typeof initArg?.body === "string" ? initArg.body : "{}",
    );
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("omits response_format by default", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"score":0.5}' } }],
        }),
        { status: 200 },
      ),
    );
    const judge = new CerebrasJudge();
    await judge.judge("test prompt");
    const initArg = fetchSpy.mock.calls[0]?.[1];
    const body = JSON.parse(
      typeof initArg?.body === "string" ? initArg.body : "{}",
    );
    expect(body.response_format).toBeUndefined();
  });

  it("includes systemPrompt when provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"score":1}' } }],
        }),
        { status: 200 },
      ),
    );
    const judge = new CerebrasJudge();
    await judge.judge("user prompt", { systemPrompt: "be strict" });
    const initArg = fetchSpy.mock.calls[0]?.[1];
    const body = JSON.parse(
      typeof initArg?.body === "string" ? initArg.body : "{}",
    );
    expect(body.messages).toEqual([
      { role: "system", content: "be strict" },
      { role: "user", content: "user prompt" },
    ]);
  });

  it("isAvailable reflects env", () => {
    process.env.CEREBRAS_API_KEY = "x";
    expect(CerebrasJudge.isAvailable()).toBe(true);
    delete process.env.CEREBRAS_API_KEY;
    expect(CerebrasJudge.isAvailable()).toBe(false);
  });
});
