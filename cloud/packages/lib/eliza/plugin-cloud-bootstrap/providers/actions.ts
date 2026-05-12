/** ACTIONS Provider - Provides available actions with parameter schemas to the LLM. */
import type { Action, IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { addHeader, logger } from "@elizaos/core";
import { filterActionsByRouting, getContextRoutingFromMessage } from "../utils/context-routing";

const HIDDEN_NATIVE_PLANNER_ACTIONS = new Set(["FINISH", "REPLY", "NONE"]);

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

type McpTier2IndexService = {
  getTier2Index?: () => { getToolCount: () => number };
};

function hasTier2IndexService(value: unknown): value is McpTier2IndexService {
  return typeof value === "object" && value !== null && "getTier2Index" in value;
}

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

function formatNativeToolCatalog(actions: Action[]): string {
  return JSON.stringify(buildNativeToolDefinitions(actions), null, 2);
}

function buildFallbackActionsProviderResult() {
  return {
    data: { actionsData: [], nativeTools: [] },
    values: {
      actionNames: "",
      actionExamples: "",
      actionsWithDescriptions: "",
      actionsWithParams: "",
      nativeToolsJson: "[]",
      discoverableToolCount: "",
    },
    text: "",
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
  contexts: ["general", "agent_internal"],
  contextGate: { anyOf: ["general", "agent_internal"] },
  cacheStable: true,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },

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
          const mcpSvc = runtime.getService("mcp");
          if (hasTier2IndexService(mcpSvc) && typeof mcpSvc.getTier2Index === "function") {
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
      ).filter((action) => !HIDDEN_NATIVE_PLANNER_ACTIONS.has(action.name.trim().toUpperCase()));
      const discoverableToolCount = cached.discoverableToolCount;
      const hasActions = actionsData.length > 0;
      const nativeToolsJson = hasActions ? formatNativeToolCatalog(actionsData) : "[]";
      const actionNames = actionsData.map((action) => action.name).join(", ");
      const actionsWithParams = hasActions
        ? addHeader("# Available Native Tools", nativeToolsJson)
        : "";

      return {
        data: { actionsData, nativeTools: buildNativeToolDefinitions(actionsData) },
        values: {
          actionNames,
          actionExamples: "",
          actionsWithDescriptions: hasActions
            ? addHeader("# Available Native Tools", nativeToolsJson)
            : "",
          actionsWithParams,
          nativeToolsJson,
          discoverableToolCount: discoverableToolCount > 0 ? String(discoverableToolCount) : "",
        },
        text: hasActions
          ? [
              addHeader("# Native Tool Names", actionNames),
              actionsWithParams,
              addHeader("# Native Tool Summaries", formatActionsWithoutParams(actionsData)),
            ].join("\n\n")
          : "",
      };
    } catch (error) {
      logger.error(
        `[ACTIONS] provider fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      return buildFallbackActionsProviderResult();
    }
  },
};
