/**
 * Test Runtime Infrastructure
 *
 * Thin wrapper around the production RuntimeFactory.
 * We test the actual production code, not a mock.
 *
 * CRITICAL: Anonymous sessions are BLOCKED in tests by default.
 * All tests must use properly created test users with valid API keys.
 */

import { stringToUuid, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import type { DebugRenderView, DebugTrace } from "../../lib/debug";
import { AgentMode } from "../../lib/eliza/agent-mode-types";

// Re-export debug types for test convenience
export type {
  DebugFailure,
  DebugRenderView,
  DebugStep,
  DebugTrace,
  DebugTraceRenderOptions,
} from "../../lib/debug";
export {
  clearDebugTraces,
  getDebugTraceStoreStats,
  getLatestDebugTrace,
  isDebugTracingEnabled,
  listDebugTraces,
  renderDebugTrace,
} from "../../lib/debug";
// Re-export the production RuntimeFactory directly
export {
  _testing,
  getRuntimeCacheStats,
  invalidateByOrganization,
  invalidateRuntime,
  isRuntimeCached,
  runtimeFactory,
} from "../../lib/eliza/runtime-factory";
// Re-export types from the production code
export type { UserContext } from "../../lib/eliza/user-context";
export { AgentMode };

// Import for type inference
import type { runtimeFactory as RuntimeFactoryType } from "../../lib/eliza/runtime-factory";
import type { UserContext } from "../../lib/eliza/user-context";
import type { TestDataSet } from "./test-data-factory";

// Type for the runtime returned by RuntimeFactory
export type TestRuntime = Awaited<ReturnType<typeof RuntimeFactoryType.createRuntimeForUser>>;

/**
 * Result from createTestRuntime including cleanup function
 */
export interface TestRuntimeResult {
  runtime: TestRuntime;
  agentId: string;
  characterName: string;
  timings?: {
    adapterCreate: number;
    runtimeCreate: number;
    initialize: number;
    mcpWait: number;
    total: number;
  };
  cleanup: () => Promise<void>;
}

/**
 * Options for creating a test runtime
 */
export interface CreateTestRuntimeOptions {
  /** Test data set containing user, org, api key */
  testData: TestDataSet;
  /** Character ID to load (optional - uses default if not provided) */
  characterId?: string;
  /** Agent mode (defaults to CHAT) */
  agentMode?: AgentMode;
  /** Enable web search (defaults to false for tests) */
  webSearchEnabled?: boolean;
  /** Model preferences */
  modelPreferences?: {
    nanoModel?: string;
    smallModel?: string;
    mediumModel?: string;
    largeModel?: string;
    megaModel?: string;
    responseHandlerModel?: string;
    shouldRespondModel?: string;
    actionPlannerModel?: string;
    plannerModel?: string;
    responseModel?: string;
    mediaDescriptionModel?: string;
  };
}

/**
 * Validate test data is complete and not anonymous
 * Throws if data is missing or represents an anonymous user
 */
function validateTestData(testData: TestDataSet): void {
  if (!testData) {
    throw new Error(
      "[TestRuntime] Test data is required. Create test data with createTestDataSet() first.",
    );
  }

  if (!testData.user) {
    throw new Error("[TestRuntime] Test user is required. Test data must include a valid user.");
  }

  if (!testData.apiKey?.key) {
    throw new Error(
      "[TestRuntime] Test API key is required. Test data must include a valid API key.",
    );
  }

  if (!testData.organization?.id) {
    throw new Error(
      "[TestRuntime] Test organization is required. Test data must include a valid organization.",
    );
  }

  // Block anonymous users in tests (unless explicitly testing anonymous flow)
  if (testData.user.isAnonymous && process.env.TEST_BLOCK_ANONYMOUS !== "false") {
    throw new Error(
      "[TestRuntime] Anonymous users are BLOCKED in tests.\n" +
        "Tests must use properly created test users with valid API keys.\n" +
        "If you need to test anonymous flow, set TEST_BLOCK_ANONYMOUS=false",
    );
  }

  // Validate API key format
  if (!testData.apiKey.key.startsWith("eliza_")) {
    throw new Error(
      `[TestRuntime] Invalid test API key format: ${testData.apiKey.keyPrefix}...\n` +
        "Test API keys must start with 'eliza_' to match production API key auth.",
    );
  }
}

/**
 * Create a test runtime using the production RuntimeFactory
 * This is the main entry point for runtime tests
 *
 * BLOCKS if:
 * - Test data is missing or invalid
 * - User is anonymous (unless explicitly testing anonymous flow)
 */
export async function createTestRuntime(
  options: CreateTestRuntimeOptions,
): Promise<TestRuntimeResult> {
  // Validate test data
  validateTestData(options.testData);

  const { runtimeFactory } = await import("../../lib/eliza/runtime-factory");

  const userContext = buildUserContext(options.testData, {
    agentMode: options.agentMode,
    characterId: options.characterId,
    webSearchEnabled: options.webSearchEnabled ?? false,
    modelPreferences: options.modelPreferences,
  });

  const startTime = Date.now();
  const runtime = await runtimeFactory.createRuntimeForUser(userContext);
  const totalTime = Date.now() - startTime;

  return {
    runtime,
    agentId: runtime.agentId,
    characterName: runtime.character?.name || "Unknown",
    timings: {
      adapterCreate: 0, // Would need instrumentation in RuntimeFactory to capture
      runtimeCreate: 0,
      initialize: 0,
      mcpWait: 0,
      total: totalTime,
    },
    cleanup: async () => {
      try {
        const { invalidateRuntime } = await import("../../lib/eliza/runtime-factory");
        await invalidateRuntime(runtime.agentId);
      } catch (e) {
        console.warn(`[TestRuntime] Cleanup warning: ${e}`);
      }
    },
  };
}

/**
 * Chat a UserContext from test data
 * This creates the exact interface that RuntimeFactory expects
 *
 * ALWAYS sets isAnonymous: false - anonymous is blocked in tests
 */
export function buildUserContext(
  testData: TestDataSet,
  options: {
    agentMode?: AgentMode;
    characterId?: string;
    webSearchEnabled?: boolean;
    modelPreferences?: {
      nanoModel?: string;
      smallModel?: string;
      mediumModel?: string;
      largeModel?: string;
      megaModel?: string;
      responseHandlerModel?: string;
      shouldRespondModel?: string;
      actionPlannerModel?: string;
      plannerModel?: string;
      responseModel?: string;
      mediaDescriptionModel?: string;
    };
    appId?: string;
    appPromptConfig?: Record<string, unknown>;
    oauthConnections?: Array<{ platform: string }>;
  } = {},
): UserContext {
  // Validate we're not creating anonymous context
  if (testData.user.isAnonymous && process.env.TEST_BLOCK_ANONYMOUS !== "false") {
    throw new Error(
      "[TestRuntime] Cannot build UserContext for anonymous user.\n" +
        "Tests must use authenticated users. Set TEST_BLOCK_ANONYMOUS=false to override.",
    );
  }

  const mode = options.agentMode || AgentMode.CHAT;

  return {
    userId: testData.user.id,
    entityId: stringToUuid(testData.user.id) as string,
    organizationId: testData.organization.id,
    agentMode: mode,
    apiKey: testData.apiKey.key,
    isAnonymous: false, // ALWAYS false in tests
    characterId: options.characterId,
    webSearchEnabled: options.webSearchEnabled ?? true,
    modelPreferences: options.modelPreferences,
    appId: options.appId,
    appPromptConfig: options.appPromptConfig,
    name: testData.user.name,
    email: testData.user.email,
    oauthConnections: options.oauthConnections,
  };
}

/**
 * Test user context for elizaOS entities (world, room, entity)
 */
export interface TestUserContext {
  userId: string;
  entityId: UUID;
  roomId: UUID;
  worldId: UUID;
}

/**
 * Create elizaOS entities for a test user (world, room, entity)
 */
export async function createTestUser(
  runtime: TestRuntime,
  name: string = "TestUser",
): Promise<TestUserContext> {
  const userId = `user-${uuidv4().slice(0, 8)}`;
  const entityId = stringToUuid(userId) as UUID;
  const roomId = stringToUuid(`room-${uuidv4().slice(0, 8)}`) as UUID;
  const worldId = stringToUuid(`world-${uuidv4().slice(0, 8)}`) as UUID;

  const { ChannelType } = await import("@elizaos/core");

  // Ensure world exists
  try {
    await runtime.ensureWorldExists({
      id: worldId,
      name: `Test World for ${name}`,
      agentId: runtime.agentId,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes("duplicate") && !msg.includes("unique constraint")) throw error;
  }

  // Ensure room exists
  try {
    await runtime.ensureRoomExists({
      id: roomId,
      name: `Test Chat with ${name}`,
      type: ChannelType.DM,
      channelId: roomId,
      worldId,
      serverId: worldId,
      agentId: runtime.agentId,
      source: "test",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes("duplicate") && !msg.includes("unique constraint")) throw error;
  }

  // Ensure agent entity exists
  try {
    const agentExists = await runtime.getEntityById(runtime.agentId);
    if (!agentExists) {
      await runtime.createEntity({
        id: runtime.agentId,
        agentId: runtime.agentId,
        names: [runtime.character?.name || "Agent"],
        metadata: { name: runtime.character?.name || "Agent", type: "agent" },
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes("duplicate") && !msg.includes("unique constraint")) throw error;
  }

  // Ensure user entity exists
  try {
    await runtime.createEntity({
      id: entityId,
      agentId: runtime.agentId,
      names: [name],
      metadata: { name, type: "user" },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes("duplicate") && !msg.includes("unique constraint")) throw error;
  }

  // Ensure participants
  try {
    await runtime.ensureParticipantInRoom(runtime.agentId, roomId);
    await runtime.ensureParticipantInRoom(entityId, roomId);
  } catch (error) {
    console.warn(`[TestRuntime] Participant setup warning: ${error}`);
  }

  return { userId, entityId, roomId, worldId };
}

/**
 * Debug options for test message processing
 */
export interface TestMessageDebugOptions {
  /** Enable debug tracing for this message */
  enabled: boolean;
  /** Which view to render the trace in */
  renderView?: DebugRenderView;
  /** Store the trace in the global store for later retrieval */
  storeTrace?: boolean;
}

/**
 * Message result from processing
 */
export interface TestMessageResult {
  response: {
    id: string;
    text: string;
    content: Record<string, unknown>;
  } | null;
  didRespond: boolean;
  duration: number;
  error?: string;
  /** Debug trace if debug options enabled */
  debugTrace?: DebugTrace;
  /** Rendered debug markdown if debug options enabled */
  debugMarkdown?: string;
}

/**
 * Options for sending test messages
 */
export interface SendTestMessageOptions {
  /** Timeout for message processing */
  timeoutMs?: number;
  /** Debug options for trace capture */
  debug?: TestMessageDebugOptions;
  /** Stream chunk callback */
  onStreamChunk?: (chunk: string) => Promise<void>;
  /** Reasoning chunk callback */
  onReasoningChunk?: (chunk: string, phase: string) => Promise<void>;
}

/**
 * Send a test message through the production MessageHandler.
 *
 * This uses createMessageHandler which emits MESSAGE_RECEIVED events,
 * properly triggering plugin-assistant's handler.
 */
export async function sendTestMessage(
  runtime: TestRuntime,
  userContext: TestUserContext,
  text: string,
  testData: TestDataSet,
  options: SendTestMessageOptions = {},
): Promise<TestMessageResult> {
  const startTime = Date.now();
  const { timeoutMs = 120000, debug, onStreamChunk, onReasoningChunk } = options;

  // Import debug utilities if debug is enabled
  let getLatestDebugTrace: (() => DebugTrace | undefined) | undefined;
  let renderDebugTrace: ((trace: DebugTrace, view?: DebugRenderView) => string) | undefined;
  let clearDebugTraces: (() => void) | undefined;

  if (debug?.enabled) {
    const debugModule = await import("../../lib/debug");
    getLatestDebugTrace = debugModule.getLatestDebugTrace;
    renderDebugTrace = debugModule.renderDebugTrace;
    clearDebugTraces = debugModule.clearDebugTraces;

    // Clear existing traces before processing to isolate this message's trace
    clearDebugTraces();
  }

  // Import the production message handler
  const { createMessageHandler } = await import("../../lib/eliza/message-handler");
  const { AgentMode } = await import("../../lib/eliza/agent-mode-types");

  // Chat proper UserContext like production does
  const fullUserContext = {
    userId: userContext.userId,
    entityId: userContext.entityId as string,
    organizationId: testData.organization.id,
    agentMode: AgentMode.CHAT,
    apiKey: testData.apiKey.key,
    isAnonymous: false,
    webSearchEnabled: false,
  };

  // Create handler like production does - this is key!
  const handler = createMessageHandler(runtime, fullUserContext);

  let responseMemory: TestMessageResult["response"] = null;
  let didRespond = false;
  let error: string | undefined;

  try {
    const { AgentMode: AgentModeEnum } = await import("../../lib/eliza/agent-mode-types");
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Message processing timeout")), timeoutMs);
        (timeout as { unref?: () => void }).unref?.();
      });

      // Process message through handler - this emits MESSAGE_RECEIVED event
      // which triggers plugin-assistant's handleMessage()
      const result = await Promise.race([
        handler.process({
          roomId: userContext.roomId as string,
          text,
          agentModeConfig: { mode: AgentModeEnum.CHAT },
          onStreamChunk: onStreamChunk
            ? async (chunk) => {
                await onStreamChunk(chunk);
              }
            : undefined,
          onReasoningChunk: onReasoningChunk
            ? async (chunk, phase) => {
                await onReasoningChunk(chunk, phase);
              }
            : undefined,
        }),
        timeoutPromise,
      ]);

      // Extract response from MessageResult
      if (result.message?.content?.text) {
        responseMemory = {
          id: result.message.id as string,
          text: result.message.content.text as string,
          content: result.message.content as Record<string, unknown>,
        };
        didRespond = true;
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } catch (err) {
    error = err instanceof Error ? err.stack || err.message : String(err);
  }

  // Capture debug trace if enabled
  let debugTrace: DebugTrace | undefined;
  let debugMarkdown: string | undefined;

  if (debug?.enabled && getLatestDebugTrace && renderDebugTrace) {
    debugTrace = getLatestDebugTrace();
    if (debugTrace) {
      debugMarkdown = renderDebugTrace(debugTrace, debug.renderView ?? "summary");
    }
  }

  return {
    response: responseMemory,
    didRespond,
    duration: Date.now() - startTime,
    error,
    debugTrace,
    debugMarkdown,
  };
}

/**
 * Get the MCP service from the runtime
 */
export function getMcpService(runtime: TestRuntime): {
  getServers?: () => unknown[];
  getTools?: () => unknown[];
  waitForInitialization?: () => Promise<void>;
} | null {
  return runtime.getService("mcp") as {
    getServers?: () => unknown[];
    getTools?: () => unknown[];
    waitForInitialization?: () => Promise<void>;
  } | null;
}

/**
 * Wait for MCP service to be fully initialized
 */
export async function waitForMcpReady(runtime: TestRuntime, timeoutMs = 10000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const mcpService = getMcpService(runtime);
    if (mcpService) {
      if (mcpService.waitForInitialization) {
        await mcpService.waitForInitialization();
      }
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
