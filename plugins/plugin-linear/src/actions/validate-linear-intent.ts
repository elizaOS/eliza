import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { hasLinearAccountConfig } from "../accounts";

export interface LinearIntentValidationSpec {
  readonly keywords: readonly string[];
  /** Alternation body only, e.g. `clear|linear|activity` for `/\b(?:…)\b/i`. */
  readonly regexAlternation: string;
}

/**
 * Shared action validator: hard availability only. Intent/keyword routing is
 * handled by action retrieval, while this confirms Linear is configured.
 */
export async function validateLinearActionIntent(
  runtime: IAgentRuntime,
  _message: Memory,
  _state: State | undefined,
  _spec: LinearIntentValidationSpec
): Promise<boolean> {
  try {
    return hasLinearAccountConfig(runtime);
  } catch {
    return false;
  }
}
