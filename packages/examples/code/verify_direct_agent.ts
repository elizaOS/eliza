import fs from "node:fs";
import path from "node:path";
import { createMessageMemory } from "@elizaos/core";
import dotenv from "dotenv";
import { v4 } from "uuid";
import { initializeAgent } from "./src/lib/agent.js";

// Load environment variables from eliza/.env
dotenv.config({ path: "../../eliza/.env" });

async function main() {
  console.log("🚀 Starting Direct Agent Verification...");

  // 1. Initialize Agent
  const runtime = await initializeAgent();
  console.log("✅ Agent Runtime Initialized");

  // 2. Define test task
  const roomId = v4();
  const userId = v4();
  const testFileName = "verification_test.txt";
  const testContent = "Hello from Direct Code Agent Verification!";
  const prompt = `Create a file named "${testFileName}" with the content "${testContent}". Do it directly.`;

  console.log(`📝 Sending Prompt: "${prompt}"`);

  // 3. Send Message
  const memory = createMessageMemory({
    id: v4(),
    roomId: roomId,
    agentId: runtime.agentId,
    content: {
      text: prompt,
      source: "verification_script",
    },
    userId: userId,
  });

  await runtime.messageService.handleMessage(runtime, memory);

  // 4. Verification
  // Wait a bit for execution (though handleMessage should await action completion in direct mode)
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const filePath = path.join(process.cwd(), testFileName);
  console.log(`🔍 Checking for file at: ${filePath}`);

  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    if (content.trim() === testContent) {
      console.log("✅ SUCCESS: File created with correct content.");

      // Cleanup
      fs.unlinkSync(filePath);
      console.log("🧹 Cleanup: Test file deleted.");
      process.exit(0);
    } else {
      console.error(
        `❌ FAILURE: File content mismatch.\nExpected: "${testContent}"\nActual: "${content}"`,
      );
      process.exit(1);
    }
  } else {
    console.error("❌ FAILURE: Test file was not created.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ FATAL ERROR:", err);
  process.exit(1);
});
