/**
 * @module list-crons
 * @description Action to list all cron jobs
 */

import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import { CronService } from '../services/cron-service.js';
import { CRON_SERVICE_TYPE, CronActions } from '../constants.js';
import type { CronJob, CronJobFilter } from '../types.js';
import { formatSchedule } from '../scheduler/schedule-utils.js';

/**
 * Formats a list of jobs for display
 */
function formatJobList(jobs: CronJob[], includeDisabled: boolean): string {
  if (jobs.length === 0) {
    return includeDisabled
      ? 'No cron jobs found.'
      : 'No active cron jobs found. Use "list all crons" to include disabled jobs.';
  }

  const lines = [`Found ${jobs.length} cron job${jobs.length === 1 ? '' : 's'}:\n`];

  for (const job of jobs) {
    const scheduleStr = formatSchedule(job.schedule);
    const statusStr = job.enabled ? 'enabled' : 'disabled';
    const nextRun = job.state.nextRunAtMs
      ? new Date(job.state.nextRunAtMs).toLocaleString()
      : 'not scheduled';

    const lastStatus = job.state.lastStatus
      ? ` (last: ${job.state.lastStatus})`
      : '';

    lines.push(
      `• ${job.name}${lastStatus}\n` +
        `  ID: ${job.id}\n` +
        `  Schedule: ${scheduleStr}\n` +
        `  Status: ${statusStr}\n` +
        `  Next run: ${nextRun}\n` +
        `  Runs: ${job.state.runCount} | Errors: ${job.state.errorCount}`
    );
  }

  return lines.join('\n');
}

/**
 * Formats a single job for detailed display
 */
function formatJobDetails(job: CronJob): string {
  const scheduleStr = formatSchedule(job.schedule);
  const statusStr = job.enabled ? 'enabled' : 'disabled';
  const nextRun = job.state.nextRunAtMs
    ? new Date(job.state.nextRunAtMs).toLocaleString()
    : 'not scheduled';
  const lastRun = job.state.lastRunAtMs
    ? new Date(job.state.lastRunAtMs).toLocaleString()
    : 'never';

  let details = `Cron Job: ${job.name}\n\n`;
  details += `ID: ${job.id}\n`;

  if (job.description) {
    details += `Description: ${job.description}\n`;
  }

  details += `\nSchedule: ${scheduleStr}\n`;
  details += `Status: ${statusStr}\n`;

  if (job.deleteAfterRun) {
    details += `Type: one-shot (will be deleted after successful run)\n`;
  }

  details += `\nExecution Stats:\n`;
  details += `  Next run: ${nextRun}\n`;
  details += `  Last run: ${lastRun}\n`;
  details += `  Total runs: ${job.state.runCount}\n`;
  details += `  Total errors: ${job.state.errorCount}\n`;

  if (job.state.lastStatus) {
    details += `  Last status: ${job.state.lastStatus}\n`;
  }

  if (job.state.lastError) {
    details += `  Last error: ${job.state.lastError}\n`;
  }

  if (job.state.lastDurationMs !== undefined) {
    details += `  Last duration: ${job.state.lastDurationMs}ms\n`;
  }

  details += `\nPayload Type: ${job.payload.kind}\n`;

  if (job.payload.kind === 'prompt') {
    details += `Prompt: ${job.payload.text.slice(0, 200)}${job.payload.text.length > 200 ? '...' : ''}\n`;
  } else if (job.payload.kind === 'action') {
    details += `Action: ${job.payload.actionName}\n`;
  } else if (job.payload.kind === 'event') {
    details += `Event: ${job.payload.eventName}\n`;
  }

  if (job.tags && job.tags.length > 0) {
    details += `\nTags: ${job.tags.join(', ')}\n`;
  }

  details += `\nCreated: ${new Date(job.createdAtMs).toLocaleString()}\n`;
  details += `Updated: ${new Date(job.updatedAtMs).toLocaleString()}\n`;

  return details;
}

