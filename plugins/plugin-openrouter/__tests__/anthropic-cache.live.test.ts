/**
 * Proves Anthropic cache controls through the real OpenRouter transport.
 * The guarded suite records redacted cache-write/read usage for exact-head review.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  buildLiveHarness,
  type LiveAgentHarness,
} from "../../../packages/app-core/test/helpers/live-agent-test";
import { handleTextLarge } from "../models/text";

const hasApiKey = Boolean(process.env.OPENROUTER_API_KEY?.trim());
const model = "anthropic/claude-sonnet-4";
const runNonce = `${process.env.GITHUB_SHA?.slice(0, 12) ?? "local"}-${randomUUID().slice(0, 8)}`;
const stableSegment = [
  "This deterministic reference block exists to cross Anthropic's minimum cacheable prefix size.",
  ...Array.from({ length: 1_400 }, (_, index) => `amber-reference-fact-${index}.`),
].join(" ");
const dynamicSegment = '\nReturn only a JSON object with the boolean field "ok" set to true.';
const prompt = stableSegment + dynamicSegment;
const stableSegmentSha256 = createHash("sha256").update(stableSegment).digest("hex");

interface CacheUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface NativeResult {
  text: string;
  finishReason?: string;
  usage: CacheUsage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNativeResult(value: unknown): NativeResult {
  if (!isRecord(value) || typeof value.text !== "string" || !isRecord(value.usage)) {
    throw new Error("OpenRouter cache proof requires a native text result with usage");
  }

  const promptTokens = readNumber(value.usage, "promptTokens");
  const completionTokens = readNumber(value.usage, "completionTokens");
  const totalTokens = readNumber(value.usage, "totalTokens");
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
    throw new Error("OpenRouter cache proof received incomplete token usage");
  }

  const cacheReadInputTokens = readNumber(value.usage, "cacheReadInputTokens");
  const cacheCreationInputTokens = readNumber(value.usage, "cacheCreationInputTokens");
  return {
    text: value.text,
    ...(typeof value.finishReason === "string" ? { finishReason: value.finishReason } : {}),
    usage: {
      promptTokens,
      completionTokens,
      totalTokens,
      ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
      ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    },
  };
}

function appendEvidence(record: Record<string, unknown>): void {
  const target = process.env.ELIZA_LIVE_TEST_LLM_CALLS_JSONL;
  if (!target) return;
  mkdirSync(dirname(target), { recursive: true });
  appendFileSync(target, `${JSON.stringify(record)}\n`, "utf8");
}

function cacheParams() {
  return {
    prompt,
    promptSegments: [
      { content: stableSegment, stable: true },
      { content: dynamicSegment, stable: false },
    ],
    maxOutputTokens: 32,
    responseSchema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
    providerOptions: {
      openrouter: { promptCacheKey: `eliza-15966-${runNonce}` },
      anthropic: {
        cacheSystem: false,
        maxBreakpoints: 1,
        cacheBreakpoints: [
          {
            segmentIndex: 0,
            cacheControl: { type: "ephemeral", ttl: "1h" },
          },
        ],
      },
    },
  } as const;
}

describe.skipIf(!hasApiKey)("OpenRouter Anthropic prompt caching (live)", () => {
  let harness: LiveAgentHarness;

  beforeAll(async () => {
    harness = await buildLiveHarness({
      provider: "openrouter",
      requiredEnv: ["OPENROUTER_API_KEY"],
    });
    harness.runtime.setSetting("OPENROUTER_LARGE_MODEL", model);
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  });

  test("creates then reads a one-hour user-prefix cache entry", async () => {
    const first = readNativeResult(await handleTextLarge(harness.runtime, cacheParams()));
    expect(first.text.length).toBeGreaterThan(0);
    expect(first.usage.promptTokens).toBeGreaterThan(1_024);
    expect(first.usage.cacheCreationInputTokens).toBeGreaterThan(0);

    appendEvidence({
      type: "llm_call",
      timestamp: new Date().toISOString(),
      provider: "openrouter",
      model,
      scenario: "anthropic-cache-write-1h",
      request: {
        cacheControl: { type: "ephemeral", ttl: "1h" },
        stableSegmentCharacters: stableSegment.length,
        stableSegmentSha256,
      },
      response: { finishReason: first.finishReason, textCharacters: first.text.length },
      usage: first.usage,
    });

    const second = readNativeResult(await handleTextLarge(harness.runtime, cacheParams()));
    expect(second.text.length).toBeGreaterThan(0);
    expect(second.usage.cacheReadInputTokens).toBeGreaterThan(0);

    appendEvidence({
      type: "llm_call",
      timestamp: new Date().toISOString(),
      provider: "openrouter",
      model,
      scenario: "anthropic-cache-read-1h",
      request: {
        cacheControl: { type: "ephemeral", ttl: "1h" },
        stableSegmentCharacters: stableSegment.length,
        stableSegmentSha256,
      },
      response: { finishReason: second.finishReason, textCharacters: second.text.length },
      usage: second.usage,
    });
  }, 180_000);

  test("rejects an unsupported TTL as a typed boundary error", async () => {
    let observed: unknown;
    try {
      await handleTextLarge(harness.runtime, {
        ...cacheParams(),
        providerOptions: {
          anthropic: {
            cacheSystem: false,
            maxBreakpoints: 1,
            cacheBreakpoints: [
              {
                segmentIndex: 0,
                cacheControl: { type: "ephemeral", ttl: "2h" },
              },
            ],
          },
        },
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toMatchObject({
      name: "ElizaError",
      code: "OPENROUTER_INVALID_CACHE_BREAKPOINT",
      message: expect.stringMatching(/ttl/),
    });
    const errorRecord = isRecord(observed) ? observed : {};
    appendEvidence({
      type: "validation",
      timestamp: new Date().toISOString(),
      provider: "openrouter",
      model,
      scenario: "anthropic-invalid-cache-ttl",
      error: {
        name: errorRecord.name,
        code: errorRecord.code,
        message: errorRecord.message,
      },
    });
  });
});
