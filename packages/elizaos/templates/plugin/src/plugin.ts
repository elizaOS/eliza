import type {
  Action,
  ActionResult,
  GenerateTextParams,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  RouteRequest,
  RouteResponse,
  State,
} from "@elizaos/core";
import { logger, ModelType, Service } from "@elizaos/core";
import { z } from "zod";
import { StarterPluginTestSuite } from "./e2e/plugin-starter.e2e";

const configSchema = z.object({
  EXAMPLE_PLUGIN_VARIABLE: z
    .string()
    .min(1, "Example plugin variable is not provided")
    .optional()
    .transform((val) => {
      if (!val) {
        logger.warn("Example plugin variable is not provided (this is expected)");
      }
      return val;
    }),
});

const helloWorldAction: Action = {
  name: "HELLO_WORLD",
  similes: ["GREET", "SAY_HELLO"],
  description: "Responds with a simple hello world message",

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
  ): Promise<boolean> => {
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: HandlerOptions | undefined,
    callback?: HandlerCallback,
    _responses?: Memory[],
  ): Promise<ActionResult> => {
    const response = "Hello world!";

    if (callback) {
      await callback({
        text: response,
        actions: ["HELLO_WORLD"],
        source: message.content.source,
      });
    }

    return {
      text: response,
      success: true,
      data: {
        actions: ["HELLO_WORLD"],
        source: message.content.source,
      },
    };
  },

  examples: [
    [
      {
        name: "{{userName}}",
        content: {
          text: "hello",
          actions: [],
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Hello world!",
          actions: ["HELLO_WORLD"],
        },
      },
    ],
  ],
};

const helloWorldProvider: Provider = {
  name: "HELLO_WORLD_PROVIDER",
  description: "A simple example provider",

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
  ): Promise<ProviderResult> => {
    return {
      text: "I am a provider",
      values: {},
      data: {},
    };
  },
};

class StarterService extends Service {
  static serviceType = "starter";
  capabilityDescription =
    "This is a starter service which is attached to the agent through the starter plugin.";

  static async start(runtime: IAgentRuntime): Promise<StarterService> {
    return new StarterService(runtime);
  }

  async stop(): Promise<void> {
    logger.debug("StarterService stopped");
  }
}

export const starterPlugin: Plugin = {
  name: "plugin-starter",
  description: "Plugin starter for elizaOS",
  config: {
    EXAMPLE_PLUGIN_VARIABLE: process.env.EXAMPLE_PLUGIN_VARIABLE ?? null,
  },
  async init(config: Record<string, string>) {
    logger.debug("Plugin initialized");
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) process.env[key] = String(value);
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorIssues = error.issues;
        const errorMessages =
          errorIssues?.map((e) => e.message).join(", ") || "Unknown validation error";
        throw new Error(`Invalid plugin configuration: ${errorMessages}`);
      }
      throw new Error(
        `Invalid plugin configuration: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
  models: {
    [ModelType.TEXT_SMALL]: async (
      _runtime,
      { prompt: _prompt, stopSequences: _stopSequences = [] }: GenerateTextParams,
    ) => {
      return "Small text model fixture response.";
    },
    [ModelType.TEXT_LARGE]: async (
      _runtime,
      {
        prompt: _prompt,
        stopSequences: _stopSequences = [],
        maxTokens: _maxTokens = 8192,
        temperature: _temperature = 0.7,
        frequencyPenalty: _frequencyPenalty = 0.7,
        presencePenalty: _presencePenalty = 0.7,
      }: GenerateTextParams,
    ) => {
      return "Large text model fixture response.";
    },
  },
  routes: [
    {
      name: "hello-world-route",
      path: "/helloworld",
      type: "GET",
      handler: async (_req: RouteRequest, res: RouteResponse) => {
        res.json({
          message: "Hello World!",
        });
      },
    },
    {
      name: "current-time-route",
      path: "/api/time",
      type: "GET",
      handler: async (_req: RouteRequest, res: RouteResponse) => {
        const now = new Date();
        res.json({
          timestamp: now.toISOString(),
          unix: Math.floor(now.getTime() / 1000),
          formatted: now.toLocaleString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
      },
    },
  ],
  events: {
    MESSAGE_RECEIVED: [
      async (params) => {
        logger.debug("MESSAGE_RECEIVED event received");
        logger.debug({ keys: Object.keys(params) }, "MESSAGE_RECEIVED param keys");
      },
    ],
    VOICE_MESSAGE_RECEIVED: [
      async (params) => {
        logger.debug("VOICE_MESSAGE_RECEIVED event received");
        logger.debug({ keys: Object.keys(params) }, "VOICE_MESSAGE_RECEIVED param keys");
      },
    ],
    WORLD_CONNECTED: [
      async (params) => {
        logger.debug("WORLD_CONNECTED event received");
        logger.debug({ keys: Object.keys(params) }, "WORLD_CONNECTED param keys");
      },
    ],
    WORLD_JOINED: [
      async (params) => {
        logger.debug("WORLD_JOINED event received");
        logger.debug({ keys: Object.keys(params) }, "WORLD_JOINED param keys");
      },
    ],
  },
  actions: [helloWorldAction],
  providers: [helloWorldProvider],
  services: [StarterService],
  tests: [StarterPluginTestSuite],
};

export default starterPlugin;
