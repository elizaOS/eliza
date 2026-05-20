/**
 * @packageDocumentation
 * @module @babylon/a2a
 *
 * A2A Protocol Implementation for Babylon
 *
 * Babylon implements the official A2A (Agent-to-Agent) protocol using @a2a-js/sdk.
 * All A2A operations use the standard message/send, tasks/get, and related methods
 * as defined in the A2A Protocol specification.
 *
 * @example
 * ```typescript
 * import { babylonAgentCard, BabylonAgentExecutor } from '@babylon/a2a';
 * import { A2AClient } from '@a2a-js/sdk/client';
 *
 * const client = new A2AClient({
 *   endpoint: 'https://babylon.market/api/a2a',
 *   agentCard: babylonAgentCard
 * });
 * ```
 *
 * @see {@link https://github.com/a2a-js/sdk | A2A SDK Documentation}
 */

export { babylonAgentCard } from './babylon-agent-card';
export { BabylonAgentExecutor } from './executors/babylon-executor';
export type { ListTasksParams, ListTasksResult } from './extended-task-store';
export { ExtendedTaskStore } from './extended-task-store';
export * from './handlers/escrow-handlers';
export * from './payments';
export {
  PersistentTaskStore,
  type TaskStatusUpdate,
} from './persistent-task-store';
export {
  generateAgentCard,
  generateAgentCardSync,
} from './sdk/agent-card-generator';
export * from './types';
export * from './utils';
export * from './validation';
