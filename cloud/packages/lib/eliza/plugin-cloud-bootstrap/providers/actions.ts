/** ACTIONS Provider - Provides available actions with parameter schemas to the LLM. */
import type { Action, IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { addHeader, composeActionExamples, formatActionNames, logger } from "@elizaos/core";
import { filterActionsByRouting, getContextRoutingFromMessage } from "../utils/context-routing";

function formatActionsWithoutParams(actions: Action[]): string {
  return actions.map((a) => `## ${a.name}\n${a.description}`).join("\n\n---\n\n");
}

type ActionWithOptionalParams = Action & {
  parameters?: Array<{
    name: string;
    required?: boolean;
    description: string;
    schema: { type: string; [key: string]: unknown };
  }>;
};

type NativeToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

function buildNativeToolDefinition(action: Action): NativeToolDefinition {
  const params = (action as ActionWithOptionalParams).parameters ?? [];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of params) {
    properties[param.name] = {
      ...param.schema,
      description: param.description,
    };
    if (param.required) {
      required.push(param.name);
    }
  }

  return {
    type: "function",
    function: {
      name: action.name,
      description: action.description,
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: params.length === 0,
      },
    },
  };
}

function buildNativeToolDefinitions(actions: Action[]): NativeToolDefinition[] {
  return actions.map(buildNativeToolDefinition);
}

function formatActionsWithParams(actions: Action[]): string {
  return actions
    .map((action) => {
      const params = (action as ActionWithOptionalParams).parameters;
      let formatted = `## ${action.name}\n${action.description}`;

      if (!params || params.length === 0) {
        return formatted + "\n\n**Parameters:** None (can be called directly without parameters)";
      }

      formatted += "\n\n**Parameters:**";
      for (const def of params) {
        const required = def.required ? "(required)" : "(optional)";
        formatted += `\n- \`${def.name}\` ${required}: ${def.schema.type} - ${def.description}`;
      }
      return formatted;
    })
    .join("\n\n---\n\n");
}

function safeComposeActionExamples(actions: Action[], count: number): string {
  try {
    return composeActionExamples(actions, count);
  } catch (error) {
    logger.warn(
      `[ACTIONS] Failed to compose action examples: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "";
  }
}

function buildFallbackActionsProviderResult() {
  const actionsWithParams = addHeader(
    "# Available Actions (with parameter schemas)",
    [
      "## FINISH\nComplete the task and respond to the user. Provide the final response in character.\n\n**Parameters:**\n- `response` (required): string - Final response to the user.",
      "## REPLY\nReply directly to the user.\n\n**Parameters:**\n- `text` (optional): string - Response text to send.",
      "## NONE\nRespond without taking an additional tool action.\n\n**Parameters:** None (can be called directly without parameters)",
    ].join("\n\n---\n\n"),
  );

  return {
    data: { actionsData: [], nativeTools: [] },
    values: {
      actionNames: "Possible response actions: FINISH, REPLY, NONE",
      actionExamples: "",
      actionsWithDescriptions: actionsWithParams,
      actionsWithParams,
      discoverableToolCount: "",
    },
    text: actionsWithParams,
  };
}

/**
 * Per-message cache for action validation results.
 * Avoids re-validating 50-100+ actions on every composeState() call
 * within the same message processing cycle (called 5-9 times).
 */
type ValidationCacheEntry = {
  actions: Action[];
  discoverableToolCount: number;
  timeoutHandle?: ReturnType<typeof setTimeout>;
};

const validationCache = new Map<string, ValidationCacheEntry>();

/** Invalidate cached validation for a message (e.g., after SEARCH_ACTIONS registers new tools). */
export function invalidateActionValidationCache(messageId: string): void {
  const cached = validationCache.get(messageId);
  if (cached?.timeoutHandle) {
    clearTimeout(cached.timeoutHandle);
  }
  validationCache.delete(messageId);
}

export const actionsProvider: Provider = {
  name: "ACTIONS",
  description: "Available actions with parameter schemas",
  position: -1,

  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    try {
      const cacheKey = message.id ? String(message.id) : null;
      let cached = cacheKey ? validationCache.get(cacheKey) : undefined;

      if (!cached) {
        const actionsData = (
          await Promise.all(
            runtime.actions.map(async (action: Action) => {
              try {
                return (await action.validate(runtime, message, state)) ? action : null;
              } catch (e) {
                const errorMessage = e instanceof Error ? e.message : String(e);
                logger.error(`[ACTIONS] validate error: ${action.name}`, errorMessage);
                return null;
              }
            }),
          )
        ).filter((a): a is Action => a !== null);

        let discoverableToolCount = 0;
        try {
          const mcpSvc = runtime.getService("mcp") as unknown as
            | { getTier2Index?: () => { getToolCount: () => number } }
            | undefined;
          if (mcpSvc && typeof mcpSvc.getTier2Index === "function") {
            const index = mcpSvc.getTier2Index();
            const count = index?.getToolCount?.();
            if (typeof count === "number") discoverableToolCount = count;
          }
        } catch {
          /* MCP service may not be available */
        }

        cached = { actions: actionsData, discoverableToolCount };
        if (cacheKey) {
          const timeoutHandle = setTimeout(() => validationCache.delete(cacheKey), 120_000);
          if (typeof timeoutHandle === "object" && typeof timeoutHandle?.unref === "function") {
            timeoutHandle.unref();
          }
          cached.timeoutHandle = timeoutHandle;
          validationCache.set(cacheKey, cached);
        }
      }

      const actionsData = filterActionsByRouting(
        cached.actions,
        getContextRoutingFromMessage(message),
      );
      const discoverableToolCount = cached.discoverableToolCount;
      const hasActions = actionsData.length > 0;
      const actionNames = `Possible response actions: ${formatActionNames(actionsData)}`;
      const actionExamples = hasActions ? safeComposeActionExamples(actionsData, 10) : "";

      return {
        data: { actionsData, nativeTools: buildNativeToolDefinitions(actionsData) },
        values: {
          actionNames,
          actionExamples: actionExamples ? addHeader("# Action Examples", actionExamples) : "",
          actionsWithDescriptions: hasActions
            ? addHeader("# Available Actions", formatActionsWithoutParams(actionsData))
            : "",
          actionsWithParams: hasActions
            ? addHeader(
                "# Available Actions (with parameter schemas)",
                formatActionsWithParams(actionsData),
              )
            : "",
          discoverableToolCount: discoverableToolCount > 0 ? String(discoverableToolCount) : "",
        },
        text: hasActions
          ? [
              actionNames,
              addHeader("# Available Actions", formatActionsWithoutParams(actionsData)),
              actionExamples ? addHeader("# Action Examples", actionExamples) : "",
            ].join("\n\n")
          : actionNames,
      };
    } catch (error) {
      logger.error(
        `[ACTIONS] provider fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      return buildFallbackActionsProviderResult();
    }
  },
};
