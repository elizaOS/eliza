/**
 * RLM (Recursive Language Model) plugin for elizaOS.
 *
 * This plugin integrates Recursive Language Models into elizaOS, enabling
 * LLMs to process arbitrarily long contexts through recursive self-calls
 * in a REPL environment.
 *
 * Reference:
 * - Paper: https://arxiv.org/abs/2512.24601
 * - Implementation: https://github.com/alexzhang13/rlm
 */

import type {
  GenerateTextParams,
  IAgentRuntime,
  Plugin,
  RecordLlmCallDetails,
} from "@elizaos/core";
import {
  buildCanonicalSystemPrompt,
  logger,
  ModelType,
  recordLlmCall,
  resolveEffectiveSystemPrompt,
} from "@elizaos/core";

import { RLMClient, stubResult } from "./client";
import { estimateTokenCount } from "./cost";
import type { RLMConfig } from "./types";
import { DEFAULT_CONFIG, ENV_VARS } from "./types";

// Safe env access for browser/non-Node environments
const env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {};

// ============================================================================
// Thread-safe Singleton Client Management
// ============================================================================

/**
 * Singleton state for thread-safe client initialization.
 *
 * In concurrent environments, multiple requests could try to initialize
 * the client simultaneously. We use a promise-based lock to ensure
 * only one initialization happens.
 */
interface ClientState {
  client: RLMClient | null;
  initPromise: Promise<RLMClient> | null;
  configHash: string | null;
}

const clientState: ClientState = {
  client: null,
  initPromise: null,
  configHash: null,
};

/**
 * Compute a simple hash of config for detecting changes.
 */
function computeConfigHash(config: Partial<RLMConfig>): string {
  const key = [
    config.backend ?? "",
    config.environment ?? "",
    String(config.maxIterations ?? ""),
    String(config.maxDepth ?? ""),
    config.pythonPath ?? "",
  ].join("|");
  return key;
}

/**
 * Get or create the shared RLM client instance (thread-safe).
 *
 * This implementation ensures:
 * 1. Only one client is created even under concurrent initialization
 * 2. Config changes are detected and client is recreated
 * 3. Initialization errors are properly handled
 */
function getOrCreateClient(runtime: IAgentRuntime): RLMClient {
  // Get config from runtime or environment
  const runtimeConfig = (runtime as unknown as Record<string, unknown>).rlmConfig as
    | Partial<RLMConfig>
    | undefined;
  const configHash = computeConfigHash(runtimeConfig ?? {});

  // Check if config changed - need to recreate client
  if (clientState.client && clientState.configHash !== configHash) {
    logger.info("[RLM] Config changed, recreating client");
    // Shutdown old client (fire and forget)
    clientState.client.shutdown().catch((err) => {
      logger.warn("[RLM] Error shutting down old client:", err);
    });
    clientState.client = null;
    clientState.initPromise = null;
  }

  // Fast path: client already exists with same config
  if (clientState.client) {
    return clientState.client;
  }

  // Slow path: need to create client
  // Create synchronously to avoid Promise in synchronous getter
  const client = new RLMClient(runtimeConfig);
  clientState.client = client;
  clientState.configHash = configHash;

  return client;
}

/**
 * Reset the client singleton. Useful for testing or forced reinitialization.
 */
export async function resetClient(): Promise<void> {
  if (clientState.client) {
    await clientState.client.shutdown();
  }
  clientState.client = null;
  clientState.initPromise = null;
  clientState.configHash = null;
}

/**
 * Handle text generation using RLM.
 */
async function handleTextGeneration(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
): Promise<string> {
  const client = getOrCreateClient(runtime);

  // Use prompt from params
  const input = params.prompt ?? "";

  const opts = {
    maxTokens: params.maxTokens,
    temperature: params.temperature,
    topP: params.topP,
    stopSequences: params.stopSequences,
    user: params.user,
  };

  // Remove undefined values
  const cleanOpts = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));

  const runtimeConfig = (runtime as unknown as Record<string, unknown>).rlmConfig as
    | Partial<RLMConfig>
    | undefined;
  const backend = runtimeConfig?.backend ?? DEFAULT_CONFIG.backend;
  const model = `${backend}:rlm`;
  const details: RecordLlmCallDetails = {
    model,
    systemPrompt:
      resolveEffectiveSystemPrompt({
        params,
        fallback: buildCanonicalSystemPrompt({ character: runtime.character }),
      }) ?? "",
    userPrompt: input,
    temperature: params.temperature ?? 0,
    maxTokens: params.maxTokens ?? 0,
    purpose: "external_llm",
    actionType: "rlm.client.infer",
    promptTokens: estimateTokenCount(input),
  };

  const result = await recordLlmCall(runtime, details, async () => {
    const response = await client.infer(input, cleanOpts);
    details.response = response.text;
    details.completionTokens = estimateTokenCount(response.text);
    return response;
  });
  return result.text;
}

