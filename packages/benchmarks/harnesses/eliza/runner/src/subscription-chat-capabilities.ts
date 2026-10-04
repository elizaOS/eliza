/**
 * Narrows the generic OpenAI-compatible plugin to capabilities the Claude
 * subscription gateway actually serves. The resulting plugin performs chat
 * generation and local tokenization only: it has no startup probe, media,
 * research, or embedding path that could fabricate support or hit a 404.
 * Lifecycle mode additionally preserves the shared optional-field TASKS
 * contract and carries schema-only evaluator output through a native capture
 * tool because the subscription gateway intentionally supports tools, not
 * OpenAI response_format.
 */

import {
  ElizaError,
  HANDLE_RESPONSE_TOOL_NAME,
  type JSONSchema,
  ModelType,
  type Plugin,
} from "@elizaos/core";

export const LIFECYCLE_STRUCTURED_RESPONSE_TOOL_NAME =
  HANDLE_RESPONSE_TOOL_NAME;

export interface ClaudeSubscriptionChatOnlyPluginOptions {
  lifecycleStructuredResponseTool?: boolean;
  lifecycleTasksToolSchema?: JSONSchema;
}

type ResponseHandler = NonNullable<
  NonNullable<Plugin["models"]>[typeof ModelType.RESPONSE_HANDLER]
>;
type ActionPlannerHandler = NonNullable<
  NonNullable<Plugin["models"]>[typeof ModelType.ACTION_PLANNER]
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidLifecycleStructuredResponse(
  reason: string,
  cause?: unknown,
): ElizaError {
  return new ElizaError(
    `Lifecycle structured response capture failed: ${reason}`,
    {
      code: "BENCHMARK_LIFECYCLE_STRUCTURED_RESPONSE_INVALID",
      context: { reason },
      ...(cause === undefined ? {} : { cause }),
      severity: "ephemeral",
    },
  );
}

async function lifecycleStructuredResponseText(raw: unknown): Promise<string> {
  if (!isRecord(raw) || !("toolCalls" in raw)) {
    throw invalidLifecycleStructuredResponse(
      "provider result omitted native tool calls",
    );
  }
  let toolCalls: unknown;
  try {
    toolCalls = await raw.toolCalls;
  } catch (cause) {
    // error-policy:J2 streaming handlers expose native calls as a companion
    // promise; preserve its rejection while translating at this boundary.
    throw invalidLifecycleStructuredResponse(
      "provider native tool calls rejected",
      cause,
    );
  }
  if (!Array.isArray(toolCalls)) {
    throw invalidLifecycleStructuredResponse(
      "provider result omitted native tool calls",
    );
  }
  if (toolCalls.length !== 1) {
    throw invalidLifecycleStructuredResponse(
      `provider returned ${toolCalls.length} native tool calls; expected exactly one`,
    );
  }
  const call = toolCalls[0];
  if (!isRecord(call)) {
    throw invalidLifecycleStructuredResponse(
      "provider returned a non-object native tool call",
    );
  }
  const fn = isRecord(call.function) ? call.function : {};
  const toolName = [call.name, call.toolName, fn.name].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (toolName !== LIFECYCLE_STRUCTURED_RESPONSE_TOOL_NAME) {
    throw invalidLifecycleStructuredResponse(
      "provider returned the wrong native structured-response tool",
    );
  }

  let parsedArguments: unknown =
    call.arguments ?? call.input ?? call.args ?? call.params ?? fn.arguments;
  if (typeof parsedArguments === "string") {
    try {
      parsedArguments = JSON.parse(parsedArguments) as unknown;
    } catch (cause) {
      // error-policy:J2 provider tool arguments are untrusted at this boundary;
      // retain the parse cause while surfacing a typed, content-free failure.
      throw invalidLifecycleStructuredResponse(
        "provider returned malformed JSON tool arguments",
        cause,
      );
    }
  }
  if (!isRecord(parsedArguments)) {
    throw invalidLifecycleStructuredResponse(
      "provider returned non-object tool arguments",
    );
  }
  try {
    return JSON.stringify(parsedArguments);
  } catch (cause) {
    // error-policy:J2 the provider boundary must reject non-JSON argument
    // graphs without leaking their contents into logs or error messages.
    throw invalidLifecycleStructuredResponse(
      "provider returned non-serializable tool arguments",
      cause,
    );
  }
}

function lifecycleStructuredResponseHandler(
  handler: ResponseHandler,
): ResponseHandler {
  return async (runtime, params) => {
    if (
      params.responseSchema === undefined ||
      (params.tools?.length ?? 0) > 0
    ) {
      return handler(runtime, params);
    }

    const { responseSchema, ...nativeToolParams } = params;
    const raw: unknown = await handler(runtime, {
      ...nativeToolParams,
      tools: [
        {
          name: LIFECYCLE_STRUCTURED_RESPONSE_TOOL_NAME,
          description:
            "Return the structured response required by the calling Eliza runtime.",
          parameters: responseSchema,
          strict: false,
        },
      ],
      toolChoice: "required",
    });
    return lifecycleStructuredResponseText(raw);
  };
}

