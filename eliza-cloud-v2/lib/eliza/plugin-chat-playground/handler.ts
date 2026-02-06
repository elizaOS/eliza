import {
  asUUID,
  composePromptFromState,
  createUniqueUuid,
  EventType,
  logger,
  MemoryType,
  ModelType,
  type Memory,
  parseKeyValueXml,
  type UUID,
  type Action,
  type IAgentRuntime,
  type State,
  type HandlerCallback,
} from "@elizaos/core";
import type { DialogueMetadata } from "@/lib/types/message-content";
import { v4 } from "uuid";
import {
  chatPlaygroundSystemPrompt,
  chatPlaygroundTemplate,
} from "./prompts/chat-playground-prompts";
import {
  setLatestResponseId,
  clearLatestResponseId,
  isResponseStillValid,
} from "../shared/utils/response-tracking";
import {
  cleanPrompt,
  runEvaluatorsWithTimeout,
  postProcessResponse,
} from "../shared/utils/helpers";
import type { ParsedResponse } from "../shared/utils/parsers";
import type {
  MessageReceivedHandlerParams,
  RunEndedEventPayload,
} from "../shared/types";

/**
 * Simple chat handler with MCP tool support and optional streaming.
 */
export async function handleMessage({
  runtime,
  message,
  callback,
  onStreamChunk,
}: MessageReceivedHandlerParams): Promise<void> {
  const responseId = v4();
  const runId = asUUID(v4());
  const startTime = Date.now();

  if (message.entityId === runtime.agentId) {
    throw new Error("Message is from the agent itself");
  }

  await setLatestResponseId(runtime, message.roomId, responseId);
  await runtime.emitEvent(EventType.RUN_STARTED, {
    runtime,
    source: "chatPlaygroundWorkflow",
    runId,
    messageId: message.id || asUUID(v4()),
    roomId: message.roomId,
    entityId: message.entityId,
    startTime,
    status: "started",
  });

  const originalSystemPrompt = runtime.character.system;

  try {
    runtime.createMemory(message, "messages").catch((e) => {
      logger.warn(`[ChatPlayground] Failed to create memory: ${e}`);
    });

    const state = await runtime.composeState(message, [
      "SUMMARIZED_CONTEXT",
      "RECENT_MESSAGES",
      "LONG_TERM_MEMORY",
      "CHARACTER",
      "MCP",
      "APP_CONFIG",
    ]);

    // Try MCP action first
    if (await checkAndRunMcpAction(runtime, message, state, callback)) {
      await clearLatestResponseId(runtime, message.roomId);
      await runtime.emitEvent(EventType.RUN_ENDED, {
        runtime,
        runId,
        messageId: message.id || asUUID(v4()),
        roomId: message.roomId,
        entityId: message.entityId,
        startTime,
        status: "completed",
        endTime: Date.now(),
        duration: Date.now() - startTime,
        source: "chatPlaygroundWorkflow",
      });
      return;
    }

    runtime.character.system = cleanPrompt(
      composePromptFromState({ state, template: chatPlaygroundSystemPrompt }),
    );

    const prompt = cleanPrompt(
      composePromptFromState({
        state,
        template:
          runtime.character.templates?.chatPlaygroundTemplate ||
          chatPlaygroundTemplate,
      }),
    );

    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      ...(onStreamChunk && {
        stream: true,
        onStreamChunk: async (chunk: string) => {
          await onStreamChunk(chunk, responseId as UUID);
        },
      }),
    });

    const parsedResponse = parseKeyValueXml(response) as ParsedResponse | null;
    if (!parsedResponse?.text) {
      throw new Error("Failed to generate valid response");
    }

    if (!(await isResponseStillValid(runtime, message.roomId, responseId)))
      return;
    await clearLatestResponseId(runtime, message.roomId);

    const processedResponse = postProcessResponse(
      parsedResponse.text,
      message.roomId as string,
    );
    const finalText = processedResponse.text;

    if (callback) {
      await callback({
        text: finalText,
        thought: parsedResponse.thought || "",
        source: "agent",
        inReplyTo: message.id,
      });
    }

    const responseMemory: Memory = {
      id: createUniqueUuid(runtime, (message.id ?? v4()) as UUID),
      entityId: runtime.agentId,
      roomId: message.roomId,
      worldId: message.worldId,
      content: {
        text: finalText,
        thought: parsedResponse.thought || "",
        source: "agent",
        inReplyTo: message.id,
      },
      metadata: {
        type: MemoryType.MESSAGE,
        role: "agent",
        dialogueType: "message",
        visibility: "visible",
        agentMode: "chat",
      } as DialogueMetadata,
    };

    runEvaluatorsWithTimeout(
      runtime,
      message,
      state,
      responseMemory,
      callback,
    ).catch((e) => {
      logger.warn(`[ChatPlayground] Evaluators failed: ${e}`);
    });

    runtime
      .emitEvent(EventType.RUN_ENDED, {
        runtime,
        source: "chatPlaygroundWorkflow",
        runId,
        messageId: message.id || asUUID(v4()),
        roomId: message.roomId,
        entityId: message.entityId,
        startTime,
        status: "completed",
        endTime: Date.now(),
        duration: Date.now() - startTime,
      })
      .catch((e) =>
        logger.debug(`[ChatPlayground] RUN_ENDED emit failed: ${e}`),
      );
  } catch (error) {
    const errorPayload: RunEndedEventPayload = {
      runtime,
      runId,
      messageId: (message.id || asUUID(v4())) as UUID,
      roomId: message.roomId as UUID,
      entityId: message.entityId as UUID,
      startTime,
      status: "error",
      endTime: Date.now(),
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
      source: "chatPlaygroundWorkflow",
    };
    await runtime.emitEvent(EventType.RUN_ENDED, errorPayload as never);
    throw error;
  } finally {
    // Always restore original system prompt, even on early returns or errors
    runtime.character.system = originalSystemPrompt;
  }
}

