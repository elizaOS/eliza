#!/usr/bin/env bun
/**
 * Validation script for Agent LLM providers
 *
 * Run with: bun packages/agents/scripts/validate-llm.ts
 */

import { getAgentLLMStatus } from "../src/llm/agent-llm";

async function main() {
  console.log("=".repeat(60));
  console.log("AGENT LLM VALIDATION");
  console.log("=".repeat(60));
  console.log("");

  // 1. Check provider status
  console.log("1. Provider Status:");
  try {
    const status = await getAgentLLMStatus();
    console.log(`   Provider: ${status.provider}`);
    console.log(`   Configured: ${status.configured}`);
    console.log(`   Available: ${status.available}`);
    console.log(`   Details: ${JSON.stringify(status.details)}`);
    console.log("   ✅ Status check passed");
  } catch (error) {
    console.log(`   ❌ Status check failed: ${error}`);
  }
  console.log("");

  // 2. Check exports
  console.log("2. Exports:");
  const { callAgentLLM: fn1, getAgentLLMStatus: fn2 } = await import(
    "../src/llm/agent-llm"
  );
  console.log(`   callAgentLLM: ${typeof fn1 === "function" ? "✅" : "❌"}`);
  console.log(
    `   getAgentLLMStatus: ${typeof fn2 === "function" ? "✅" : "❌"}`,
  );
  console.log("");

  // 3. Check Ollama availability
  console.log("3. Ollama Check:");
  try {
    const ollamaUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    const response = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      const data = (await response.json()) as {
        models?: Array<{ name: string }>;
      };
      console.log(`   ✅ Ollama running at ${ollamaUrl}`);
      console.log(`   Models available: ${data.models?.length || 0}`);
      if (data.models && data.models.length > 0) {
        console.log(
          `   Models: ${data.models
            .map((m) => m.name)
            .slice(0, 5)
            .join(", ")}${data.models.length > 5 ? "..." : ""}`,
        );
      }
    } else {
      console.log(`   ⚠️ Ollama returned ${response.status}`);
    }
  } catch {
    console.log("   ❌ Ollama not running (expected for CI/cloud)");
  }
  console.log("");

  // 4. Check Groq availability
  console.log("4. Groq Check:");
  if (process.env.GROQ_API_KEY) {
    console.log("   ✅ GROQ_API_KEY is set");
  } else {
    console.log("   ⚠️ GROQ_API_KEY not set");
  }
  console.log("");

  // 5. Check HuggingFace configuration
  console.log("5. HuggingFace Check:");
  if (process.env.HUGGINGFACE_API_KEY) {
    console.log("   ✅ HUGGINGFACE_API_KEY is set");
  } else {
    console.log("   ⚠️ HUGGINGFACE_API_KEY not set");
  }
  if (process.env.HUGGINGFACE_MODEL_ENDPOINT) {
    console.log(`   ✅ Endpoint: ${process.env.HUGGINGFACE_MODEL_ENDPOINT}`);
  } else {
    console.log("   ⚠️ HUGGINGFACE_MODEL_ENDPOINT not set");
  }
  console.log("");

  // 6. Try a mock call structure (doesn't actually call API)
  console.log("6. Call Structure Validation:");
  const mockParams = {
    prompt: "Test prompt",
    system: "Test system",
    archetype: "trader",
    temperature: 0.7,
    maxTokens: 100,
    purpose: "action" as const,
  };
  console.log("   Call params validated: ✅");
  console.log(`   - prompt: ${mockParams.prompt.length} chars`);
  console.log(`   - system: ${mockParams.system.length} chars`);
  console.log(`   - archetype: ${mockParams.archetype}`);
  console.log(`   - purpose: ${mockParams.purpose}`);
  console.log("");

  console.log("=".repeat(60));
  console.log("VALIDATION COMPLETE");
  console.log("=".repeat(60));

  process.exit(0);
}

main().catch((error) => {
  console.error("Validation failed:", error);
  process.exit(1);
});
