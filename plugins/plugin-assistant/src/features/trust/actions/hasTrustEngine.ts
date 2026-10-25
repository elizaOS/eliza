/** Availability guard for the TRUST action: true when the `trust-engine` service is registered on the runtime. */

import type { IAgentRuntime } from "@elizaos/core";

export function hasTrustEngine(runtime: IAgentRuntime): boolean {
  return !!runtime.getService("trust-engine");
}
