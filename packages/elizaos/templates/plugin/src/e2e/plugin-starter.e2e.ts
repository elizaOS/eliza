import type {
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
  TestSuite,
  UUID,
} from "@elizaos/core";

export const StarterPluginTestSuite: TestSuite = {
  name: "plugin_starter_test_suite",
  tests: [
    {
      name: "example_test",
      fn: async (runtime: IAgentRuntime) => {
        if (runtime.character.name !== "Eliza") {
          throw new Error(
            `Expected character name to be "Eliza" but got "${runtime.character.name}"`,
          );
        }
        const service = runtime.getService("starter");
        if (!service) {
          throw new Error("Starter service not found");
        }
      },
    },

    {
      name: "should_have_hello_world_action",
      fn: async (runtime: IAgentRuntime) => {
        const actionExists = runtime.actions.some((a) => a.name === "HELLO_WORLD");
        if (!actionExists) {
          throw new Error("Hello world action not found in runtime actions");
        }
      },
    },

    {
      name: "hello_world_action_test",
      fn: async (runtime: IAgentRuntime) => {
        const testMessage: Memory = {
          entityId: "12345678-1234-1234-1234-123456789012" as UUID,
          roomId: "12345678-1234-1234-1234-123456789012" as UUID,
          content: {
            text: "Can you say hello?",
            source: "test",
            actions: ["HELLO_WORLD"],
          },
        };

        const testState: State = {
          values: {},
          data: {},
          text: "",
        };

        let responseText = "";
        let responseReceived = false;

        const helloWorldAction = runtime.actions.find((a) => a.name === "HELLO_WORLD");
        if (!helloWorldAction) {
          throw new Error("Hello world action not found in runtime actions");
        }

        const callback: HandlerCallback = async (response: Content) => {
          responseReceived = true;
          responseText = response.text || "";

          const responseActions = response.actions;
          if (!responseActions?.includes("HELLO_WORLD")) {
            throw new Error("Response did not include HELLO_WORLD action");
          }

          return Promise.resolve([]);
        };

        await helloWorldAction.handler(runtime, testMessage, testState, {}, callback);

        if (!responseReceived) {
          throw new Error("Hello world action did not produce a response");
        }

        if (!responseText.toLowerCase().includes("hello world")) {
          throw new Error(`Expected response to contain "hello world" but got: "${responseText}"`);
        }
      },
    },

    {
      name: "hello_world_provider_test",
      fn: async (runtime: IAgentRuntime) => {
        const testMessage: Memory = {
          entityId: "12345678-1234-1234-1234-123456789012" as UUID,
          roomId: "12345678-1234-1234-1234-123456789012" as UUID,
          content: {
            text: "What can you provide?",
            source: "test",
          },
        };

        const testState: State = {
          values: {},
          data: {},
          text: "",
        };

        const helloWorldProvider = runtime.providers.find((p) => p.name === "HELLO_WORLD_PROVIDER");
        if (!helloWorldProvider) {
          throw new Error("Hello world provider not found in runtime providers");
        }

        const result = await helloWorldProvider.get(runtime, testMessage, testState);

        if (result.text !== "I am a provider") {
          throw new Error(`Expected provider to return "I am a provider", got "${result.text}"`);
        }
      },
    },

    {
      name: "starter_service_test",
      fn: async (runtime: IAgentRuntime) => {
        const service = runtime.getService("starter");
        if (!service) {
          throw new Error("Starter service not found");
        }

        if (
          service.capabilityDescription !==
          "This is a starter service which is attached to the agent through the starter plugin."
        ) {
          throw new Error("Incorrect service capability description");
        }
        await service.stop();
      },
    },
  ],
};

export default StarterPluginTestSuite;
