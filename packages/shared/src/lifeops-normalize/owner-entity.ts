import {
  type IAgentRuntime,
  resolveOwnerEntityIdOrDefault,
} from "@elizaos/core";
import { requireAgentId } from "./service-normalize.js";

/**
 * Owner-entity scope for LifeOps rows: the core `resolveOwnerEntityIdOrDefault`
 * precedence (configured canonical owner, else the agent-id seed), guarded by
 * `requireAgentId` so a runtime without an id fails as a 500 instead of scoping
 * rows under a seed derived from `undefined`. Every LifeOps surface that reads,
 * writes, or schedules owner-scoped rows must go through this — the chat write
 * path, pendant and PA routes, and the scheduler share the same core helper —
 * or rows written on one surface become invisible to the others.
 */
export function defaultOwnerEntityId(runtime: IAgentRuntime): string {
  requireAgentId(runtime);
  return resolveOwnerEntityIdOrDefault(runtime);
}
