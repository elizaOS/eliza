import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { hasLinearAccountConfig } from "../accounts";

/**
 * Shared action validator: hard availability only. Intent/keyword routing is
 * handled by action retrieval, while this confirms Linear is configured.
 */
export async function validateLinearActionIntent(
  runtime: IAgentRuntime,
  _message: Memory,
  _state: State | undefined
): Promise<boolean> {
  try {
    return hasLinearAccountConfig(runtime);
  } catch {
    return false;
  }
}
