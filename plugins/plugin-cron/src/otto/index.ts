/**
 * @module otto
 * @description Otto-specific cron utilities and types
 *
 * This module provides Otto-specific extensions to the base plugin-cron:
 * - Extended types with session targeting, wake modes, and delivery
 * - Input normalization with backward compatibility
 * - Job utilities for patching and validation
 * - Run log management
 * - Store utilities
 *
 * @example
 * ```typescript
 * import {
 *   normalizeCronJobCreate,
 *   normalizeCronJobPatch,
 *   validateScheduleTimestamp,
 * } from '@elizaos/plugin-cron/otto';
 *
 * // Normalize input from API/CLI
 * const normalized = normalizeCronJobCreate(rawInput);
 *
 * // Validate timestamp for "at" schedules
 * const validation = validateScheduleTimestamp(schedule);
 * if (!validation.ok) {
 *   throw new Error(validation.message);
 * }
 * ```
 */

// Types
export type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronSchedule,
  CronPayload,
  CronPayloadPatch,
  CronDelivery,
  CronDeliveryPatch,
  CronDeliveryMode,
  CronMessageChannel,
  CronSessionTarget,
  CronWakeMode,
  CronStoreFile,
} from './types.js';

// Normalization
export {
  normalizeCronJobInput,
  normalizeCronJobCreate,
  normalizeCronJobPatch,
} from './normalize.js';

// Job utilities
export {
  assertSupportedJobSpec,
  assertDeliverySupport,
  normalizeRequiredName,
  normalizeOptionalText,
  normalizeOptionalAgentId,
  applyJobPatch,
} from './job-utils.js';

// Parsing
export { parseAbsoluteTimeMs } from './parse.js';

// Validation
export {
  validateScheduleTimestamp,
  type TimestampValidationResult,
  type TimestampValidationError,
  type TimestampValidationSuccess,
} from './validate-timestamp.js';

// Run log
export {
  resolveCronRunLogPath,
  appendCronRunLog,
  readCronRunLogEntries,
  type CronRunLogEntry,
} from './run-log.js';

// Store
export { resolveCronStorePath, loadCronStore, saveCronStore } from './store.js';

// Migration utilities
export { migrateLegacyCronPayload } from './payload-migration.js';

// Delivery
export { resolveCronDeliveryPlan, type CronDeliveryPlan } from './delivery.js';

// Detection (no heavy deps)
export { isOttoPayload } from './detect.js';

// Executor
export { executeOttoJob } from './executor.js';
