/**
 * Token Statistics Integration Test
 *
 * This test makes REAL API calls to verify token counting works correctly.
 * It will spend actual API credits.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FeedLLMClient } from "../llm/openai-client";
import { tokenStatsService } from "../services/token-stats-service";

// Skip if no API key is available
const hasApiKey = Boolean(
  process.env.GROQ_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY,
);

describe.skipIf(!hasApiKey)("Token Stats Integration - Real API Calls", () => {
  beforeEach(() => {
    tokenStatsService.clearAll();
  });

  afterEach(() => {
    tokenStatsService.clearAll();
  });

  test("tracks tokens from a real LLM call", async () => {
    // Start token collection
    const tickId = tokenStatsService.startTick("integration-test-1");
    expect(tickId).toBe("integration-test-1");

    // Create LLM client
    const llm = FeedLLMClient.forGameTick();

    // Make a simple API call
    const result = await llm.generateJSON<{ message: string }>(
      'Return a JSON object with a "message" field containing "Hello World".',
      {
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
      {
        temperature: 0,
        maxTokens: 100,
        promptType: "integration-test-hello",
      },
    );

    // Verify the LLM call worked
    expect(result).toBeDefined();
    console.log("LLM Response:", JSON.stringify(result, null, 2));
    // Response may have message at root or nested - just verify we got something
    expect(Object.keys(result).length).toBeGreaterThan(0);

    // End collection and get stats
    const stats = tokenStatsService.endTick();

    // Verify stats were collected
    expect(stats).not.toBeNull();
    console.log("\n=== Token Stats ===");
    console.log("Tick ID:", stats?.tickId);
    console.log("Total Calls:", stats?.totalCalls);
    console.log("Total Input Tokens:", stats?.totalInputTokens);
    console.log("Total Output Tokens:", stats?.totalOutputTokens);
    console.log("Total Tokens:", stats?.totalTokens);
    console.log("Duration (ms):", stats?.tickDurationMs);

    // Verify we got token counts
    expect(stats?.totalCalls).toBe(1);
    expect(stats?.totalInputTokens).toBeGreaterThan(0);
    expect(stats?.totalOutputTokens).toBeGreaterThan(0);
    expect(stats?.totalTokens).toBeGreaterThan(0);

    // Verify by prompt type
    expect(stats?.byPromptType).toHaveLength(1);
    const promptStats = stats?.byPromptType[0];
    expect(promptStats?.promptType).toBe("integration-test-hello");
    expect(promptStats?.callCount).toBe(1);
    console.log("\n=== By Prompt Type ===");
    console.log(JSON.stringify(promptStats, null, 2));

    // Verify by model
    expect(stats?.byModel).toHaveLength(1);
    const modelStats = stats?.byModel[0];
    console.log("\n=== By Model ===");
    console.log(JSON.stringify(modelStats, null, 2));
    expect(modelStats?.callCount).toBe(1);
    expect(modelStats?.totalInputTokens).toBeGreaterThan(0);
  }, 30000); // 30 second timeout for API call

  test("tracks multiple LLM calls with different prompt types", async () => {
    tokenStatsService.startTick("integration-test-2");

    const llm = FeedLLMClient.forGameTick();

    // Call 1: Simple greeting
    await llm.generateJSON<{ greeting: string }>(
      'Return JSON with a "greeting" field saying "Hi".',
      { properties: { greeting: { type: "string" } }, required: ["greeting"] },
      { temperature: 0, maxTokens: 50, promptType: "test-greeting" },
    );

    // Call 2: Simple math
    await llm.generateJSON<{ result: number }>(
      'Return JSON with "result" field containing 42.',
      { properties: { result: { type: "number" } }, required: ["result"] },
      { temperature: 0, maxTokens: 50, promptType: "test-math" },
    );

    // Call 3: Another greeting (same prompt type as call 1)
    await llm.generateJSON<{ greeting: string }>(
      'Return JSON with a "greeting" field saying "Bye".',
      { properties: { greeting: { type: "string" } }, required: ["greeting"] },
      { temperature: 0, maxTokens: 50, promptType: "test-greeting" },
    );

    const stats = tokenStatsService.endTick();

    console.log("\n=== Multiple Calls Stats ===");
    console.log("Total Calls:", stats?.totalCalls);
    console.log("Total Tokens:", stats?.totalTokens);

    expect(stats?.totalCalls).toBe(3);

    // Should have 2 prompt types
    expect(stats?.byPromptType).toHaveLength(2);

    const greetingStats = stats?.byPromptType.find(
      (p) => p.promptType === "test-greeting",
    );
    const mathStats = stats?.byPromptType.find(
      (p) => p.promptType === "test-math",
    );

    expect(greetingStats?.callCount).toBe(2);
    expect(mathStats?.callCount).toBe(1);

    console.log("\n=== By Prompt Type ===");
    console.log("test-greeting:", JSON.stringify(greetingStats, null, 2));
    console.log("test-math:", JSON.stringify(mathStats, null, 2));
  }, 60000); // 60 second timeout

  test("validates token counts are reasonable", async () => {
    tokenStatsService.startTick("integration-test-3");

    const llm = FeedLLMClient.forGameTick();

    // Short prompt, short response
    const shortPrompt = 'Return {"ok":true}';
    await llm.generateJSON<{ ok: boolean }>(
      shortPrompt,
      { properties: { ok: { type: "boolean" } }, required: ["ok"] },
      { temperature: 0, maxTokens: 20, promptType: "short" },
    );

    // Longer prompt
    const longPrompt = `You are an assistant. Please return a JSON object with the following fields:
- "name": a random first name
- "age": a random age between 18 and 65
- "city": a random city name
- "occupation": a random job title
Be creative but keep responses short.`;

    await llm.generateJSON<{
      name: string;
      age: number;
      city: string;
      occupation: string;
    }>(
      longPrompt,
      {
        properties: {
          name: { type: "string" },
          age: { type: "number" },
          city: { type: "string" },
          occupation: { type: "string" },
        },
        required: ["name", "age", "city", "occupation"],
      },
      { temperature: 0.5, maxTokens: 100, promptType: "long" },
    );

    const stats = tokenStatsService.endTick();

    const shortStats = stats?.byPromptType.find(
      (p) => p.promptType === "short",
    );
    const longStats = stats?.byPromptType.find((p) => p.promptType === "long");

    console.log("\n=== Token Count Validation ===");
    console.log("Short prompt input tokens:", shortStats?.totalInputTokens);
    console.log("Long prompt input tokens:", longStats?.totalInputTokens);

    // Long prompt should use more input tokens
    expect(longStats?.totalInputTokens).toBeGreaterThan(
      shortStats?.totalInputTokens ?? 0,
    );

    // Both should have reasonable token counts (not 0, not millions)
    expect(shortStats?.totalInputTokens).toBeGreaterThan(10);
    expect(shortStats?.totalInputTokens).toBeLessThan(1000);
    expect(longStats?.totalInputTokens).toBeGreaterThan(50);
    expect(longStats?.totalInputTokens).toBeLessThan(2000);

    console.log("\nToken counts are within expected ranges ✓");
  }, 60000);

  test("summary includes cost estimates", async () => {
    // Run two ticks
    tokenStatsService.startTick("cost-test-1");
    const llm = FeedLLMClient.forGameTick();
    await llm.generateJSON<{ x: number }>(
      'Return {"x":1}',
      { properties: { x: { type: "number" } }, required: ["x"] },
      { temperature: 0, maxTokens: 20, promptType: "cost-test" },
    );
    tokenStatsService.endTick();

    tokenStatsService.startTick("cost-test-2");
    await llm.generateJSON<{ y: number }>(
      'Return {"y":2}',
      { properties: { y: { type: "number" } }, required: ["y"] },
      { temperature: 0, maxTokens: 20, promptType: "cost-test" },
    );
    tokenStatsService.endTick();

    // Get summary
    const summary = tokenStatsService.getSummary(10);

    console.log("\n=== Cost Summary ===");
    console.log("Tick Count:", summary?.tickCount);
    console.log("Total Calls:", summary?.totalCalls);
    console.log("Total Tokens:", summary?.totalTokens);
    console.log(
      "Estimated Input Cost (USD):",
      summary?.estimatedInputCostUSD?.toFixed(6),
    );
    console.log(
      "Estimated Output Cost (USD):",
      summary?.estimatedOutputCostUSD?.toFixed(6),
    );
    console.log(
      "Estimated Total Cost (USD):",
      summary?.estimatedTotalCostUSD?.toFixed(6),
    );

    expect(summary?.tickCount).toBe(2);
    expect(summary?.totalCalls).toBe(2);
    expect(summary?.estimatedTotalCostUSD).toBeGreaterThan(0);
    // Cost should be tiny for these small calls (< $0.01)
    expect(summary?.estimatedTotalCostUSD).toBeLessThan(0.01);
  }, 60000);
});
