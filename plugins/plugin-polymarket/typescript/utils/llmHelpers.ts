import { composePromptFromState, type IAgentRuntime, ModelType, type State } from "@elizaos/core";
import { LLM_CALL_TIMEOUT_MS } from "../constants";

export async function callLLMWithTimeout<T>(
  runtime: IAgentRuntime,
  state: State | undefined,
  template: string,
  _actionName: string,
  timeoutMs: number = LLM_CALL_TIMEOUT_MS
): Promise<T | null> {
  const composedPrompt = composePromptFromState({
    state: state ?? ({} as State),
    template,
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`LLM call timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    const response = await Promise.race([
      runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: composedPrompt,
      }),
      timeoutPromise,
    ]);

    if (!response) {
      return null;
    }

    const text = typeof response === "string" ? response : String(response);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as T;
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse LLM response as JSON: ${error.message}`);
    }
    throw error;
  }
}

export async function extractFieldFromLLM<T>(
  runtime: IAgentRuntime,
  state: State | undefined,
  template: string,
  fieldName: string,
  actionName: string
): Promise<T | null> {
  const result = await callLLMWithTimeout<Record<string, unknown>>(
    runtime,
    state,
    template,
    actionName
  );

  if (!result) {
    return null;
  }

  if (fieldName in result) {
    return result[fieldName] as T;
  }

  return null;
}

export function isLLMError<T extends object>(
  response: T | null
): response is T & { error: string } {
  return (
    response !== null &&
    typeof response === "object" &&
    "error" in response &&
    typeof (response as { error?: unknown }).error === "string"
  );
}
