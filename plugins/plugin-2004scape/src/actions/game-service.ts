import type { IAgentRuntime } from "@elizaos/core";
import type { RsSdkGameService } from "../services/game-service.js";

export function getRsSdkGameService(
  runtime: IAgentRuntime,
): RsSdkGameService | null {
  return runtime.getService<RsSdkGameService>("rs_2004scape");
}
