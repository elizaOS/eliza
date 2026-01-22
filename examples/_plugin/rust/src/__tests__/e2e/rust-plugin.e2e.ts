import type {
  Content,
  HandlerCallback,
  IAgentRuntime,
  State,
  TestSuite,
} from "@elizaos/core";

/**
 * E2E (End-to-End) Test Suite for Rust Plugin Starter
 * ====================================================
 *
 * This file contains end-to-end tests that run within a real elizaOS runtime environment.
 * These tests validate that the Rust plugin (loaded via WASM) works correctly with the agent.
 */

// Define minimal interfaces for the types we need
type UUID = `${string}-${string}-${string}-${string}-${string}`;

interface Memory {
  entityId: UUID;
  roomId: UUID;
  content: {
    text: string;
    source: string;
    actions?: string[];
  };
}


export const RustPluginTestSuite: TestSuite = {
  name: "rust_plugin_starter_test_suite",
  tests: [
    /**
     * Basic Plugin Verification Test
     * ------------------------------
     * Verifies that the Rust plugin is properly loaded and initialized
     * within the runtime environment.
     */
    {
      name: "rust_plugin_loaded_test",
      fn: async (runtime: IAgentRuntime) => {
        // Verify the plugin is loaded by checking for the HELLO_RUST action
        const runtimeActions = runtime.actions;
        const actionExists = runtimeActions?.some(
          (a) => a.name === "HELLO_RUST",
        );
        if (!actionExists) {
          throw new Error(
            "HELLO_RUST action not found in runtime actions - Rust plugin may not be loaded",
          );
        }
      },
    },

    /**
     * Action Registration Test
     * ------------------------
     * Verifies that the HELLO_RUST action is properly registered with the runtime.
     */
    {
      name: "should_have_hello_rust_action",
      fn: async (runtime: IAgentRuntime) => {
        const runtimeActions = runtime.actions;
        const helloRustAction = runtimeActions?.find(
          (a) => a.name === "HELLO_RUST",
        );
        if (!helloRustAction) {
          throw new Error("HELLO_RUST action not found in runtime actions");
        }

        // Verify action has required properties
        if (!helloRustAction.description) {
          throw new Error("HELLO_RUST action missing description");
        }
        if (!helloRustAction.handler) {
          throw new Error("HELLO_RUST action missing handler");
        }
      },
    },

    /**
     * Hello Rust Action Response Test
     * --------------------------------
     * This is the KEY test: Simulates asking the agent to say hello
     * and validates that the HELLO_RUST action is called and responds correctly.
     *
     * This test verifies:
     * 1. The agent can respond to a message
     * 2. The HELLO_RUST action is triggered
     * 3. The action returns the expected response from Rust
     */
    {
      name: "hello_rust_action_test",
      fn: async (runtime: IAgentRuntime) => {
        // Create a test message asking the agent to say hello
        const testMessage: Memory = {
          entityId: "12345678-1234-1234-1234-123456789012" as UUID,
          roomId: "12345678-1234-1234-1234-123456789012" as UUID,
          content: {
            text: "Can you say hello from Rust?",
            source: "test",
            actions: ["HELLO_RUST"], // Specify which action we expect to trigger
          },
        };

        // Create a test state
        const testState: State = {
          values: {},
          data: {},
          text: "",
        } as State;

        let responseText = "";
        let responseReceived = false;

        // Find the HELLO_RUST action in runtime.actions
        const runtimeActions = runtime.actions;
        const helloRustAction = runtimeActions?.find(
          (a) => a.name === "HELLO_RUST",
        );
        if (!helloRustAction) {
          throw new Error("HELLO_RUST action not found in runtime actions");
        }

        // Create a callback that captures the agent's response
        const callback: HandlerCallback = async (response: Content) => {
          responseReceived = true;
          responseText = response.text || "";

          // Verify the response includes the expected action
          const responseActions = response.actions;
          if (!responseActions || !responseActions.includes("HELLO_RUST")) {
            throw new Error("Response did not include HELLO_RUST action");
          }

          // Return Promise<Memory[]> as required by the HandlerCallback interface
          return Promise.resolve([]);
        };

        // Execute the action - this simulates the runtime calling the action
        const result = await helloRustAction.handler(
          runtime,
          testMessage,
          testState,
          {},
          callback,
        );

        // Verify we received a response
        if (!responseReceived) {
          throw new Error(
            "HELLO_RUST action did not produce a response via callback",
          );
        }

        // Verify the action returned a result
        if (!result) {
          throw new Error("HELLO_RUST action did not return a result");
        }

        // Verify the action result is successful
        if (!result.success) {
          const errorMsg =
            result.error instanceof Error
              ? result.error.message
              : typeof result.error === "string"
                ? result.error
                : "Unknown error";
          throw new Error(`HELLO_RUST action failed: ${errorMsg}`);
        }

        // Verify the response contains "Hello from Rust" (case-insensitive)
        const combinedText = (
          responseText +
          " " +
          (result.text || "")
        ).toLowerCase();
        if (
          !combinedText.includes("hello from rust") &&
          !combinedText.includes("rust")
        ) {
          throw new Error(
            `Expected response to contain "Hello from Rust" but got: "${responseText}" / "${result.text}"`,
          );
        }

        // Verify the response contains the crab emoji or indicates Rust
        if (!combinedText.includes("🦀") && !combinedText.includes("rust")) {
          throw new Error(
            `Expected response to contain Rust indicator (🦀 or "rust") but got: "${combinedText}"`,
          );
        }

        // Success! The agent responded with "Hello from Rust" as expected
      },
    },

    /**
     * Provider Functionality Test
     * ---------------------------
     * Tests that the RUST_INFO provider can supply data to the agent.
     */
    {
      name: "rust_info_provider_test",
      fn: async (runtime: IAgentRuntime) => {
        // Create a test message
        const testMessage: Memory = {
          entityId: "12345678-1234-1234-1234-123456789012" as UUID,
          roomId: "12345678-1234-1234-1234-123456789012" as UUID,
          content: {
            text: "What can you provide?",
            source: "test",
          },
        };

        // Create a test state
        const testState: State = {
          values: {},
          data: {},
          text: "",
        } as State;

        // Find the RUST_INFO provider in runtime.providers
        const runtimeProviders = runtime.providers;
        const rustInfoProvider = runtimeProviders?.find(
          (p) => p.name === "RUST_INFO",
        );
        if (!rustInfoProvider) {
          throw new Error("RUST_INFO provider not found in runtime providers");
        }

        // Test the provider
        const result = await rustInfoProvider.get(
          runtime,
          testMessage,
          testState,
        );

        if (!result.text) {
          throw new Error("RUST_INFO provider did not return text");
        }

        // Verify the provider returns information about Rust
        if (!result.text.toLowerCase().includes("rust")) {
          throw new Error(
            `Expected provider to return text containing "rust", got "${result.text}"`,
          );
        }

        // Verify values are present
        if (!result.values || Object.keys(result.values).length === 0) {
          throw new Error("RUST_INFO provider did not return values");
        }
      },
    },

    /**
     * Action Validation Test
     * -----------------------
     * Verifies that action validation works correctly.
     */
    {
      name: "action_validation_test",
      fn: async (runtime: IAgentRuntime) => {
        const runtimeActions = runtime.actions;
        const helloRustAction = runtimeActions?.find(
          (a) => a.name === "HELLO_RUST",
        );
        if (!helloRustAction) {
          throw new Error("HELLO_RUST action not found");
        }

        // Test validation with a valid message
        const validMessage: Memory = {
          entityId: "12345678-1234-1234-1234-123456789012" as UUID,
          roomId: "12345678-1234-1234-1234-123456789012" as UUID,
          content: {
            text: "Hello",
            source: "test",
          },
        };

        const isValid = await helloRustAction.validate(
          runtime,
          validMessage,
          undefined,
        );

        if (!isValid) {
          throw new Error(
            "HELLO_RUST action validation failed for valid message",
          );
        }
      },
    },
  ],
};

// Export a default instance of the test suite for the E2E test runner
export default RustPluginTestSuite;