function lifecycleActionPlannerHandler(
  handler: ActionPlannerHandler,
  tasksToolSchema: JSONSchema,
): ActionPlannerHandler {
  return async (runtime, params) => {
    if (!params.tools) {
      return handler(runtime, params);
    }
    const taskTools = params.tools.filter(
      (tool) => tool.name.trim().toUpperCase() === "TASKS",
    );
    if (taskTools.length !== 1) {
      throw new ElizaError(
        `Lifecycle action planner requires exactly one TASKS tool; found ${taskTools.length}`,
        {
          code: "BENCHMARK_LIFECYCLE_TASKS_TOOL_INVALID",
          context: { tasksToolCount: taskTools.length },
          severity: "ephemeral",
        },
      );
    }
    return handler(runtime, {
      ...params,
      tools: params.tools.map((tool) =>
        tool === taskTools[0]
          ? {
              ...tool,
              parameters: tasksToolSchema,
              strict: false,
            }
          : tool,
      ),
    });
  };
}

export const CLAUDE_SUBSCRIPTION_CHAT_MODEL_TYPES = [
  ModelType.TEXT_NANO,
  ModelType.TEXT_SMALL,
  ModelType.TEXT_MEDIUM,
  ModelType.TEXT_LARGE,
  ModelType.TEXT_MEGA,
  ModelType.RESPONSE_HANDLER,
  ModelType.ACTION_PLANNER,
] as const;

export const CLAUDE_SUBSCRIPTION_MODEL_TYPES = [
  ModelType.TEXT_TOKENIZER_ENCODE,
  ModelType.TEXT_TOKENIZER_DECODE,
  ...CLAUDE_SUBSCRIPTION_CHAT_MODEL_TYPES,
] as const;

interface ModelRegistration {
  provider?: string;
}

export function assertClaudeSubscriptionModelRegistry(
  registry: ReadonlyMap<string, readonly ModelRegistration[]> | undefined,
): void {
  const summary = Object.fromEntries(
    [...(registry?.entries() ?? [])].map(([modelType, registrations]) => [
      modelType,
      registrations.map((registration) => registration.provider ?? "unknown"),
    ]),
  );
  const allowedTypes = new Set<string>(CLAUDE_SUBSCRIPTION_MODEL_TYPES);
  const unexpectedTypes = [...(registry?.entries() ?? [])]
    .filter(
      ([modelType, registrations]) =>
        registrations.length > 0 && !allowedTypes.has(modelType),
    )
    .map(([modelType]) => modelType);

  for (const modelType of CLAUDE_SUBSCRIPTION_MODEL_TYPES) {
    const registrations = registry?.get(modelType) ?? [];
    if (registrations.length !== 1 || registrations[0]?.provider !== "openai") {
      throw new Error(
        `Claude-subscription capability profile requires exactly one openai handler for ${modelType}; registry=${JSON.stringify(summary)}`,
      );
    }
  }
  if (unexpectedTypes.length > 0) {
    throw new Error(
      `Claude-subscription capability profile registered unsupported model types ${JSON.stringify(unexpectedTypes)}; registry=${JSON.stringify(summary)}`,
    );
  }
}

export function claudeSubscriptionChatOnlyPlugin(
  plugin: Plugin,
  options: ClaudeSubscriptionChatOnlyPluginOptions = {},
): Plugin {
  const {
    init: _init,
    models: sourceModels,
    tests: _tests,
    ...basePlugin
  } = plugin;
  for (const modelType of CLAUDE_SUBSCRIPTION_MODEL_TYPES) {
    if (typeof sourceModels?.[modelType] !== "function") {
      throw new Error(
        `OpenAI-compatible plugin is missing required Claude-subscription handler ${modelType}`,
      );
    }
  }
  const responseHandler = sourceModels?.[ModelType.RESPONSE_HANDLER];
  if (!responseHandler) {
    throw invalidLifecycleStructuredResponse(
      "OpenAI-compatible plugin omitted its response handler",
    );
  }
  const actionPlannerHandler = sourceModels?.[ModelType.ACTION_PLANNER];
  if (!actionPlannerHandler) {
    throw new ElizaError(
      "OpenAI-compatible plugin omitted its Claude-subscription action planner handler",
      {
        code: "BENCHMARK_SUBSCRIPTION_ACTION_PLANNER_MISSING",
        severity: "ephemeral",
      },
    );
  }
  const models: Plugin["models"] = {
    [ModelType.TEXT_TOKENIZER_ENCODE]:
      sourceModels?.[ModelType.TEXT_TOKENIZER_ENCODE],
    [ModelType.TEXT_TOKENIZER_DECODE]:
      sourceModels?.[ModelType.TEXT_TOKENIZER_DECODE],
    [ModelType.TEXT_NANO]: sourceModels?.[ModelType.TEXT_NANO],
    [ModelType.TEXT_SMALL]: sourceModels?.[ModelType.TEXT_SMALL],
    [ModelType.TEXT_MEDIUM]: sourceModels?.[ModelType.TEXT_MEDIUM],
    [ModelType.TEXT_LARGE]: sourceModels?.[ModelType.TEXT_LARGE],
    [ModelType.TEXT_MEGA]: sourceModels?.[ModelType.TEXT_MEGA],
    [ModelType.RESPONSE_HANDLER]:
      options.lifecycleStructuredResponseTool === true
        ? lifecycleStructuredResponseHandler(responseHandler)
        : responseHandler,
    [ModelType.ACTION_PLANNER]: options.lifecycleTasksToolSchema
      ? lifecycleActionPlannerHandler(
          actionPlannerHandler,
          options.lifecycleTasksToolSchema,
        )
      : actionPlannerHandler,
  };

  return {
    ...basePlugin,
    description: `${plugin.description} (Claude subscription chat-only capability profile)`,
    models,
  };
}