/**
 * RLM plugin definition.
 */
export const rlmPlugin: Plugin = {
  name: "rlm",
  description:
    "RLM (Recursive Language Model) adapter for elizaOS - enables processing of arbitrarily long contexts through recursive self-calls",

  config: {
    [ENV_VARS.BACKEND]: env[ENV_VARS.BACKEND] ?? DEFAULT_CONFIG.backend,
    [ENV_VARS.ENVIRONMENT]: env[ENV_VARS.ENVIRONMENT] ?? DEFAULT_CONFIG.environment,
    [ENV_VARS.MAX_ITERATIONS]: env[ENV_VARS.MAX_ITERATIONS] ?? String(DEFAULT_CONFIG.maxIterations),
    [ENV_VARS.MAX_DEPTH]: env[ENV_VARS.MAX_DEPTH] ?? String(DEFAULT_CONFIG.maxDepth),
    [ENV_VARS.VERBOSE]: env[ENV_VARS.VERBOSE] ?? "false",
    [ENV_VARS.PYTHON_PATH]: env[ENV_VARS.PYTHON_PATH] ?? DEFAULT_CONFIG.pythonPath,
  },

  async init(config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    logger.info("[RLM] Initializing RLM plugin");

    // Store config on runtime
    (runtime as unknown as Record<string, unknown>).rlmConfig = {
      backend: config[ENV_VARS.BACKEND] ?? DEFAULT_CONFIG.backend,
      environment: config[ENV_VARS.ENVIRONMENT] ?? DEFAULT_CONFIG.environment,
      maxIterations:
        Number.parseInt(config[ENV_VARS.MAX_ITERATIONS] ?? "", 10) || DEFAULT_CONFIG.maxIterations,
      maxDepth: Number.parseInt(config[ENV_VARS.MAX_DEPTH] ?? "", 10) || DEFAULT_CONFIG.maxDepth,
      verbose: ["1", "true", "yes"].includes((config[ENV_VARS.VERBOSE] ?? "").toLowerCase()),
      pythonPath: config[ENV_VARS.PYTHON_PATH] ?? DEFAULT_CONFIG.pythonPath,
    };

    // Pre-initialize client
    const client = getOrCreateClient(runtime);
    const status = await client.getStatus();

    if (status.available) {
      logger.info(`[RLM] Backend available: ${status.backend}`);
    } else {
      logger.warn("[RLM] Backend not available - running in stub mode");
    }
  },

  models: {
    [ModelType.TEXT_SMALL]: handleTextGeneration,
    [ModelType.TEXT_LARGE]: handleTextGeneration,
    [ModelType.TEXT_REASONING_SMALL]: handleTextGeneration,
    [ModelType.TEXT_REASONING_LARGE]: handleTextGeneration,
    [ModelType.TEXT_COMPLETION]: handleTextGeneration,
  },

  tests: [
    {
      name: "rlm_plugin_tests",
      tests: [
        {
          name: "rlm_test_stub_mode",
          fn: async (_runtime: IAgentRuntime): Promise<void> => {
            // Test that stub mode works
            const result = stubResult();
            if (!result.metadata.stub) {
              throw new Error("Stub result should have stub=true");
            }
            logger.info("[RLM Test] Stub mode test passed");
          },
        },
        {
          name: "rlm_test_text_generation",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const text = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "Say 'hello' in exactly one word.",
            });

            if (typeof text !== "string") {
              throw new Error("TEXT_LARGE should return string");
            }

            logger.info(`[RLM Test] TEXT_LARGE generated: "${text.substring(0, 50)}..."`);
          },
        },
        {
          name: "rlm_test_message_format",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const text = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "What is 2 + 2?",
            });

            if (typeof text !== "string") {
              throw new Error("TEXT_LARGE with prompt should return string");
            }

            logger.info("[RLM Test] Message format test passed");
          },
        },
      ],
    },
  ],
};

export default rlmPlugin;

// Re-export types and client
export { configFromEnv, RLMClient, stubResult } from "./client";
export type {
  GenerateTextParams,
  RLMConfig,
  RLMInferOptions,
  RLMMessage,
  RLMMetadata,
  RLMResult,
  RLMStatusResponse,
} from "./types";
export { DEFAULT_CONFIG, ENV_VARS } from "./types";