/**
 * Check for and execute MCP action if available.
 *
 * MCP Debug Flow:
 * 1. Check if MCP provider data exists in state (indicates MCP plugin is loaded)
 * 2. Check if any servers are connected with tools
 * 3. Find and validate CALL_MCP_TOOL action
 * 4. Execute the action if valid
 */
async function checkAndRunMcpAction(
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
  callback?: HandlerCallback,
): Promise<boolean> {
  try {
    // Debug: Log registered actions for MCP troubleshooting
    const registeredActions = runtime.actions?.map((a: Action) => a.name) || [];
    logger.debug(
      `[ChatPlayground/MCP] Registered actions: ${registeredActions.join(", ")}`,
    );

    // Check if MCP data is available in state (from MCP provider)
    const stateData = state.data as Record<string, unknown> | undefined;
    const mcpData = stateData?.providers as Record<string, unknown> | undefined;
    const mcpProvider = mcpData?.MCP as
      | { data?: { mcp?: Record<string, unknown> }; text?: string }
      | undefined;

    // Debug: Log MCP provider state
    if (!mcpProvider) {
      logger.debug(
        "[ChatPlayground/MCP] No MCP provider data in state - MCP plugin may not be loaded",
      );
      return false;
    }

    const mcpServers = mcpProvider?.data?.mcp;
    const serverNames = mcpServers ? Object.keys(mcpServers) : [];
    const hasMcpServers = serverNames.length > 0;

    if (!hasMcpServers) {
      logger.debug(
        "[ChatPlayground/MCP] MCP provider exists but no servers connected. Check character.settings.mcp configuration.",
      );
      return false;
    }

    // Log connected servers and their tools
    logger.info(
      `[ChatPlayground/MCP] MCP servers connected: ${serverNames.join(", ")}`,
    );

    for (const serverName of serverNames) {
      const server = mcpServers?.[serverName] as
        | { status?: string; tools?: Record<string, unknown> }
        | undefined;
      const toolNames = server?.tools ? Object.keys(server.tools) : [];
      logger.info(
        `[ChatPlayground/MCP] Server "${serverName}": status=${server?.status}, tools=[${toolNames.join(", ")}]`,
      );
    }

    // Find the CALL_MCP_TOOL action from registered actions
    const mcpAction = runtime.actions?.find(
      (action: Action) =>
        action.name === "CALL_MCP_TOOL" ||
        action.similes?.includes("CALL_MCP_TOOL"),
    );

    if (!mcpAction) {
      logger.warn(
        "[ChatPlayground/MCP] CALL_MCP_TOOL action NOT found in runtime. " +
          "Ensure @elizaos/plugin-mcp is loaded. " +
          `Available actions: ${registeredActions.join(", ")}`,
      );
      return false;
    }

    // Validate if the action can run (checks if MCP servers are connected with tools)
    const isValid = await mcpAction.validate(runtime, message, state);
    if (!isValid) {
      logger.warn(
        "[ChatPlayground/MCP] CALL_MCP_TOOL validation failed. " +
          "This means servers are listed but none are 'connected' with tools. " +
          "Check MCP server connection status and tool availability.",
      );
      return false;
    }

    logger.info(
      "[ChatPlayground/MCP] CALL_MCP_TOOL action is valid, executing...",
    );

    // Execute the MCP action
    const result = await mcpAction.handler(
      runtime,
      message,
      state,
      {},
      callback,
    );

    // Check result for success
    const actionResult = result as
      | { success?: boolean; data?: { toolName?: string; serverName?: string } }
      | undefined;
    if (actionResult?.success) {
      logger.info(
        `[ChatPlayground/MCP] ✓ MCP action executed successfully - tool: ${actionResult.data?.toolName ?? "unknown"}, server: ${actionResult.data?.serverName ?? "unknown"}`,
      );
      return true;
    }

    logger.debug(
      "[ChatPlayground/MCP] MCP action did not succeed, falling back to regular response",
    );
    return false;
  } catch (error) {
    logger.error(
      "[ChatPlayground/MCP] Error checking/running MCP action:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}
