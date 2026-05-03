#!/usr/bin/env tsx
/**
 * Run the Visual Assistant with camera, screen, and microphone enabled
 * This demonstrates the full integration of vision, autonomy, and audio
 */

import { spawn } from "node:child_process";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  console.log("🤖 Starting Visual Assistant with full sensory capabilities...");
  console.log("📷 Camera: Enabled");
  console.log("🖥️  Screen: Enabled");
  console.log("🎤 Microphone: Enabled (30-second transcription)");
  console.log("🧠 Autonomy: Enabled\n");

  // Path to the visual assistant character
  const characterPath = path.join(
    __dirname,
    "../characters/visual-assistant.json",
  );

  // Environment variables for the demo
  const env = {
    ...process.env,
    VISION_MODE: "BOTH",
    ENABLE_FACE_RECOGNITION: "true",
    ENABLE_OBJECT_DETECTION: "true",
    ENABLE_POSE_DETECTION: "true",
    ENABLE_MICROPHONE: "true",
    TRANSCRIPTION_INTERVAL: "30000",
    AUTONOMOUS_ENABLED: "true",
    AUTONOMOUS_INTERVAL: "10000",
  };

  // Run the agent using elizaos CLI
  const agent = spawn("elizaos", ["start", "--character", characterPath], {
    env,
    stdio: "inherit",
    shell: true,
  });

  agent.on("error", (error) => {
    console.error("❌ Failed to start agent:", error);
    process.exit(1);
  });

  agent.on("exit", (code) => {
    console.log(`Agent exited with code ${code}`);
    process.exit(code || 0);
  });
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down Visual Assistant...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n👋 Shutting down Visual Assistant...");
  process.exit(0);
});

// Run the assistant
main().catch((error) => {
  console.error("❌ Failed to start Visual Assistant:", error);
  process.exit(1);
});
