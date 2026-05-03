import type { ParsedMultiStepDecision } from "../types";

const BUILT_IN_RESPONSE_ACTIONS = new Set(["REPLY", "NONE"]);

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
