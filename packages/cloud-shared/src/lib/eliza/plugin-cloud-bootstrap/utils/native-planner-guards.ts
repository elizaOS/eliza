import { parseJSONObjectFromText } from "@elizaos/core";
import type { ParsedNativePlannerDecision } from "../types";

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

export interface ValidatedNativePlannerDecision {
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

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseParameters(parameters: ParsedNativePlannerDecision["parameters"]): {
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
    const parsed = parseParameters(candidate as ParsedNativePlannerDecision["parameters"]);
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
  const parsed = parseParameters(value as ParsedNativePlannerDecision["parameters"]);
  return parsed.error ? undefined : parsed.value;
}

function parseNativeToolCall(call: NativeToolCallLike): ParsedNativePlannerDecision | null {
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

export function parseNativePlannerDecision(raw: string): ParsedNativePlannerDecision | null {
  const parsed = parseJSONObjectFromText(raw);

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const value = parsed as Record<string, unknown>;
  const thought = getNonEmptyString(value.thought);
  const messageToUser = getNonEmptyString(
    value.messageToUser ?? value.message_to_user ?? value.text ?? value.response,
  );
  const toolCalls = value.tool_calls ?? value.toolCalls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const call = parseNativeToolCall(toolCalls[0] as NativeToolCallLike);
    if (!call) {
      return null;
    }
    return {
      thought,
      ...call,
      isFinish: value.isFinish as string | boolean | undefined,
    };
  }

  if (Array.isArray(toolCalls) && toolCalls.length === 0 && messageToUser) {
    return {
      thought,
      action: "FINISH",
      parameters: { response: messageToUser },
      isFinish: true,
    };
  }

  const directAction =
    typeof value.action === "string"
      ? value.action
      : typeof value.name === "string"
        ? value.name
        : undefined;
  if (!directAction) {
    if (messageToUser) {
      return {
        thought,
        action: "FINISH",
        parameters: { response: messageToUser },
        isFinish: true,
      };
    }
    return null;
  }

  return {
    thought,
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

export function validateNativePlannerDecision(
  parsedStep: ParsedNativePlannerDecision,
  availableActionNames: Set<string>,
): { decision?: ValidatedNativePlannerDecision; error?: string } {
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
