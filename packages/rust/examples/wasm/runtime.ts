#!/usr/bin/env bun
/**
 * WASM Runtime Example
 *
 * Demonstrates using the full WasmAgentRuntime with model handlers.
 *
 * Run with:
 *   bun run examples/wasm/runtime.ts
 */

import {
  WasmAgentRuntime,
  JsModelHandler,
  generateUUID,
} from "../../pkg-node/elizaos.js";

// Mock LLM response generator
function mockLLMResponse(prompt: string): string {
  const responses = [
    "I understand your question. Let me help you with that.",
    "That's an interesting point! Here's what I think...",
    "Based on my knowledge, I can tell you that...",
    "Great question! The answer involves several aspects...",
  ];
  return responses[Math.floor(Math.random() * responses.length)];
}

async function main() {
  console.log("=== elizaOS WASM Runtime Example ===\n");

  // Create character configuration
  const character = {
    name: "RuntimeAgent",
    bio: [
      "A sophisticated AI agent running in WASM.",
      "Capable of natural language understanding.",
      "Powered by the elizaOS runtime.",
    ],
    system:
      "You are a helpful assistant. Be concise, friendly, and informative.",
    topics: ["technology", "science", "philosophy"],
    adjectives: ["intelligent", "helpful", "curious"],
    style: {
      all: ["Be clear and concise", "Use examples when helpful"],
      chat: ["Engage naturally", "Ask clarifying questions"],
    },
  };

  // Create runtime
  console.log("Creating runtime...");
  const runtime = WasmAgentRuntime.create(JSON.stringify(character));
  console.log(`Agent ID: ${runtime.agentId}`);
  console.log(`Character: ${runtime.characterName}`);
  console.log(`Initialized: ${runtime.isInitialized}`);

  // Initialize the runtime
  console.log("\nInitializing runtime...");
  await runtime.initialize();
  console.log(`Initialized: ${runtime.isInitialized}`);

  // Create a model handler
  console.log("\nRegistering model handler...");
  const modelHandler = new JsModelHandler({
    handle: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson);
      console.log(`  [Model] Received prompt: "${params.prompt?.slice(0, 50)}..."`);

      // Simulate async LLM call
      await new Promise((resolve) => setTimeout(resolve, 100));

      const response = mockLLMResponse(params.prompt || "");
      return JSON.stringify({ text: response });
    },
  });

  runtime.registerModelHandler("TEXT_LARGE", modelHandler);
  console.log("Model handler registered for TEXT_LARGE");

  // Send some messages
  console.log("\n--- Message Processing ---");

  const messages = [
    "Hello! How are you today?",
    "Can you explain how WASM works?",
    "What's the meaning of life?",
  ];

  for (const text of messages) {
    console.log(`\nUser: ${text}`);

    const message = {
      entityId: generateUUID(),
      roomId: generateUUID(),
      content: { text },
    };

    try {
      const responseJson = await runtime.handleMessage(JSON.stringify(message));
      const response = JSON.parse(responseJson);

      if (response.didRespond) {
        console.log(`Agent: ${response.responseContent?.text || "(no text)"}`);
      } else {
        console.log("Agent: (no response)");
      }
    } catch (error) {
      console.error(`Error: ${error}`);
    }
  }

  // Clean up
  console.log("\n--- Cleanup ---");
  runtime.stop();
  console.log(`Initialized after stop: ${runtime.isInitialized}`);

  console.log("\n=== Example Complete ===");
}

main().catch(console.error);

