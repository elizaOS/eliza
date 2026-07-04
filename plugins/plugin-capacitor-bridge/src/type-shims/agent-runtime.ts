/**
 * Type-only shim for the agent runtime bootstrap used by the iOS bridge.
 *
 * The actual `bootElizaRuntime` implementation is resolved dynamically in the
 * bundled mobile host; this shim keeps local typechecking independent of agent
 * build artifacts.
 */

import type { IAgentRuntime } from "@elizaos/core";

export function bootElizaRuntime(): Promise<IAgentRuntime> {
	throw new Error("Type shim only");
}
