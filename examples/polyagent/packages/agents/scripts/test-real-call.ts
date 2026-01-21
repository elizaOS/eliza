#!/usr/bin/env bun
/**
 * Test real LLM call
 *
 * Run with: bun packages/agents/scripts/test-real-call.ts
 */

import { callAgentLLM, getAgentLLMStatus } from "../src/llm/agent-llm";

async function main() {
  console.log("=".repeat(60));
  console.log("REAL LLM CALL TEST");
  console.log("=".repeat(60));
  console.log("");

  // Check status first
  const status = await getAgentLLMStatus();
  console.log(`Provider: ${status.provider}`);
  console.log(`Available: ${status.available}`);
  console.log("");

  if (!status.available) {
    console.log("❌ No LLM provider available");
    process.exit(1);
  }

  // Make a real call
  console.log("Making real LLM call...");
  const startTime = Date.now();

  try {
    const response = await callAgentLLM({
      prompt:
        'You are testing the Polyagent trading agent LLM. Respond with exactly: "LLM call successful"',
      system: "You are a test agent. Follow instructions exactly.",
      temperature: 0.1,
      maxTokens: 50,
      purpose: "action",
    });

    const latency = Date.now() - startTime;

    console.log("");
    console.log("✅ LLM CALL SUCCEEDED");
    console.log(`   Latency: ${latency}ms`);
    console.log(`   Response length: ${response.length} chars`);
    console.log(
      `   Response: "${response.substring(0, 100)}${response.length > 100 ? "..." : ""}"`,
    );
    console.log("");

    // Validate response
    if (response.toLowerCase().includes("successful") || response.length > 0) {
      console.log("✅ Response validation passed");
    } else {
      console.log("⚠️ Unexpected response format");
    }
  } catch (error) {
    console.log("");
    console.log("❌ LLM CALL FAILED");
    console.log(
      `   Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  console.log("");
  console.log("=".repeat(60));
  console.log("TEST COMPLETE");
  console.log("=".repeat(60));

  process.exit(0);
}

main().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
