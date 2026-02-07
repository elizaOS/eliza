import type { IAgentRuntime, TestSuite, Plugin } from "@elizaos/core";
import { strict as assert } from "node:assert";
import { setupScenario, sendMessageAndWaitForResponse } from "./test-utils.ts";
import { EnvManagerService } from "../service.ts";

/**
 * Mock plugin interface for testing - extends Plugin with declaredEnvVars
 */
interface MockPluginWithEnvVars extends Partial<Plugin> {
  name: string;
  declaredEnvVars: Record<
    string,
    {
      type: string;
      required: boolean;
      description: string;
      canGenerate: boolean;
      validationMethod?: string;
      value?: string;
      status?: string;
    }
  >;
}

/**
 * E2E test suite for environment variable management scenarios
 */
export const envScenariosSuite: TestSuite = {
  name: "Environment Variable Management Scenarios",
  tests: [
    {
      name: "Scenario 1: Agent proactively asks for missing environment variables",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Ensure we have missing env vars by declaring some
        const mockPlugin: MockPluginWithEnvVars = {
          name: "test-plugin",
          declaredEnvVars: {
            TEST_API_KEY: {
              type: "api_key",
              required: true,
              description: "API key for test service",
              canGenerate: false,
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);

        // Initialize the service to scan for requirements
        const envService = runtime.getService(
          "ENV_MANAGER",
        ) as EnvManagerService;
        await envService.scanPluginRequirements();

        // Send a message that might trigger env var check
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Hi! Can you help me get started?",
        );

        console.log("Agent Response:", response.text);

        // Agent should mention missing environment variables
        assert.match(
          response.text || "",
          /environment variable|API key|TEST_API_KEY|missing|configure/i,
          "Agent should mention missing environment variables",
        );
      },
    },

    {
      name: "Scenario 2: User provides environment variable unprompted",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Set up a plugin with missing env var
        const mockPlugin: MockPluginWithEnvVars = {
          name: "openai",
          declaredEnvVars: {
            OPENAI_API_KEY: {
              type: "api_key",
              required: true,
              description: "OpenAI API key for GPT models",
              canGenerate: false,
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);

        const envService = runtime.getService(
          "ENV_MANAGER",
        ) as EnvManagerService;
        await envService.scanPluginRequirements();

        // User provides API key without being asked
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Here's my OpenAI key: sk-test1234567890abcdef",
        );

        console.log("Agent Response:", response.text);

        // Check that the action was called
        assert(
          response.actions?.includes("ENV_VAR_UPDATED") ||
            response.actions?.includes("ENV_VAR_UPDATE_FAILED"),
          "Agent should process the environment variable",
        );

        // Verify the variable was set in runtime
        const savedValue = runtime.getSetting("ENV_OPENAI_API_KEY");
        assert(
          savedValue,
          "Environment variable should be saved in runtime settings",
        );
      },
    },

    {
      name: "Scenario 3: Multi-turn conversation for multiple variables",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Set up multiple missing env vars
        const mockPlugin: MockPluginWithEnvVars = {
          name: "multi-service",
          declaredEnvVars: {
            SERVICE_API_KEY: {
              type: "api_key",
              required: true,
              description: "Primary service API key",
              canGenerate: false,
            },
            SERVICE_SECRET: {
              type: "secret",
              required: true,
              description: "Service secret for authentication",
              canGenerate: true,
            },
            SERVICE_URL: {
              type: "url",
              required: true,
              description: "Service endpoint URL",
              canGenerate: false,
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);

        const envService = runtime.getService(
          "ENV_MANAGER",
        ) as EnvManagerService;
        await envService.scanPluginRequirements();

        // First turn: Ask about env vars
        const response1 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "What environment variables do I need to set up?",
        );

        console.log("Turn 1 - Agent Response:", response1.text);

        assert.match(
          response1.text || "",
          /SERVICE_API_KEY|SERVICE_SECRET|SERVICE_URL/i,
          "Agent should list the required environment variables",
        );

        // Second turn: Set one variable
        const response2 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "SERVICE_API_KEY=test-key-123",
        );

        console.log("Turn 2 - Agent Response:", response2.text);

        assert(
          response2.actions?.includes("ENV_VAR_UPDATED"),
          "Agent should update the environment variable",
        );

        // Third turn: Ask about remaining
        const response3 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "What else do I need to configure?",
        );

        console.log("Turn 3 - Agent Response:", response3.text);

        assert.match(
          response3.text || "",
          /SERVICE_URL|still need|remaining/i,
          "Agent should mention remaining variables",
        );

        // Fourth turn: Generate the secret
        const response4 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Can you generate the SERVICE_SECRET for me?",
        );

        console.log("Turn 4 - Agent Response:", response4.text);

        assert(
          response4.actions?.includes("GENERATE_ENV_VAR_SUCCESS") ||
            response4.actions?.includes("GENERATE_ENV_VAR_PARTIAL"),
          "Agent should attempt to generate the secret",
        );
      },
    },

    {
      name: "Scenario 4: Invalid value handling and validation",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Set up plugin with validation
        const mockPlugin: MockPluginWithEnvVars = {
          name: "validated-service",
          declaredEnvVars: {
            VALIDATED_API_KEY: {
              type: "api_key",
              required: true,
              description: "API key that requires validation",
              canGenerate: false,
              validationMethod: "api_key:test",
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);

        const envService = runtime.getService(
          "ENV_MANAGER",
        ) as EnvManagerService;
        await envService.scanPluginRequirements();

        // Provide an invalid API key
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "My API key is: invalid-key-format",
        );

        console.log("Agent Response:", response.text);

        // Should mention validation failure
        assert.match(
          response.text || "",
          /validation|invalid|failed|error|correct format/i,
          "Agent should mention validation failure",
        );

        // Verify the variable status
        const envVars = await envService.getAllEnvVars();
        const varConfig = envVars?.["validated-service"]?.VALIDATED_API_KEY;
        assert.equal(
          varConfig?.status,
          "invalid",
          "Variable should be marked as invalid",
        );
      },
    },

    {
      name: "Scenario 5: False positive prevention - unrelated messages",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Set up a plugin
        const mockPlugin: MockPluginWithEnvVars = {
          name: "chat-service",
          declaredEnvVars: {
            CHAT_API_KEY: {
              type: "api_key",
              required: true,
              description: "Chat service API key",
              canGenerate: false,
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);

        const envService = runtime.getService(
          "ENV_MANAGER",
        ) as EnvManagerService;
        await envService.scanPluginRequirements();

        // Send messages that shouldn't trigger env var setting
        const testMessages = [
          "My favorite key on the keyboard is the space bar",
          "The secret to success is hard work",
          "I set my alarm for 7 AM every day",
          "Configure your mindset for success",
          "The API for human interaction is complex",
        ];

        for (const msg of testMessages) {
          const response = await sendMessageAndWaitForResponse(
            runtime,
            room,
            user,
            msg,
          );

          console.log(`Message: "${msg}"`);
          console.log("Agent Response:", response.text);

          // Should NOT trigger env var actions
          assert(
            !response.actions?.includes("ENV_VAR_UPDATED") &&
              !response.actions?.includes("SET_ENV_VAR"),
            `Message "${msg}" should not trigger environment variable actions`,
          );
        }
      },
    },

    {
      name: "Scenario 6: Duplicate value prevention",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Set up plugin
        const mockPlugin: MockPluginWithEnvVars = {
          name: "dup-test",
          declaredEnvVars: {
            DUP_TEST_KEY: {
              type: "api_key",
              required: true,
              description: "Test key for duplicate prevention",
              canGenerate: false,
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);

        const envService = runtime.getService(
          "ENV_MANAGER",
        ) as EnvManagerService;
        await envService.scanPluginRequirements();

        // First: Set the variable
        const response1 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Set DUP_TEST_KEY to test-value-123",
        );

        console.log("First attempt:", response1.text);
        assert(
          response1.actions?.includes("ENV_VAR_UPDATED"),
          "First update should succeed",
        );

        // Second: Try to set the same value again
        const response2 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "DUP_TEST_KEY=test-value-123",
        );

        console.log("Second attempt:", response2.text);

        // Should either skip or acknowledge it's already set
        const envVars = await envService.getAllEnvVars();
        const config = envVars?.["dup-test"]?.DUP_TEST_KEY;
        assert.equal(
          config?.attempts,
          1,
          "Should not increment attempts for duplicate",
        );
      },
    },

    {
      name: "Scenario 7: Auto-generation of supported variables",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Set up plugin with generatable vars
        const mockPlugin: MockPluginWithEnvVars = {
          name: "crypto-service",
          declaredEnvVars: {
            JWT_SECRET: {
              type: "secret",
              required: true,
              description: "JWT signing secret",
              canGenerate: true,
            },
            SESSION_SECRET: {
              type: "secret",
              required: true,
              description: "Session encryption secret",
              canGenerate: true,
            },
            PRIVATE_KEY: {
              type: "private_key",
              required: true,
              description: "RSA private key for signing",
              canGenerate: true,
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);

        const envService = runtime.getService(
          "ENV_MANAGER",
        ) as EnvManagerService;
        await envService.scanPluginRequirements();

        // Ask to generate all
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Please generate all the secrets and keys I need automatically",
        );

        console.log("Agent Response:", response.text);

        // Should trigger generation
        assert(
          response.actions?.includes("GENERATE_ENV_VAR_SUCCESS") ||
            response.actions?.includes("GENERATE_ENV_VAR_PARTIAL"),
          "Agent should attempt to generate variables",
        );

        // Verify at least some were generated
        const envVars = await envService.getAllEnvVars();
        const generatedCount = Object.values(
          envVars?.["crypto-service"] || {},
        ).filter((config) => config.status === "valid").length;

        assert(
          generatedCount > 0,
          "At least some variables should be generated",
        );
      },
    },

    {
      name: "Scenario 8: Mixed manual and auto-generated variables",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Set up plugin with mixed vars
        const mockPlugin: MockPluginWithEnvVars = {
          name: "mixed-service",
          declaredEnvVars: {
            API_KEY: {
              type: "api_key",
              required: true,
              description: "External API key",
              canGenerate: false,
            },
            CLIENT_SECRET: {
              type: "secret",
              required: true,
              description: "Client secret",
              canGenerate: true,
            },
            WEBHOOK_URL: {
              type: "url",
              required: true,
              description: "Webhook endpoint",
              canGenerate: false,
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);

        const envService = runtime.getService(
          "ENV_MANAGER",
        ) as EnvManagerService;
        await envService.scanPluginRequirements();

        // First: Set manual vars
        const response1 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "API_KEY is sk-12345 and WEBHOOK_URL is https://example.com/webhook",
        );

        console.log("Manual vars response:", response1.text);

        // Then: Generate the rest
        const response2 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Can you generate the remaining variables?",
        );

        console.log("Generation response:", response2.text);

        // Verify all are set
        const envVars = await envService.getAllEnvVars();
        const allValid = Object.values(envVars?.["mixed-service"] || {}).every(
          (config) => config.status === "valid",
        );

        assert(
          allValid,
          "All variables should be valid after manual + auto generation",
        );
      },
    },

    {
      name: "Scenario 9: Environment status check",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Set up mixed status
        const mockPlugin: MockPluginWithEnvVars = {
          name: "status-test",
          declaredEnvVars: {
            VALID_KEY: {
              type: "api_key",
              required: true,
              description: "Already set key",
              canGenerate: false,
              value: "preset-value",
              status: "valid",
            },
            MISSING_KEY: {
              type: "api_key",
              required: true,
              description: "Missing key",
              canGenerate: false,
            },
            OPTIONAL_KEY: {
              type: "config",
              required: false,
              description: "Optional configuration",
              canGenerate: false,
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);

        const envService = runtime.getService(
          "ENV_MANAGER",
        ) as EnvManagerService;
        await envService.scanPluginRequirements();

        // Ask for status
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Show me the status of all environment variables",
        );

        console.log("Status response:", response.text);

        // Should show status without revealing values
        assert.match(
          response.text || "",
          /VALID_KEY.*valid|✅/i,
          "Should show valid status",
        );
        assert.match(
          response.text || "",
          /MISSING_KEY.*missing|❌/i,
          "Should show missing status",
        );
        assert.doesNotMatch(
          response.text || "",
          /preset-value/,
          "Should NOT show actual values",
        );
      },
    },

    {
      name: "Scenario 10: Complex multi-plugin setup",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Set up multiple plugins
        const plugins: MockPluginWithEnvVars[] = [
          {
            name: "openai",
            declaredEnvVars: {
              OPENAI_API_KEY: {
                type: "api_key",
                required: true,
                description: "OpenAI API key",
                canGenerate: false,
              },
            },
          },
          {
            name: "database",
            declaredEnvVars: {
              DATABASE_URL: {
                type: "url",
                required: true,
                description: "Database connection string",
                canGenerate: false,
              },
              DB_POOL_SIZE: {
                type: "config",
                required: false,
                description: "Database pool size",
                canGenerate: false,
              },
            },
          },
          {
            name: "auth",
            declaredEnvVars: {
              JWT_SECRET: {
                type: "secret",
                required: true,
                description: "JWT signing secret",
                canGenerate: true,
              },
              SESSION_SECRET: {
                type: "secret",
                required: true,
                description: "Session secret",
                canGenerate: true,
              },
            },
          },
        ];

        plugins.forEach((p) => runtime.plugins.push(p as Plugin));

        const envService = runtime.getService(
          "ENV_MANAGER",
        ) as EnvManagerService;
        await envService.scanPluginRequirements();

        // Complex setup message
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "I want to set up everything. OPENAI_API_KEY=sk-test123, DATABASE_URL=postgres://localhost/test. Please generate all the secrets automatically.",
        );

        console.log("Complex setup response:", response.text);

        // Should handle both manual and auto generation
        const envVars = await envService.getAllEnvVars();

        // Check manual vars were set
        assert.equal(
          envVars?.["openai"]?.OPENAI_API_KEY?.status,
          "valid",
          "OpenAI key should be set",
        );
        assert.equal(
          envVars?.["database"]?.DATABASE_URL?.status,
          "valid",
          "Database URL should be set",
        );

        // Check some secrets were generated
        const authVars = envVars?.["auth"];
        const generatedSecrets = Object.values(authVars || {}).filter(
          (config) => config.status === "valid",
        ).length;

        assert(generatedSecrets > 0, "Some secrets should be auto-generated");
      },
    },
  ],
};

export default envScenariosSuite;
