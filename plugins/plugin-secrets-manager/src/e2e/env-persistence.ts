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
      type?: string;
      required: boolean;
      description?: string;
      canGenerate: boolean;
      validationMethod?: string;
    }
  >;
}

/**
 * Mock service that uses environment variables
 */
class MockApiService {
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  async makeApiCall(): Promise<string> {
    const apiKey = this.runtime.getSetting("ENV_MOCK_API_KEY") as string;
    if (!apiKey) {
      throw new Error("MOCK_API_KEY not configured");
    }
    return `API call successful with key: ${apiKey.substring(0, 5)}...`;
  }

  async getDatabaseUrl(): Promise<string> {
    const dbUrl = this.runtime.getSetting("ENV_DATABASE_URL") as string;
    if (!dbUrl) {
      throw new Error("DATABASE_URL not configured");
    }
    return dbUrl;
  }
}

/**
 * E2E test suite for environment variable persistence
 */
export const envPersistenceSuite: TestSuite = {
  name: "Environment Variable Persistence Tests",
  tests: [
    {
      name: "Test 1: Variables persist in runtime settings",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Set up a plugin
        const mockPlugin: MockPluginWithEnvVars = {
          name: "persist-test",
          declaredEnvVars: {
            PERSIST_TEST_KEY: {
              type: "api_key",
              required: true,
              description: "Test key for persistence",
              canGenerate: false,
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);

        const envService = runtime.getService(
          "ENV_MANAGER",
        ) as EnvManagerService;
        await envService.scanPluginRequirements();

        // Set a variable
        const response = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Set PERSIST_TEST_KEY to persist-value-123",
        );

        console.log("Set response:", response.text);

        // Verify it's in runtime settings
        const value = runtime.getSetting("ENV_PERSIST_TEST_KEY");
        assert.equal(
          value,
          "persist-value-123",
          "Value should be in runtime settings",
        );

        // Verify it's in character secrets
        const secrets = runtime.character.settings?.secrets;
        assert(
          secrets?.["ENV_PERSIST_TEST_KEY"],
          "Value should be in character secrets",
        );
        assert.equal(
          secrets?.["ENV_PERSIST_TEST_KEY"],
          "persist-value-123",
          "Value in secrets should match",
        );
      },
    },

    {
      name: "Test 2: Variables available after service restart",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Set up plugin and set variables
        const mockPlugin: MockPluginWithEnvVars = {
          name: "restart-test",
          declaredEnvVars: {
            RESTART_API_KEY: {
              type: "api_key",
              required: true,
              description: "API key for restart test",
              canGenerate: false,
            },
            RESTART_SECRET: {
              type: "secret",
              required: true,
              description: "Secret for restart test",
              canGenerate: true,
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);

        let envService = runtime.getService("ENV_MANAGER") as EnvManagerService;
        await envService.scanPluginRequirements();

        // Set manual variable
        await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "RESTART_API_KEY=restart-key-456",
        );

        // Generate secret
        await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Generate RESTART_SECRET",
        );

        // Verify both are set
        const apiKey1 = runtime.getSetting("ENV_RESTART_API_KEY");
        const secret1 = runtime.getSetting("ENV_RESTART_SECRET");
        assert(apiKey1, "API key should be set");
        assert(secret1, "Secret should be generated");

        // Simulate service restart
        await envService.stop();

        // Reinitialize the same service (simulating restart)
        await envService.initialize();

        // Verify variables are still available
        const apiKey2 = runtime.getSetting("ENV_RESTART_API_KEY");
        const secret2 = runtime.getSetting("ENV_RESTART_SECRET");

        assert.equal(apiKey2, apiKey1, "API key should persist after restart");
        assert.equal(secret2, secret1, "Secret should persist after restart");

        // Verify metadata was restored
        const envVars = await envService.getAllEnvVars();
        assert(
          envVars?.["restart-test"]?.RESTART_API_KEY,
          "API key metadata should be restored",
        );
        assert(
          envVars?.["restart-test"]?.RESTART_SECRET,
          "Secret metadata should be restored",
        );
        assert.equal(
          envVars?.["restart-test"]?.RESTART_API_KEY?.status,
          "valid",
          "API key status should be valid",
        );
      },
    },

    {
      name: "Test 3: Variables available in other services",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Set up plugin
        const mockPlugin: MockPluginWithEnvVars = {
          name: "service-test",
          declaredEnvVars: {
            MOCK_API_KEY: {
              type: "api_key",
              required: true,
              description: "Mock API key",
              canGenerate: false,
            },
            DATABASE_URL: {
              type: "url",
              required: true,
              description: "Database connection URL",
              canGenerate: false,
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);

        const envService = runtime.getService(
          "ENV_MANAGER",
        ) as EnvManagerService;
        await envService.scanPluginRequirements();

        // Set environment variables
        await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "MOCK_API_KEY=mock-key-789 and DATABASE_URL=postgres://localhost/testdb",
        );

        // Create a mock service that uses the env vars
        const mockApiService = new MockApiService(runtime);

        // Test that the service can access the variables
        const apiResult = await mockApiService.makeApiCall();
        assert.match(
          apiResult,
          /API call successful/,
          "Service should be able to use API key",
        );

        const dbUrl = await mockApiService.getDatabaseUrl();
        assert.equal(
          dbUrl,
          "postgres://localhost/testdb",
          "Service should be able to access database URL",
        );
      },
    },

    {
      name: "Test 4: Character secrets integration",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Pre-populate some secrets in character
        if (!runtime.character.settings) {
          runtime.character.settings = {};
        }
        if (!runtime.character.settings.secrets) {
          runtime.character.settings.secrets = {};
        }
        runtime.character.settings.secrets.EXISTING_SECRET =
          "pre-existing-value";

        // Set up plugin that uses the existing secret
        const mockPlugin: MockPluginWithEnvVars = {
          name: "character",
          declaredEnvVars: {
            EXISTING_SECRET: {
              type: "secret",
              required: true,
              description: "Pre-existing character secret",
              canGenerate: false,
            },
            NEW_SECRET: {
              type: "secret",
              required: true,
              description: "New secret to add",
              canGenerate: true,
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);

        const envService = runtime.getService(
          "ENV_MANAGER",
        ) as EnvManagerService;
        await envService.initialize(); // Re-initialize to load existing secrets

        // Check status - existing should be valid
        const response1 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "What's the status of my environment variables?",
        );

        console.log("Status response:", response1.text);

        assert.match(
          response1.text || "",
          /EXISTING_SECRET.*valid|✅/i,
          "Existing secret should be valid",
        );

        // Generate new secret
        const response2 = await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Generate NEW_SECRET",
        );

        console.log("Generation response:", response2.text);

        // Verify both are in character secrets
        const secrets = runtime.character.settings.secrets;
        assert(
          secrets.ENV_EXISTING_SECRET,
          "Existing secret should be preserved",
        );
        assert(secrets.ENV_NEW_SECRET, "New secret should be added");
        assert(secrets.__env_metadata, "Metadata should be saved");
      },
    },

    {
      name: "Test 5: Persistence across multiple operations",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Complex plugin setup
        const plugins: MockPluginWithEnvVars[] = [
          {
            name: "api-service",
            declaredEnvVars: {
              API_KEY_1: {
                type: "api_key",
                required: true,
                canGenerate: false,
              },
              API_KEY_2: {
                type: "api_key",
                required: true,
                canGenerate: false,
              },
            },
          },
          {
            name: "crypto-service",
            declaredEnvVars: {
              SIGNING_KEY: {
                type: "private_key",
                required: true,
                canGenerate: true,
              },
              ENCRYPTION_KEY: {
                type: "secret",
                required: true,
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

        // Operation 1: Set manual keys
        await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "API_KEY_1=key1-value and API_KEY_2=key2-value",
        );

        // Operation 2: Generate crypto keys
        await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "Generate all the crypto keys",
        );

        // Operation 3: Check everything persisted
        const allVars = [
          "API_KEY_1",
          "API_KEY_2",
          "SIGNING_KEY",
          "ENCRYPTION_KEY",
        ];
        for (const varName of allVars) {
          const value = runtime.getSetting(`ENV_${varName}`);
          assert(value, `${varName} should be persisted`);
        }

        // Operation 4: Verify metadata integrity
        const envVars = await envService.getAllEnvVars();
        assert.equal(
          Object.keys(envVars || {}).length,
          2,
          "Should have 2 plugins",
        );

        const apiVars = envVars?.["api-service"];
        const cryptoVars = envVars?.["crypto-service"];

        assert(
          apiVars?.API_KEY_1?.status === "valid",
          "API_KEY_1 should be valid",
        );
        assert(
          apiVars?.API_KEY_2?.status === "valid",
          "API_KEY_2 should be valid",
        );
        assert(
          cryptoVars?.SIGNING_KEY?.status === "valid",
          "SIGNING_KEY should be valid",
        );
        assert(
          cryptoVars?.ENCRYPTION_KEY?.status === "valid",
          "ENCRYPTION_KEY should be valid",
        );
      },
    },

    {
      name: "Test 6: Metadata persistence and recovery",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Set up plugin with various metadata
        const mockPlugin: MockPluginWithEnvVars = {
          name: "metadata-test",
          declaredEnvVars: {
            META_VAR_1: {
              type: "api_key",
              required: true,
              description: "First metadata test variable",
              canGenerate: false,
              validationMethod: "api_key:custom",
            },
            META_VAR_2: {
              type: "secret",
              required: false,
              description: "Optional metadata test variable",
              canGenerate: true,
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);

        let envService = runtime.getService("ENV_MANAGER") as EnvManagerService;
        await envService.scanPluginRequirements();

        // Set variable with validation failure
        await sendMessageAndWaitForResponse(
          runtime,
          room,
          user,
          "META_VAR_1=invalid-format",
        );

        // Get current metadata
        const envVars1 = await envService.getAllEnvVars();
        const var1Config = envVars1?.["metadata-test"]?.META_VAR_1;

        assert.equal(var1Config?.status, "invalid", "Should be marked invalid");
        assert(var1Config?.lastError, "Should have error message");
        assert(var1Config?.attempts > 0, "Should have attempt count");

        // Restart service
        await envService.stop();

        // Reinitialize the same service (simulating restart)
        await envService.initialize();

        // Verify metadata was restored correctly
        const envVars2 = await envService.getAllEnvVars();
        const var2Config = envVars2?.["metadata-test"]?.META_VAR_1;

        assert.equal(
          var2Config?.status,
          var1Config?.status,
          "Status should persist",
        );
        assert.equal(
          var2Config?.lastError,
          var1Config?.lastError,
          "Error should persist",
        );
        assert.equal(
          var2Config?.attempts,
          var1Config?.attempts,
          "Attempts should persist",
        );
        assert.equal(
          var2Config?.validationMethod,
          "api_key:custom",
          "Validation method should persist",
        );
      },
    },

    {
      name: "Test 7: Empty state initialization",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Ensure clean state
        if (runtime.character.settings?.secrets) {
          delete runtime.character.settings.secrets.__env_metadata;
          // Remove any ENV_ keys
          Object.keys(runtime.character.settings.secrets).forEach((key) => {
            if (key.startsWith("ENV_")) {
              delete runtime.character.settings.secrets![key];
            }
          });
        }

        // Start service - should handle empty state gracefully
        const envService = runtime.getService(
          "ENV_MANAGER",
        ) as EnvManagerService;
        await envService.initialize();

        // Should have empty env vars
        const envVars = await envService.getAllEnvVars();
        assert(envVars, "Should return empty object, not null");

        // Add a plugin and scan
        const mockPlugin: MockPluginWithEnvVars = {
          name: "empty-state-test",
          declaredEnvVars: {
            EMPTY_TEST_VAR: {
              type: "config",
              required: true,
              description: "Test variable",
              canGenerate: false,
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);
        await envService.scanPluginRequirements();

        // Should now have the variable
        const updatedVars = await envService.getAllEnvVars();
        assert(
          updatedVars?.["empty-state-test"]?.EMPTY_TEST_VAR,
          "Should have scanned and added the variable",
        );
      },
    },

    {
      name: "Test 8: Concurrent access and updates",
      fn: async (runtime: IAgentRuntime) => {
        const { user, room } = await setupScenario(runtime);

        // Set up plugin
        const mockPlugin: MockPluginWithEnvVars = {
          name: "concurrent-test",
          declaredEnvVars: {
            CONCURRENT_VAR_1: {
              type: "config",
              required: true,
              canGenerate: false,
            },
            CONCURRENT_VAR_2: {
              type: "config",
              required: true,
              canGenerate: false,
            },
            CONCURRENT_VAR_3: {
              type: "config",
              required: true,
              canGenerate: false,
            },
          },
        };
        runtime.plugins.push(mockPlugin as Plugin);

        const envService = runtime.getService(
          "ENV_MANAGER",
        ) as EnvManagerService;
        await envService.scanPluginRequirements();

        // Simulate concurrent updates
        const updates = [
          envService.updateEnvVar("concurrent-test", "CONCURRENT_VAR_1", {
            value: "value1",
            status: "valid",
          }),
          envService.updateEnvVar("concurrent-test", "CONCURRENT_VAR_2", {
            value: "value2",
            status: "valid",
          }),
          envService.updateEnvVar("concurrent-test", "CONCURRENT_VAR_3", {
            value: "value3",
            status: "valid",
          }),
        ];

        const results = await Promise.all(updates);

        // All should succeed
        assert(
          results.every((r) => r === true),
          "All concurrent updates should succeed",
        );

        // Verify all values are set correctly
        assert.equal(runtime.getSetting("ENV_CONCURRENT_VAR_1"), "value1");
        assert.equal(runtime.getSetting("ENV_CONCURRENT_VAR_2"), "value2");
        assert.equal(runtime.getSetting("ENV_CONCURRENT_VAR_3"), "value3");

        // Verify metadata integrity
        const envVars = await envService.getAllEnvVars();
        const concurrentVars = envVars?.["concurrent-test"];
        assert.equal(
          Object.keys(concurrentVars || {}).length,
          3,
          "Should have all 3 variables",
        );
      },
    },
  ],
};

export default envPersistenceSuite;
