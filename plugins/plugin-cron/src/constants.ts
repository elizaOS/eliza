/**
 * @module constants
 * @description Constants for the cron plugin
 */

// Service identifier
export const CRON_SERVICE_TYPE = 'CRON';

// Storage component types
export const CRON_JOB_COMPONENT_PREFIX = 'cron_job';
export const CRON_JOB_INDEX_COMPONENT = 'cron_job_index';

// Event names
export const CronEvents = {
  CRON_FIRED: 'CRON_FIRED',
  CRON_CREATED: 'CRON_CREATED',
  CRON_UPDATED: 'CRON_UPDATED',
  CRON_DELETED: 'CRON_DELETED',
  CRON_FAILED: 'CRON_FAILED',
} as const;

// Action names
export const CronActions = {
  CREATE_CRON: 'CREATE_CRON',
  UPDATE_CRON: 'UPDATE_CRON',
  DELETE_CRON: 'DELETE_CRON',
  LIST_CRONS: 'LIST_CRONS',
  RUN_CRON: 'RUN_CRON',
} as const;