export const listCronsAction: Action = {
  name: CronActions.LIST_CRONS,
  similes: [
    'SHOW_CRONS',
    'GET_CRONS',
    'VIEW_CRONS',
    'LIST_SCHEDULED_JOBS',
    'SHOW_SCHEDULED_JOBS',
    'MY_CRONS',
    'CRON_STATUS',
  ],
  description:
    'Lists all cron jobs. Can filter by enabled status or show details of a specific job.',

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() ?? '';

    // Check for list/show intent with cron/job keywords
    const hasListKeyword =
      text.includes('list') ||
      text.includes('show') ||
      text.includes('view') ||
      text.includes('get') ||
      text.includes('what');

    const hasCronKeyword =
      text.includes('cron') ||
      text.includes('scheduled') ||
      text.includes('job') ||
      text.includes('schedule');

    return hasListKeyword && hasCronKeyword;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const cronService = runtime.getService<CronService>(CRON_SERVICE_TYPE);
    if (!cronService) {
      await callback?.({
        text: 'Cron service is not available. Please ensure the plugin is loaded.',
      });
      return { success: false, error: 'Cron service not available' };
    }

    const text = message.content?.text?.toLowerCase() ?? '';

    // Check if asking for a specific job by ID
    const idMatch = /(?:job|cron)\s+([a-f0-9-]{36})/i.exec(text);
    if (idMatch) {
      const jobId = idMatch[1];
      const job = await cronService.getJob(jobId);

      if (!job) {
        await callback?.({
          text: `No cron job found with ID: ${jobId}`,
        });
        return { success: false, error: 'Job not found' };
      }

      await callback?.({
        text: formatJobDetails(job),
      });

      return { success: true, data: { job } };
    }

    // Check if asking for a specific job by name
    const nameMatch = /(?:called|named)\s+["']?([^"']+)["']?/i.exec(text);
    if (nameMatch) {
      const jobName = nameMatch[1].toLowerCase();
      const jobs = await cronService.listJobs({ includeDisabled: true });
      const job = jobs.find((j) => j.name.toLowerCase().includes(jobName));

      if (!job) {
        await callback?.({
          text: `No cron job found with name containing: ${jobName}`,
        });
        return { success: false, error: 'Job not found' };
      }

      await callback?.({
        text: formatJobDetails(job),
      });

      return { success: true, data: { job } };
    }

    // Build filter from request
    const filter: CronJobFilter = {};

    // Check for "all" to include disabled
    if (text.includes('all')) {
      filter.includeDisabled = true;
    }

    // Check for "enabled" or "active" to filter
    if (text.includes('enabled') || text.includes('active')) {
      filter.enabled = true;
      filter.includeDisabled = false;
    }

    // Check for "disabled" to filter
    if (text.includes('disabled') || text.includes('inactive')) {
      filter.enabled = false;
      filter.includeDisabled = true;
    }

    // Check for programmatic options
    if (options?.filter && typeof options.filter === 'object') {
      Object.assign(filter, options.filter);
    }

    const jobs = await cronService.listJobs(filter);

    await callback?.({
      text: formatJobList(jobs, filter.includeDisabled ?? false),
    });

    return {
      success: true,
      data: {
        jobs,
        count: jobs.length,
      },
    };
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'List my cron jobs' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Found 2 cron jobs:\n\n• Daily news check\n  ID: abc-123\n  Schedule: cron: 0 9 * * *\n  Status: enabled\n  Next run: tomorrow at 9:00 AM\n  Runs: 5 | Errors: 0\n\n• Hourly status check\n  ID: def-456\n  Schedule: every 1 hour\n  Status: enabled\n  Next run: in 45 minutes\n  Runs: 120 | Errors: 2',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Show all crons including disabled' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Found 3 cron jobs:\n\n• Daily news check\n  ID: abc-123\n  Schedule: cron: 0 9 * * *\n  Status: enabled\n  ...\n\n• Old backup job\n  ID: xyz-789\n  Schedule: every 1 day\n  Status: disabled\n  ...',
        },
      },
    ],
  ],
};
