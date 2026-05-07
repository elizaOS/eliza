import type { ParsedMultiStepDecision } from "../types";

const BUILT_IN_RESPONSE_ACTIONS = new Set(["REPLY", "NONE"]);

type NativeToolCallLike = {
  id?: string;
  type?: string;
  name?: string;
  input?: unknown;
  args?: unknown;
  arguments?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
};

export interface ValidatedMultiStepDecision {
  thought?: string;
  action?: string;
  isFinish?: boolean;
  parameters: Record<string, unknown>;
}

function normalizeBoolean(value: string | boolean | undefined): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  return undefined;
}

function parseParameters(parameters: ParsedMultiStepDecision["parameters"]): {
  value: Record<string, unknown>;
  error?: string;
} {
  if (parameters == null || parameters === "") {
    return { value: {} };
  }

  const parsed =
    typeof parameters === "string"
      ? (() => {
          try {
            return JSON.parse(parameters);
          } catch {
            return undefined;
          }
        })()
      : parameters;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { value: {}, error: "parameters must be a JSON object" };
  }

  return { value: parsed as Record<string, unknown> };
}

export function toNativeActionParams(
  action: string,
  parameters: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const normalizedAction = action.trim().toUpperCase();
  return normalizedAction ? { [normalizedAction]: parameters } : {};
}

export function normalizeCloudActionArgs(
  action: string,
  content: {
    params?: unknown;
    actionParams?: unknown;
    actionInput?: unknown;
  },
): Record<string, unknown> {
  const normalizedAction = action.trim().toUpperCase();
  const candidates = [content.params, content.actionParams, content.actionInput];

  for (const candidate of candidates) {
    const parsed = parseParameters(candidate as ParsedMultiStepDecision["parameters"]);
    if (parsed.error) {
      continue;
    }

    const value = parsed.value;
    const keyedValue = value[normalizedAction];
    if (keyedValue && typeof keyedValue === "object" && !Array.isArray(keyedValue)) {
      return keyedValue as Record<string, unknown>;
    }

    if (Object.keys(value).length > 0 && candidate !== content.params) {
      return value;
    }

    if (
      candidate === content.params &&
      Object.keys(value).length > 0 &&
      !Object.values(value).every((entry) => entry && typeof entry === "object")
    ) {
      return value;
    }
  }

  return {};
}

function parseNativeToolArguments(value: unknown): Record<string, unknown> | undefined {
  const parsed = parseParameters(value as ParsedMultiStepDecision["parameters"]);
  return parsed.error ? undefined : parsed.value;
}

function parseNativeToolCall(call: NativeToolCallLike): ParsedMultiStepDecision | null {
  const functionName = call.function?.name;
  const name =
    typeof functionName === "string"
      ? functionName
      : typeof call.name === "string"
        ? call.name
        : undefined;

  if (!name?.trim()) {
    return null;
  }

  const parameters =
    parseNativeToolArguments(call.function?.arguments) ??
    parseNativeToolArguments(call.arguments) ??
    parseNativeToolArguments(call.input) ??
    parseNativeToolArguments(call.args) ??
    {};

  return {
    action: name,
    parameters,
  };
}

export function parseNativeMultiStepDecision(raw: string): ParsedMultiStepDecision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const value = parsed as Record<string, unknown>;
  const toolCalls = value.tool_calls ?? value.toolCalls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const call = parseNativeToolCall(toolCalls[0] as NativeToolCallLike);
    if (!call) {
      return null;
    }
    return {
      thought: typeof value.thought === "string" ? value.thought : undefined,
      ...call,
      isFinish: value.isFinish as string | boolean | undefined,
    };
  }

  const directAction =
    typeof value.action === "string"
      ? value.action
      : typeof value.name === "string"
        ? value.name
        : undefined;
  if (!directAction) {
    return null;
  }

  return {
    thought: typeof value.thought === "string" ? value.thought : undefined,
    action: directAction,
    parameters:
      parseNativeToolArguments(value.parameters) ??
      parseNativeToolArguments(value.input) ??
      parseNativeToolArguments(value.args) ??
      {},
    isFinish: value.isFinish as string | boolean | undefined,
  };
}

export function getAvailableActionNames(actionsData: unknown): Set<string> {
  if (!Array.isArray(actionsData)) {
    return new Set();
  }

  return new Set(
    actionsData
      .map((action) => {
        if (!action || typeof action !== "object") {
          return null;
        }

        const name = (action as { name?: unknown }).name;
        return typeof name === "string" && name.trim() ? name.trim() : null;
      })
      .filter((name): name is string => Boolean(name)),
  );
}

export function validateMultiStepDecision(
  parsedStep: ParsedMultiStepDecision,
  availableActionNames: Set<string>,
): { decision?: ValidatedMultiStepDecision; error?: string } {
  const action = typeof parsedStep.action === "string" ? parsedStep.action.trim() : undefined;
  const normalizedIsFinish = normalizeBoolean(parsedStep.isFinish);

  if (parsedStep.isFinish !== undefined && normalizedIsFinish === undefined) {
    return { error: "isFinish must be true or false" };
  }

  const parsedParameters = parseParameters(parsedStep.parameters);
  if (parsedParameters.error) {
    return { error: parsedParameters.error };
  }

  if (!action) {
    if (normalizedIsFinish === true) {
      return {
        decision: {
          thought: parsedStep.thought,
          isFinish: true,
          parameters: parsedParameters.value,
        },
      };
    }

    return { error: "decision is missing an action" };
  }

  if (
    action !== "FINISH" &&
    !BUILT_IN_RESPONSE_ACTIONS.has(action) &&
    !availableActionNames.has(action)
  ) {
    return { error: `unknown action: ${action}` };
  }

  return {
    decision: {
      thought: parsedStep.thought,
      action,
      isFinish: normalizedIsFinish,
      parameters: parsedParameters.value,
    },
  };
}
