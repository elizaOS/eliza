/** Narrows the agent runtime to just its cache methods for LifeOps helpers that only cache. */
import type { IAgentRuntime } from "@elizaos/core";

export type RuntimeCacheLike = Pick<
  IAgentRuntime,
  "getCache" | "setCache" | "deleteCache"
>;

export function asCacheRuntime(runtime: IAgentRuntime): RuntimeCacheLike {
  return runtime;
}
