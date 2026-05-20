/**
 * @packageDocumentation
 * @module @feed/a2a
 *
 * A2A Protocol Implementation for Feed
 *
 * Feed implements the official A2A (Agent-to-Agent) protocol using @a2a-js/sdk.
 * All A2A operations use the standard message/send, tasks/get, and related methods
 * as defined in the A2A Protocol specification.
 *
 * @example
 * ```typescript
 * import { feedAgentCard, FeedAgentExecutor } from '@feed/a2a';
 * import { A2AClient } from '@a2a-js/sdk/client';
 *
 * const client = new A2AClient({
 *   endpoint: 'https://feed.market/api/a2a',
 *   agentCard: feedAgentCard
 * });
 * ```
 *
 * @see {@link https://github.com/a2a-js/sdk | A2A SDK Documentation}
 */

export { FeedAgentExecutor } from "./executors/feed-executor";
export type { ListTasksParams, ListTasksResult } from "./extended-task-store";
export { ExtendedTaskStore } from "./extended-task-store";
export { feedAgentCard } from "./feed-agent-card";
export * from "./handlers/escrow-handlers";
export * from "./payments";
export {
  PersistentTaskStore,
  type TaskStatusUpdate,
} from "./persistent-task-store";
export {
  generateAgentCard,
  generateAgentCardSync,
} from "./sdk/agent-card-generator";
export * from "./types";
export * from "./utils";
export * from "./validation";
