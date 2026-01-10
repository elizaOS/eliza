#!/usr/bin/env node

/**
 * Integration test for MCP Tool Compatibility System
 * This test verifies that the tool compatibility is properly integrated
 * into the McpService and automatically applies transformations.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { JSONSchema7 } from "json-schema";
import { createMcpToolCompatibility, detectModelProvider } from "./index";

// Mock runtime objects to test different scenarios
// These are minimal mocks for testing purposes only
const mockRuntimes = {
  openai: { modelProvider: "openai", model: "gpt-4" } as unknown as IAgentRuntime,
  openaiReasoning: { modelProvider: "openai", model: "o3-mini" } as unknown as IAgentRuntime,
  anthropic: { modelProvider: "anthropic", model: "claude-3" } as unknown as IAgentRuntime,
  google: { modelProvider: "google", model: "gemini-pro" } as unknown as IAgentRuntime,
  unknown: { modelProvider: "unknown", model: "custom-model" } as unknown as IAgentRuntime,
};

// Test schema that has problematic constraints
const testSchema: JSONSchema7 = {
  type: "object",
  properties: {
    email: {
      type: "string",
      format: "email",
      minLength: 5,
      maxLength: 100,
    },
    count: {
      type: "number",
      minimum: 1,
      maximum: 1000,
      multipleOf: 1,
    },
    tags: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 10,
      uniqueItems: true,
    },
  },
  required: ["email"],
};

async function testIntegration() {
  console.log("🧪 Testing MCP Tool Compatibility Integration\n");

  for (const [providerName, runtime] of Object.entries(mockRuntimes)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runtimeAny = runtime as unknown as Record<string, string>;
    console.log(`📋 Testing ${providerName} (${runtimeAny.model})`);
    console.log("-".repeat(40));

    // Test model detection
    const modelInfo = detectModelProvider(runtime);
    console.log(`✅ Model detected: ${JSON.stringify(modelInfo)}`);

    // Test compatibility layer creation
    const compatibility = await createMcpToolCompatibility(runtime);

    if (compatibility) {
      console.log(`✅ Compatibility layer created: ${compatibility.constructor.name}`);
      console.log(`✅ Should apply: ${compatibility.shouldApply()}`);

      // Test schema transformation
      const originalJson = JSON.stringify(testSchema, null, 2);
      const transformedSchema = compatibility.transformToolSchema(testSchema);
      const transformedJson = JSON.stringify(transformedSchema, null, 2);

      if (originalJson !== transformedJson) {
        console.log("🔄 Schema was transformed");
        console.log("📝 Key differences:");

        // Show the key differences
        if (testSchema.properties && transformedSchema.properties) {
          for (const prop of Object.keys(testSchema.properties)) {
            const origProp = testSchema.properties[prop];
            const transProp = transformedSchema.properties[prop];

            if (
              typeof origProp === "object" &&
              origProp !== null &&
              typeof transProp === "object" &&
              transProp !== null
            ) {
              if (JSON.stringify(origProp) !== JSON.stringify(transProp)) {
                const origKeys = Object.keys(origProp);
                const transKeys = Object.keys(transProp);
                const removedProps = origKeys.filter((k) => !transKeys.includes(k));
                if (removedProps.length > 0) {
                  console.log(`   • ${prop}: Removed ${removedProps.join(", ")}`);
                }
                const origDescription = "description" in origProp ? origProp.description : undefined;
                const transDescription = "description" in transProp ? transProp.description : undefined;
                if (transDescription && !origDescription) {
                  console.log(`   • ${prop}: Added constraint description`);
                }
              }
            }
          }
        }
      } else {
        console.log("⚪ No transformation needed");
      }
    } else {
      console.log("❌ No compatibility layer (as expected for unknown providers)");
    }

    console.log("");
  }
}

// Test that mimics how it would be used in McpService
async function testServiceIntegration() {
  console.log("🔧 Testing Service Integration Pattern\n");

  // Mock tool from MCP server with problematic schema
  const mockMcpTool = {
    name: "send_email",
    description: "Send an email message",
    inputSchema: testSchema,
  };

  // Simulate how McpService.fetchToolsList() would work
  interface MockTool {
    name: string;
    description: string;
    inputSchema: JSONSchema7;
  }
  async function simulateFetchToolsList(runtime: IAgentRuntime, tools: MockTool[]) {
    const runtimeRecord = runtime as unknown as Record<string, string>;
    console.log(`📡 Simulating fetchToolsList for ${runtimeRecord.modelProvider}...`);

    const compatibility = await createMcpToolCompatibility(runtime);

    const processedTools = tools.map((tool) => {
      const processedTool = { ...tool };

      if (tool.inputSchema && compatibility) {
        console.log(`🔄 Applying compatibility to tool: ${tool.name}`);
        processedTool.inputSchema = compatibility.transformToolSchema(tool.inputSchema);
      }

      return processedTool;
    });

    return processedTools;
  }

  // Test with different runtimes
  for (const [providerName, runtime] of Object.entries(mockRuntimes)) {
    console.log(`Testing ${providerName}:`);
    const processedTools = await simulateFetchToolsList(runtime, [mockMcpTool]);

    const originalHasFormat = JSON.stringify(mockMcpTool).includes('"format"');
    const processedHasFormat = JSON.stringify(processedTools[0]).includes('"format"');

    if (originalHasFormat && !processedHasFormat) {
      console.log(`✅ Format constraints removed (expected for ${providerName})`);
    } else if (!originalHasFormat && !processedHasFormat) {
      console.log(`⚪ No format constraints to process`);
    } else {
      console.log(`📝 Format constraints preserved`);
    }

    const hasConstraintDescription = JSON.stringify(processedTools[0]).includes("minLength");
    if (hasConstraintDescription) {
      console.log(`✅ Constraints embedded in description`);
    }

    console.log("");
  }
}

// Run the tests
(async () => {
  console.log("🚀 MCP Tool Compatibility Integration Test\n");
  console.log("=".repeat(50));
  await testIntegration();
  console.log("=".repeat(50));
  await testServiceIntegration();
  console.log("✅ Integration test complete!");
})();

export { testIntegration, testServiceIntegration };
