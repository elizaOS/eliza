#!/usr/bin/env bun
/**
 * Interactive WASM Chat Example
 *
 * Run with:
 *   bun run examples/wasm/chat.ts
 */

import * as elizaos from "../../pkg-node/elizaos.js";
import { createInterface } from "node:readline";

async function main() {
  console.log("=== elizaOS Interactive Chat ===\n");

  const runtime = elizaos.WasmAgentRuntime.create(
    JSON.stringify({
      name: "ChatBot",
      bio: "A friendly chat bot running in WASM",
      system: "Be friendly and concise.",
    })
  );
  await runtime.initialize();

  const handler = new elizaos.JsModelHandler({
    handle: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson) as { prompt?: string };
      const prompt = params.prompt ?? "";
      const lastLine = prompt.split("\n").slice(-1)[0] ?? "";
      return `You said: ${lastLine}`;
    },
  });

  runtime.registerModelHandler("TEXT_LARGE", handler);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (question: string) =>
    new Promise<string>((resolve) => rl.question(question, resolve));

  while (true) {
    const input = (await ask("You: ")).trim();
    if (input.toLowerCase() === "exit") {
      break;
    }

    const messageJson = JSON.stringify({
      entityId: elizaos.generateUUID(),
      roomId: elizaos.generateUUID(),
      content: { text: input },
    });

    const responseJson = await runtime.handleMessage(messageJson);
    const response = JSON.parse(responseJson) as {
      responseContent: { text?: string };
    };

    console.log(`ChatBot: ${response.responseContent.text ?? ""}`);
  }

  rl.close();
}

main().catch((err) => {
  console.error("Chat failed:", err);
  process.exit(1);
});
