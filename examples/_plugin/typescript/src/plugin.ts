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

/**
 * Defines the configuration schema for a plugin, including the validation rules for the plugin name.
 *
 * @type {import('zod').ZodObject<{ EXAMPLE_PLUGIN_VARIABLE: import('zod').ZodString }>}
 */
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

/**
 * Example HelloWorld action
 * This demonstrates the simplest possible action structure
 */
/**
 * Action representing a hello world message.
 * @typedef {Object} Action
 * @property {string} name - The name of the action.
 * @property {string[]} similes - An array of related actions.
 * @property {string} description - A brief description of the action.
 * @property {Function} validate - Asynchronous function to validate the action.
 * @property {Function} handler - Asynchronous function to handle the action and generate a response.
 * @property {Object[]} examples - An array of example inputs and expected outputs for the action.
 */
const helloWorldAction: Action = {
  name: "HELLO_WORLD",
  similes: ["GREET", "SAY_HELLO"],
  description: "Responds with a simple hello world message",

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
  ): Promise<boolean> => {
    // Always valid
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

/**
 * Example Hello World Provider
 * This demonstrates the simplest possible provider implementation
 */
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

export class StarterService extends Service {
  static serviceType = "starter";
  capabilityDescription =
    "This is a starter service which is attached to the agent through the starter plugin.";

  static async start(runtime: IAgentRuntime) {
    logger.info("Starting starter service");
    const service = new StarterService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime) {
    logger.info("Stopping starter service");
    // get the service from the runtime
    const service = runtime.getService(StarterService.serviceType);
    if (!service) {
      throw new Error("Starter service not found");
    }
    service.stop();
  }

  async stop() {
    logger.info("Stopping StarterService");
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

      // Set all environment variables at once
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
      return "Never gonna give you up, never gonna let you down, never gonna run around and desert you...";
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
      return "Never gonna make you cry, never gonna say goodbye, never gonna tell a lie and hurt you...";
    },
  },
  routes: [
    {
      name: "hello-world-route",
      path: "/helloworld",
      type: "GET",
      handler: async (_req: RouteRequest, res: RouteResponse) => {
        // send a response
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
        // Return current time in various formats
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
        // print the keys
        logger.debug({ keys: Object.keys(params) }, "MESSAGE_RECEIVED param keys");
      },
    ],
    VOICE_MESSAGE_RECEIVED: [
      async (params) => {
        logger.debug("VOICE_MESSAGE_RECEIVED event received");
        // print the keys
        logger.debug({ keys: Object.keys(params) }, "VOICE_MESSAGE_RECEIVED param keys");
      },
    ],
    WORLD_CONNECTED: [
      async (params) => {
        logger.debug("WORLD_CONNECTED event received");
        // print the keys
        logger.debug({ keys: Object.keys(params) }, "WORLD_CONNECTED param keys");
      },
    ],
    WORLD_JOINED: [
      async (params) => {
        logger.debug("WORLD_JOINED event received");
        // print the keys
        logger.debug({ keys: Object.keys(params) }, "WORLD_JOINED param keys");
      },
    ],
  },
  services: [StarterService],
  actions: [helloWorldAction],
  providers: [helloWorldProvider],
  tests: [StarterPluginTestSuite],
  // dependencies: ['@elizaos/plugin-knowledge'], <--- plugin dependencies go here (if requires another plugin)
};

export default starterPlugin;
