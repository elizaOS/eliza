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

function numberSetting(
  runtime: IAgentRuntime,
  key: string,
  fallback: number,
): number {
  const env =
    typeof globalThis === "object" && "process" in globalThis
      ? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      : undefined;
  const raw = runtime.getSetting?.(key) ?? env?.[key];
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function unrefTimer(handle: ReturnType<typeof setTimeout>): void {
  (handle as { unref?: () => void }).unref?.();
}

type LastGoodValidation = {
  actions: Action[];
  discoverableToolCount: number;
  createdAt: number;
};

let lastGoodValidation: LastGoodValidation | null = null;

function getMessageText(message: Memory): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return typeof content?.text === "string" ? content.text : "";
}

function isImageGenerationRequest(message: Memory): boolean {
  const text = getMessageText(message);
  return (
    /\b(generate|create|make|draw|render|produce|publish)\b[\s\S]{0,100}\b(image|picture|poster|meme|png|photo|illustration|ad creative|creative pack|ad pack|advertisement|campaign creative)\b/i.test(
      text,
    ) ||
    /\b(image|picture|poster|meme|png|photo|illustration|ad creative|creative pack|ad pack|advertisement|campaign creative)\b[\s\S]{0,100}\b(generate|create|make|draw|render|produce|publish)\b/i.test(
      text,
    ) ||
    /\bfal\b/i.test(text)
  );
}

function keepAction(action: Action, wanted: Set<string>): boolean {
  const name = action.name.trim().toUpperCase();
  const similes = (action.similes ?? []).map((value) => String(value).trim().toUpperCase());
  return wanted.has(name) || similes.some((simile) => wanted.has(simile));
}

function narrowActionsForIntent(actions: Action[], message: Memory): Action[] {
  if (!isImageGenerationRequest(message)) {
    return actions;
  }

  const wanted = new Set([
    "GENERATE_MEDIA",
    "GENERATE_IMAGE",
    "CREATE_IMAGE",
    "CAPTURE_IMAGE",
    "PRODUCE_AGENT_AD_CREATIVE",
    "PUBLISH_AGENT_AD_PACK",
    "MANAGE_AGENT_ADS",
    "REPLY",
    "NONE",
    "FINISH",
  ]);
  const narrowed = actions.filter((action) => keepAction(action, wanted));
  return narrowed.length > 0 ? narrowed : actions;
}

async function validateActionFast(
  action: Action,
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
  timeoutMs: number,
): Promise<Action | null> {
  const timeout = new Promise<null>((resolve) => {
    const handle = setTimeout(() => resolve(null), timeoutMs);
    unrefTimer(handle);
  });

  const validation = (async () => {
    try {
      return (await action.validate(runtime, message, state)) ? action : null;
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      logger.error(`[ACTIONS] validate error: ${action.name}`, errorMessage);
      return null;
    }
  })();

  return Promise.race([validation, timeout]);
}

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
        const actionValidateTimeoutMs = numberSetting(runtime, "ACTIONS_VALIDATE_TIMEOUT_MS", 250);
        const providerValidationBudgetMs = numberSetting(runtime, "ACTIONS_PROVIDER_VALIDATION_BUDGET_MS", 1200);
        const lastGoodCacheTtlMs = numberSetting(runtime, "ACTIONS_LAST_GOOD_CACHE_TTL_MS", 120_000);
        const freshLastGood =
          lastGoodValidation && Date.now() - lastGoodValidation.createdAt < lastGoodCacheTtlMs
            ? lastGoodValidation
            : null;

        let actionsData: Action[];
        if (isImageGenerationRequest(message)) {
          // Media/ad turns need a deterministic tiny catalog. Do this before
          // consulting the last-good full cache so we do not spend the Discord
          // reply window filtering/formatting hundreds of unrelated actions
          // and then hide the image/ad action behind a provider timeout.
          actionsData = narrowActionsForIntent(runtime.actions, message);
        } else if (freshLastGood) {
          actionsData = freshLastGood.actions;
        } else {
          const validation = Promise.all(
            runtime.actions.map((action: Action) =>
              validateActionFast(action, runtime, message, state, actionValidateTimeoutMs),
            ),
          ).then((actions) => actions.filter((a): a is Action => a !== null));

          const timed = new Promise<"timeout">((resolve) => {
            const handle = setTimeout(() => resolve("timeout"), providerValidationBudgetMs);
            unrefTimer(handle);
          });

          const validationResult = await Promise.race([validation, timed]);
          if (validationResult === "timeout") {
            logger.warn(
              `[ACTIONS] validation exceeded ${providerValidationBudgetMs}ms; using unvalidated action catalog for this turn`,
            );
            actionsData = runtime.actions;
          } else {
            actionsData = validationResult;
          }
        }

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

        if (actionsData.length > 0) {
          lastGoodValidation = {
            actions: actionsData,
            discoverableToolCount,
            createdAt: Date.now(),
          };
        }

        cached = { actions: actionsData, discoverableToolCount };
        if (cacheKey) {
          const timeoutHandle = setTimeout(() => validationCache.delete(cacheKey), 120_000);
          unrefTimer(timeoutHandle);
          cached.timeoutHandle = timeoutHandle;
          validationCache.set(cacheKey, cached);
        }
      }

      const actionsData = narrowActionsForIntent(
        filterActionsByRouting(cached.actions, getContextRoutingFromMessage(message)),
        message,
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
