/**
 * @fileoverview Integration Runtime Factory
 *
 * Creates real AgentRuntime instances for integration testing with:
 * - Real PGLite/Postgres database (via @elizaos/plugin-sql)
 * - Real inference providers (Ollama, OpenAI, Anthropic, etc.)
 *
 * NO MOCKS. Tests require real infrastructure.
 */

import { v4 as uuidv4 } from "uuid";
import { logger } from "../logger";
import { AgentRuntime } from "../runtime";
import type {
  Character,
  IAgentRuntime,
  IDatabaseAdapter,
  Plugin,
  UUID,
} from "../types";
import {
  type InferenceProviderInfo,
  requireInferenceProvider,
} from "./inference-provider";
import { createOllamaModelHandlers } from "./ollama-provider";

/**
 * Configuration for creating an integration test runtime
 */
export interface IntegrationTestConfig {
  /** Character configuration for the test agent */
  character?: Partial<Character>;
  /** Additional plugins to load */
  plugins?: Plugin[];
  /**
   * Database adapter - REQUIRED for integration tests.
   * Use @elizaos/plugin-sql to create one.
   */
  databaseAdapter: IDatabaseAdapter;
  /** Skip inference provider check (for database-only tests) */
  skipInferenceCheck?: boolean;
  /** Timeout for initialization in ms (default: 30000) */
  initTimeout?: number;
}

/**
 * Result from creating an integration test runtime
 */
export interface IntegrationTestResult {
  /** The fully initialized AgentRuntime */
  runtime: IAgentRuntime;
  /** Agent ID for this test */
  agentId: UUID;
  /** The inference provider being used */
  inferenceProvider: InferenceProviderInfo | null;
  /** Cleanup function to call after test */
  cleanup: () => Promise<void>;
}

/**
 * Default test character for integration tests
 */
export const DEFAULT_TEST_CHARACTER: Character = {
  name: "IntegrationTestAgent",
  system:
    "You are a helpful assistant used for integration testing. Respond concisely and accurately.",
  bio: ["Integration test agent for elizaOS"],
  messageExamples: [],
  postExamples: [],
  topics: ["testing", "integration"],
  knowledge: [],
  plugins: [],
  settings: {},
};

/**
 * Creates a fully initialized AgentRuntime for integration testing.
 */
export async function createIntegrationTestRuntime(
  config: IntegrationTestConfig,
): Promise<IntegrationTestResult> {
  const {
    character = {},
    plugins = [],
    databaseAdapter,
    skipInferenceCheck = false,
    initTimeout = 30000,
  } = config;

  if (!databaseAdapter) {
    throw new Error(
      "Integration tests require a database adapter.\n\n" +
        "Create one using @elizaos/plugin-sql:\n\n" +
        "  import { createDatabaseAdapter } from '@elizaos/plugin-sql';\n" +
        "  const adapter = createDatabaseAdapter({ dataDir: '/tmp/test' }, agentId);\n" +
        "  await adapter.init();\n",
    );
  }

  const agentId = uuidv4() as UUID;
  const testCharacter: Character = {
    ...DEFAULT_TEST_CHARACTER,
    ...character,
    id: agentId,
  };

  logger.info(
    { src: "integration-test", agentId },
    "Creating integration test runtime",
  );

  // Check inference availability (unless skipped for database-only tests)
  let inferenceProvider: InferenceProviderInfo | null = null;
  if (!skipInferenceCheck) {
    inferenceProvider = await requireInferenceProvider();
  }

  // Create runtime with real adapter
  const runtime = new AgentRuntime({
    character: testCharacter,
    agentId,
    adapter: databaseAdapter,
    plugins,
  });

  // Register Ollama model handlers if using local inference
  if (inferenceProvider?.name === "ollama") {
    const ollamaHandlers = createOllamaModelHandlers();
    for (const [modelType, handler] of Object.entries(ollamaHandlers)) {
      runtime.registerModel(modelType, handler, "ollama");
    }
  }

  // Initialize with timeout
  const initPromise = runtime.initialize();
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(`Runtime initialization timed out after ${initTimeout}ms`),
        ),
      initTimeout,
    );
  });

  await Promise.race([initPromise, timeoutPromise]);

  logger.info(
    { src: "integration-test", agentId },
    "Integration test runtime initialized successfully",
  );

  const cleanup = async () => {
    try {
      await runtime.stop();
      logger.debug(
        { src: "integration-test", agentId },
        "Test runtime cleaned up",
      );
    } catch (error) {
      logger.warn(
        {
          src: "integration-test",
          agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error during test cleanup",
      );
    }
  };

  return { runtime, agentId, inferenceProvider, cleanup };
}

/**
 * Convenience wrapper that handles setup and cleanup automatically.
 */
export async function withTestRuntime<T>(
  testFn: (runtime: IAgentRuntime, agentId: UUID) => Promise<T>,
  config: IntegrationTestConfig,
): Promise<T> {
  const { runtime, agentId, cleanup } =
    await createIntegrationTestRuntime(config);

  try {
    return await testFn(runtime, agentId);
  } finally {
    await cleanup();
  }
}
