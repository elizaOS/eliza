import type { IAgentRuntime } from "@elizaos/core";

export type RuntimeCacheLike = Pick<
  IAgentRuntime,
  "getCache" | "setCache" | "deleteCache"
>;

export function asCacheRuntime(runtime: IAgentRuntime): RuntimeCacheLike {
  return runtime;
}
