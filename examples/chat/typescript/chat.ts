import * as readline from "node:readline";
import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  type Character,
  createMessageMemory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { openaiPlugin } from "@elizaos/plugin-openai";
import sqlPlugin from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";

const character: Character = createCharacter({
  name: "Eliza",
  bio: "A helpful AI assistant.",
});

console.log("🚀 Starting Eliza...\n");

// Create runtime
const runtime = new AgentRuntime({
  character,
  plugins: [sqlPlugin, openaiPlugin],
});
await runtime.initialize();

// Setup connection
const userId = uuidv4() as UUID;
const roomId = stringToUuid("chat-room");
const worldId = stringToUuid("chat-world");

await runtime.ensureConnection({
  entityId: userId,
  roomId,
  worldId,
  userName: "User",
  source: "cli",
  channelId: "chat",
  type: ChannelType.DM,
});

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log("💬 Chat with Eliza (type 'exit' to quit)\n");

const prompt = () => {
  rl.question("You: ", async (input) => {
    const text = input.trim();

    if (text.toLowerCase() === "exit") {
      console.log("\n👋 Goodbye!");
      rl.close();
      await runtime.stop();
      process.exit(0);
    }

    if (!text) {
      prompt();
      return;
    }

    // Create and send message
    const message = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: userId,
      roomId,
      content: {
        text,
        source: "client_chat",
        channelType: ChannelType.DM,
      },
    });

    let _response = "";
    process.stdout.write("Eliza: ");

    await runtime?.messageService?.handleMessage(
      runtime,
      message,
      async (content) => {
        if (content?.text) {
          _response += content.text;
          process.stdout.write(content.text);
        }
        return [];
      },
    );

    console.log("\n");
    prompt();
  });
};

prompt();
