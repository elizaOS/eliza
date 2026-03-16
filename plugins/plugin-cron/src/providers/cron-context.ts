/**
 * @module cron-context
 * @description Provider that injects cron job context into the agent's state
 *
 * This provider makes information about active cron jobs available to the agent,
 * allowing it to reference and reason about scheduled tasks.
 */

import type { Provider, IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { CronService } from '../services/cron-service.js';
import { CRON_SERVICE_TYPE } from '../constants.js';
import type { CronJob } from '../types.js';
import { formatSchedule } from '../scheduler/schedule-utils.js';

/**
 * Formats a job for context display
 */
function formatJobForContext(job: CronJob): string {
  const scheduleStr = formatSchedule(job.schedule);
  const nextRun = job.state.nextRunAtMs
    ? new Date(job.state.nextRunAtMs).toISOString()
    : 'not scheduled';

  let line = `- ${job.name} (${scheduleStr})`;

  if (!job.enabled) {
    line += ' [disabled]';
  } else {
    line += ` - next: ${nextRun}`;
  }

  if (job.state.lastStatus === 'error') {
    line += ' [last run failed]';
  }

  return line;
}

/**
 * Provider that supplies cron job context to the agent
 */
export const cronContextProvider: Provider = {
  name: 'cronContext',
  description: 'Provides information about scheduled cron jobs',
  dynamic: true,
  position: 50, // Middle priority

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    const cronService = runtime.getService<CronService>(CRON_SERVICE_TYPE);

    if (!cronService) {
      return {
        text: '',
        values: {
          hasCronService: false,
          cronJobCount: 0,
        },
        data: {
          available: false,
        },
      };
    }

    const jobs = await cronService.listJobs({ includeDisabled: true });
    const enabledJobs = jobs.filter((j) => j.enabled);
    const disabledJobs = jobs.filter((j) => !j.enabled);

    // Find jobs that will run soon (within the next hour)
    const nowMs = Date.now();
    const oneHourFromNow = nowMs + 3600000;
    const upcomingJobs = enabledJobs.filter(
      (j) => j.state.nextRunAtMs && j.state.nextRunAtMs <= oneHourFromNow
    );

    // Find jobs that recently ran (within the last hour)
    const recentJobs = jobs.filter(
      (j) => j.state.lastRunAtMs && j.state.lastRunAtMs >= nowMs - 3600000
    );

    // Find jobs with errors
    const failedJobs = jobs.filter((j) => j.state.lastStatus === 'error');

    // Build context text
    const lines: string[] = [];

    if (jobs.length === 0) {
      lines.push('No cron jobs are scheduled.');
    } else {
      lines.push(`Scheduled Jobs (${enabledJobs.length} active, ${disabledJobs.length} disabled):`);

      if (upcomingJobs.length > 0) {
        lines.push('\nUpcoming (next hour):');
        for (const job of upcomingJobs.slice(0, 5)) {
          lines.push(formatJobForContext(job));
        }
        if (upcomingJobs.length > 5) {
          lines.push(`  ... and ${upcomingJobs.length - 5} more`);
        }
      }

      if (failedJobs.length > 0) {
        lines.push('\nRecently failed:');
        for (const job of failedJobs.slice(0, 3)) {
          lines.push(`- ${job.name}: ${job.state.lastError || 'unknown error'}`);
        }
      }

      // Show a summary of all jobs if not too many
      if (enabledJobs.length <= 10 && enabledJobs.length > 0) {
        lines.push('\nAll active jobs:');
        for (const job of enabledJobs) {
          lines.push(formatJobForContext(job));
        }
      } else if (enabledJobs.length > 10) {
        lines.push(`\n${enabledJobs.length} active jobs total. Use "list crons" to see all.`);
      }
    }

    return {
      text: lines.join('\n'),
      values: {
        hasCronService: true,
        cronJobCount: jobs.length,
        enabledJobCount: enabledJobs.length,
        disabledJobCount: disabledJobs.length,
        upcomingJobCount: upcomingJobs.length,
        failedJobCount: failedJobs.length,
      },
      data: {
        available: true,
        jobs: jobs.map((j) => ({
          id: j.id,
          name: j.name,
          enabled: j.enabled,
          schedule: j.schedule,
          nextRunAtMs: j.state.nextRunAtMs,
          lastStatus: j.state.lastStatus,
        })),
        upcoming: upcomingJobs.map((j) => j.id),
        failed: failedJobs.map((j) => j.id),
        recent: recentJobs.map((j) => j.id),
      },
    };
  },
};
