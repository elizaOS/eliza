/**
 * @module plugin-cron
 * @description elizaOS plugin for cron job scheduling
 *
 * This plugin provides:
 * - Scheduled job execution (cron expressions, intervals, one-time)
 * - CRUD operations for managing jobs
 * - Multiple payload types: prompts, actions, events
 * - Persistent storage via Eliza components
 * - Natural language job creation
 *
 * Key features:
 * - Standard cron expression support (via croner)
 * - Timezone-aware scheduling
 * - Automatic catch-up for missed jobs
 * - Job lifecycle events
 *
 * @example
 * ```typescript
 * import { cronPlugin } from '@elizaos/plugin-cron';
 *
 * const character = createCharacter({
 *   name: 'Scheduler',
 *   plugins: [cronPlugin],
 * });
 * ```
 */

import type { Plugin, PluginEvents } from '@elizaos/core';

// Service
import { CronService } from './services/cron-service.js';

// Actions
import { createCronAction } from './actions/create-cron.js';
import { updateCronAction } from './actions/update-cron.js';
import { deleteCronAction } from './actions/delete-cron.js';
import { listCronsAction } from './actions/list-crons.js';
import { runCronAction } from './actions/run-cron.js';

// Providers
import { cronContextProvider } from './providers/cron-context.js';

// Heartbeat
import { pushSystemEvent, wakeHeartbeatNow } from './heartbeat/index.js';

// Routes
import { cronRoutes } from './routes/index.js';

// Re-export types
export * from './types.js';

// Re-export constants
export * from './constants.js';

// Re-export service
export { CronService } from './services/cron-service.js';

// Re-export storage
export { getCronStorage, type CronStorage } from './storage/cron-storage.js';

// Re-export scheduler utilities
export {
  computeNextRunAtMs,
  validateSchedule,
  formatSchedule,
  parseScheduleDescription,
  parseDuration,
} from './scheduler/schedule-utils.js';

// Re-export timer manager
export { TimerManager } from './scheduler/timer-manager.js';

// Re-export executor
export { executeJob, validateJobExecutability } from './executor/job-executor.js';

// Re-export heartbeat
export {
  pushSystemEvent,
  drainSystemEvents,
  pendingEventCount,
  wakeHeartbeatNow,
  startHeartbeat,
  heartbeatWorker,
  resolveHeartbeatConfig,
  isWithinActiveHours,
  HEARTBEAT_WORKER_NAME,
} from './heartbeat/index.js';
export type { SystemEvent, HeartbeatConfig, ActiveHours } from './heartbeat/index.js';

// CLI self-registration - importing this module triggers CLI command registration
import './cli/index.js';

/**
 * Cron scheduling plugin for elizaOS
 *
 * Provides the ability to schedule recurring or one-time jobs that
 * execute prompts, actions, or emit events on a defined schedule.
 *
 * Usage:
 * ```typescript
 * import { cronPlugin } from '@elizaos/plugin-cron';
 *
 * const agent = {
 *   character: myCharacter,
 *   plugins: [cronPlugin],
 * };
 * ```
 *
 * Once loaded, the plugin provides:
 * - `CronService` - Core service for job management
 * - Actions: CREATE_CRON, UPDATE_CRON, DELETE_CRON, LIST_CRONS, RUN_CRON
 * - Provider: cronContext for injecting job info into prompts
 *
 * Creating jobs programmatically:
 * ```typescript
 * const cronService = runtime.getService<CronService>('CRON');
 *
 * // Create an interval job
 * await cronService.createJob({
 *   name: 'Hourly check',
 *   enabled: true,
 *   schedule: { kind: 'every', everyMs: 3600000 },
 *   payload: { kind: 'prompt', text: 'Check system status' },
 * });
 *
 * // Create a cron expression job
 * await cronService.createJob({
 *   name: 'Daily report',
 *   enabled: true,
 *   schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' },
 *   payload: { kind: 'prompt', text: 'Generate daily report' },
 * });
 *
 * // Create a one-shot job
 * await cronService.createJob({
 *   name: 'Reminder',
 *   enabled: true,
 *   deleteAfterRun: true,
 *   schedule: { kind: 'at', at: '2024-12-31T23:59:00Z' },
 *   payload: { kind: 'prompt', text: 'Happy New Year!' },
 * });
 * ```
 */
/**
 * Custom event names for cross-plugin communication.
 * Other plugins (e.g. plugin-webhooks) can emit these to trigger
 * heartbeat behaviour without a direct import dependency.
 */
export const CronPluginEvents = {
  /** Request an immediate heartbeat tick. Payload: { text?: string } */
  HEARTBEAT_WAKE: 'HEARTBEAT_WAKE',
  /** Enqueue a system event for the next heartbeat. Payload: { text: string } */
  HEARTBEAT_SYSTEM_EVENT: 'HEARTBEAT_SYSTEM_EVENT',
} as const;

export const cronPlugin: Plugin = {
  name: 'cron',
  description: 'Cron job scheduling for recurring and one-time task automation',

  // Register the cron service
  services: [CronService],

  // Actions for cron operations
  actions: [
    createCronAction,
    updateCronAction,
    deleteCronAction,
    listCronsAction,
    runCronAction,
  ],

  // Provider for cron context
  providers: [cronContextProvider],

  // HTTP routes for UI
  routes: cronRoutes,

  // Event handlers for cross-plugin coordination (custom events; cast for PluginEvents)
  events: {
    [CronPluginEvents.HEARTBEAT_WAKE]: [
      async (payload: Record<string, unknown>) => {
        const runtime = payload.runtime as import('@elizaos/core').IAgentRuntime;
        if (!runtime) {
          return;
        }
        const text = typeof payload.text === 'string' ? payload.text : undefined;
        if (text) {
          pushSystemEvent(
            runtime.agentId as string,
            text,
            typeof payload.source === 'string' ? payload.source : 'external',
          );
        }
        await wakeHeartbeatNow(runtime);
      },
    ],
    [CronPluginEvents.HEARTBEAT_SYSTEM_EVENT]: [
      async (payload: Record<string, unknown>) => {
        const runtime = payload.runtime as import('@elizaos/core').IAgentRuntime;
        if (!runtime) {
          return;
        }
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (text) {
          pushSystemEvent(
            runtime.agentId as string,
            text,
            typeof payload.source === 'string' ? payload.source : 'external',
          );
        }
      },
    ],
  } as PluginEvents,
};

export default cronPlugin;

// Re-export Otto-specific utilities
// These can be imported via '@elizaos/plugin-cron/otto'
// or directly from '@elizaos/plugin-cron'
export * as otto from './otto/index.js';
