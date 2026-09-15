/** Exposes the host-configured login client and presentation settings from React context. */
import { useLoginContext } from "../provider.js";
import type { LoginContextValue } from "../types.js";

/**
 * Core context hook — access client, agentId, features, theme.
 */
export function useLogin(): LoginContextValue {
  return useLoginContext();
}
