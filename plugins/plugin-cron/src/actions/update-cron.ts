/**
 * @module update-cron
 * @description Action to update an existing cron job
 */

import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import { CronService } from '../services/cron-service.js';
import { CRON_SERVICE_TYPE, CronActions } from '../constants.js';
import type { CronJobPatch, CronSchedule } from '../types.js';
import { formatSchedule, parseScheduleDescription } from '../scheduler/schedule-utils.js';

/**
 * Extracts job identifier (ID or name) from text
 */
function extractJobIdentifier(text: string): { id?: string; name?: string } {
  // Try to find UUID
  const idMatch = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i.exec(text);
  if (idMatch) {
    return { id: idMatch[1] };
  }

  // Try to find quoted name
  const quotedMatch = /["']([^"']+)["']/i.exec(text);
  if (quotedMatch) {
    return { name: quotedMatch[1] };
  }

  // Try to find "job called X" or "cron named X"
  const namedMatch = /(?:job|cron)\s+(?:called|named)\s+(\S+)/i.exec(text);
  if (namedMatch) {
    return { name: namedMatch[1] };
  }

  return {};
}

/**
 * Parses update intent from text
 */
function parseUpdateIntent(text: string): CronJobPatch {
  const patch: CronJobPatch = {};
  const normalized = text.toLowerCase();

  // Check for enable/disable
  if (normalized.includes('enable') && !normalized.includes('disable')) {
    patch.enabled = true;
  } else if (normalized.includes('disable')) {
    patch.enabled = false;
  }

  // Check for schedule change
  const everyMatch = /every\s+(\d+\s*(?:second|minute|hour|day|week)s?)/i.exec(text);
  if (everyMatch) {
    const schedule = parseScheduleDescription(`every ${everyMatch[1]}`);
    if (schedule) {
      patch.schedule = schedule;
    }
  }

  // Check for name change
  const renameMatch = /rename\s+(?:to|as)\s+["']?([^"']+)["']?/i.exec(text);
  if (renameMatch) {
    patch.name = renameMatch[1].trim();
  }

  return patch;
}

export const updateCronAction: Action = {
  name: CronActions.UPDATE_CRON,
  similes: [
    'MODIFY_CRON',
    'EDIT_CRON',
    'CHANGE_CRON',
    'ENABLE_CRON',
    'DISABLE_CRON',
    'PAUSE_CRON',
    'RESUME_CRON',
  ],
  description:
    'Updates an existing cron job. Can enable/disable jobs, change schedules, or modify other properties.',

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() ?? '';

    const hasUpdateKeyword =
      text.includes('update') ||
      text.includes('modify') ||
      text.includes('edit') ||
      text.includes('change') ||
      text.includes('enable') ||
      text.includes('disable') ||
      text.includes('pause') ||
      text.includes('resume');

    const hasCronKeyword =
      text.includes('cron') || text.includes('job') || text.includes('schedule');

    return hasUpdateKeyword && hasCronKeyword;
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

    const text = message.content?.text ?? '';

    // Get job ID from options or extract from text
    let jobId: string | undefined = options?.jobId as string | undefined;
    let patch: CronJobPatch = (options?.patch as CronJobPatch) || {};

    if (!jobId) {
      const identifier = extractJobIdentifier(text);

      if (identifier.id) {
        jobId = identifier.id;
      } else if (identifier.name) {
        // Find job by name
        const jobs = await cronService.listJobs({ includeDisabled: true });
        const job = jobs.find(
          (j) => j.name.toLowerCase() === identifier.name!.toLowerCase()
        );

        if (!job) {
          await callback?.({
            text: `No cron job found with name: ${identifier.name}`,
          });
          return { success: false, error: 'Job not found' };
        }

        jobId = job.id;
      }
    }

    if (!jobId) {
      await callback?.({
        text:
          'Please specify which cron job to update. You can use the job ID or name.\n' +
          'Example: "disable cron job abc-123" or "enable cron called daily-check"',
      });
      return { success: false, error: 'No job identifier provided' };
    }

    // If no patch provided in options, parse from text
    if (Object.keys(patch).length === 0) {
      patch = parseUpdateIntent(text);
    }

    if (Object.keys(patch).length === 0) {
      await callback?.({
        text:
          'Please specify what to update. Examples:\n' +
          '- "enable cron job abc-123"\n' +
          '- "disable cron called daily-check"\n' +
          '- "change cron abc-123 to run every 2 hours"',
      });
      return { success: false, error: 'No updates specified' };
    }

    const updatedJob = await cronService.updateJob(jobId, patch);

    const changes: string[] = [];
    if (patch.enabled !== undefined) {
      changes.push(`status: ${patch.enabled ? 'enabled' : 'disabled'}`);
    }
    if (patch.schedule) {
      changes.push(`schedule: ${formatSchedule(patch.schedule)}`);
    }
    if (patch.name) {
      changes.push(`name: ${patch.name}`);
    }

    const nextRun = updatedJob.state.nextRunAtMs
      ? new Date(updatedJob.state.nextRunAtMs).toLocaleString()
      : 'not scheduled';

    await callback?.({
      text:
        `Updated cron job "${updatedJob.name}" (${updatedJob.id})\n` +
        `Changes: ${changes.join(', ')}\n` +
        `Next run: ${nextRun}`,
    });

    return {
      success: true,
      data: {
        jobId: updatedJob.id,
        job: updatedJob,
        changes,
      },
    };
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Disable the cron job called daily-check' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Updated cron job "daily-check" (abc-123)\nChanges: status: disabled\nNext run: not scheduled',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Enable cron abc-123-def-456' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Updated cron job "status checker" (abc-123-def-456)\nChanges: status: enabled\nNext run: in 5 minutes',
        },
      },
    ],
  ],
};
