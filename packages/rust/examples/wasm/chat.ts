#!/usr/bin/env bun
/**
 * Interactive Chat Example
 *
 * Demonstrates an interactive chat session with the WASM runtime.
 * Uses readline for user input.
 *
 * Run with:
 *   bun run examples/wasm/chat.ts
 *
 * Type messages to chat with the agent. Type 'exit' to quit.
 */

import * as readline from "readline";
import {
  WasmAgentRuntime,
  JsModelHandler,
  generateUUID,
} from "../../pkg-node/elizaos.js";

// Simple echo-based "AI" for demonstration
// In a real app, you'd call an actual LLM API here
async function generateResponse(
  character: { name: string; system?: string },
  userMessage: string
): Promise<string> {
  // Simulate thinking time
  await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300));

  const greetings = ["hello", "hi", "hey", "greetings"];
  const farewells = ["bye", "goodbye", "exit", "quit"];

  const lower = userMessage.toLowerCase();

  if (greetings.some((g) => lower.includes(g))) {
    return `Hello! I'm ${character.name}. How can I help you today?`;
  }

  if (farewells.some((f) => lower.includes(f))) {
    return "Goodbye! It was nice chatting with you.";
  }

  if (lower.includes("name")) {
    return `My name is ${character.name}. Nice to meet you!`;
  }

  if (lower.includes("help")) {
    return "I'm here to help! You can ask me questions, and I'll do my best to assist. Type 'exit' when you're done.";
  }

  // Generic responses
  const responses = [
    `That's an interesting point about "${userMessage.slice(0, 30)}..."`,
    "I understand. Could you tell me more about that?",
    "That's a great question! Let me think about it...",
    "I appreciate you sharing that with me.",
    "Hmm, that's something worth considering.",
  ];

  return responses[Math.floor(Math.random() * responses.length)];
}

async function main() {
  console.log("=== elizaOS Interactive Chat ===\n");

  // Create character
  const character = {
    name: "ChatBot",
    bio: "A friendly conversational AI assistant.",
    system:
      "You are a helpful, friendly assistant. Engage naturally in conversation.",
  };

  // Create and initialize runtime
  console.log("Starting up...");
  const runtime = WasmAgentRuntime.create(JSON.stringify(character));
  await runtime.initialize();

  // Register model handler
  const handler = new JsModelHandler({
    handle: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson);
      const prompt = params.prompt || "";

      // Extract user message from prompt (format: "User: message\nCharacter:")
      const userMatch = prompt.match(/User:\s*(.+?)(?:\n|$)/);
      const userMessage = userMatch ? userMatch[1].trim() : prompt;

      const response = await generateResponse(character, userMessage);
      return JSON.stringify({ text: response });
    },
  });
  runtime.registerModelHandler("TEXT_LARGE", handler);

  console.log(`\n${character.name} is ready to chat!`);
  console.log('Type your messages below. Type "exit" to quit.\n');

  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const roomId = generateUUID();
  const entityId = generateUUID();

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const text = input.trim();

      if (!text) {
        prompt();
        return;
      }

      if (text.toLowerCase() === "exit") {
        console.log(`\n${character.name}: Goodbye! 👋`);
        runtime.stop();
        rl.close();
        return;
      }

      try {
        const message = {
          entityId,
          roomId,
          content: { text },
        };

        const responseJson = await runtime.handleMessage(JSON.stringify(message));
        const response = JSON.parse(responseJson);

        if (response.didRespond && response.responseContent?.text) {
          console.log(`${character.name}: ${response.responseContent.text}\n`);
        }
      } catch (error) {
        console.error(`Error: ${error}\n`);
      }

      prompt();
    });
  };

  prompt();
}

main().catch(console.error);

