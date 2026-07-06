/**
 * Cache-key and round-trip tests. Confirms the query hash is canonical (stable
 * under question key/whitespace reordering) so semantically identical asks share
 * an entry, and that a corrupt cache file degrades to a miss rather than
 * crashing the run.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheFilePath, queryHash, readCache, writeCache } from "./cache.ts";
import type { AskResult, VisionQuestion } from "./types.ts";

const QUESTIONS: VisionQuestion[] = [
  { id: "q1", question: "What does the button say?" },
  { id: "q2", question: "Is it orange?", expected: "yes" },
];

const RESULT: AskResult = {
  answers: [
    { id: "q1", answer: "Send", confidence: 1, details: "label" },
    { id: "q2", answer: "yes", confidence: 0.9, details: "accent" },
  ],
  provenance: {
    backend: "anthropic",
    model: "claude-opus-4-8",
    usage: { inputTokens: 1000, outputTokens: 20 },
    latencyMs: 500,
    retries: 0,
    timestamp: "2026-01-01T00:00:00.000Z",
    cached: false,
    dimensions: {
      originalWidth: 100,
      originalHeight: 50,
      sentWidth: 100,
      sentHeight: 50,
    },
  },
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-qa-cache-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("queryHash", () => {
  it("is a 64-char hex digest", () => {
    expect(queryHash("m", "anthropic", QUESTIONS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the model changes", () => {
    expect(queryHash("m1", "anthropic", QUESTIONS)).not.toBe(
      queryHash("m2", "anthropic", QUESTIONS),
    );
  });

  it("changes when a question changes", () => {
    const altered: VisionQuestion[] = [
      QUESTIONS[0],
      { ...QUESTIONS[1], question: "changed" },
    ];
    expect(queryHash("m", "anthropic", QUESTIONS)).not.toBe(
      queryHash("m", "anthropic", altered),
    );
  });

  it("changes when the sent image dimensions change", () => {
    const original = RESULT.provenance.dimensions;
    const smaller = { ...original, sentWidth: 50, sentHeight: 25 };
    expect(queryHash("m", "anthropic", QUESTIONS, original)).not.toBe(
      queryHash("m", "anthropic", QUESTIONS, smaller),
    );
  });

  it("is stable across object key ordering (canonical)", () => {
    const reordered: VisionQuestion[] = QUESTIONS.map(
      (q) =>
        ({
          expected: q.expected,
          question: q.question,
          id: q.id,
        }) as VisionQuestion,
    );
    expect(queryHash("m", "anthropic", reordered)).toBe(
      queryHash("m", "anthropic", QUESTIONS),
    );
  });
});

describe("cache round-trip", () => {
  it("returns null on a miss", () => {
    const q = queryHash("m", "anthropic", QUESTIONS);
    expect(readCache(dir, "a".repeat(64), q)).toBeNull();
  });

  it("writes then reads the same result", () => {
    const imgSha = "b".repeat(64);
    const q = queryHash("m", "anthropic", QUESTIONS);
    writeCache(dir, imgSha, q, RESULT);
    expect(fs.existsSync(cacheFilePath(dir, imgSha, q))).toBe(true);
    const hit = readCache(dir, imgSha, q);
    expect(hit).toEqual(RESULT);
  });

  it("degrades a corrupt cache file to a miss", () => {
    const imgSha = "c".repeat(64);
    const q = queryHash("m", "anthropic", QUESTIONS);
    const file = cacheFilePath(dir, imgSha, q);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ this is not json", "utf8");
    expect(readCache(dir, imgSha, q)).toBeNull();
  });
});
