#!/usr/bin/env node
// @ts-nocheck
import { VisionService } from "../../service";
import visionAutonomyE2ETests from "./vision-autonomy";
import visionBasicE2ETests from "./vision-basic";

// Simple test runner for local e2e testing
async function runE2ETests() {
  console.log("🧪 Running Vision Plugin E2E Tests Locally...\n");

  // Create agent ID first
  const agentId = `agent-${Date.now()}`;

  // Create a minimal runtime with vision service
  const runtime = {
    agentId,
    getSetting: (key: string) => {
      const settings: Record<string, string> = {
        CAMERA_NAME: "test",
        PIXEL_CHANGE_THRESHOLD: "50",
      };
      return settings[key] || null;
    },
    getService: (name: string) => {
      if (name === "VISION") {
        return visionService;
      }
      return null;
    },
    createMemory: async () => {},
    getMemories: async () => [],
    composeState: async () => ({
      values: {
        visionAvailable: visionService?.isActive() || false,
        cameraStatus: visionService?.isActive() ? "connected" : "not connected",
        sceneDescription: "Test scene",
      },
      data: {},
      text: "Visual Perception: Available",
    }),
    useModel: async (type: string, _params: unknown) => {
      if (type === "IMAGE_DESCRIPTION") {
        return { description: "A test scene with various objects" };
      }
      return "Test response";
    },
  } as Partial<IAgentRuntime>;

  const visionService = await VisionService.start(runtime);
  runtime.services = new Map([["VISION", visionService]]);

  const testSuites = [visionBasicE2ETests, visionAutonomyE2ETests];

  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;

  for (const suite of testSuites) {
    console.log(`\n📦 Running suite: ${suite.name}`);
    console.log(`   ${suite.description}\n`);

    for (const test of suite.tests) {
      totalTests++;
      process.stdout.write(`   🔄 ${test.name}... `);

      try {
        await test.fn(runtime);
        passedTests++;
        console.log("✅ PASSED");
      } catch (error) {
        failedTests++;
        console.log("❌ FAILED");
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        console.error(`      Error: ${errorMessage}`);
        if (errorStack) {
          console.error(`      Stack: ${errorStack.split("\n").slice(1, 3).join("\n")}`);
        }
      }
    }
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("📊 Test Summary:");
  console.log(`   Total:  ${totalTests} tests`);
  console.log(`   ✅ Passed: ${passedTests} tests`);
  console.log(`   ❌ Failed: ${failedTests} tests`);
  console.log(`${"=".repeat(60)}\n`);

  // Cleanup
  await visionService.stop();

  process.exit(failedTests > 0 ? 1 : 0);
}

// Run tests
runE2ETests().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
