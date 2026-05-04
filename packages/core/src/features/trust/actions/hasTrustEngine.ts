import type { IAgentRuntime } from "../../../types/index.ts";

export function hasTrustEngine(runtime: IAgentRuntime): boolean {
	return !!runtime.getService("trust-engine");
}
