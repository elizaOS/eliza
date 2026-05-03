import { useStewardContext } from "../provider.js";
import type { StewardContextValue } from "../types.js";

/**
 * Core context hook — access client, agentId, features, theme.
 */
export function useSteward(): StewardContextValue {
  return useStewardContext();
}
