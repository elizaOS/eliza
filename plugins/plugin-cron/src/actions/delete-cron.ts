/**
 * @module delete-cron
 * @description Action to delete a cron job
 */

import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import { CronService } from '../services/cron-service.js';
import { CRON_SERVICE_TYPE, CronActions } from '../constants.js';

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

export const deleteCronAction: Action = {
  name: CronActions.DELETE_CRON,
  similes: [
    'REMOVE_CRON',
    'CANCEL_CRON',
    'STOP_CRON',
    'DELETE_SCHEDULED_JOB',
    'REMOVE_SCHEDULED_JOB',
  ],
  description: 'Deletes a cron job by ID or name, removing it from the schedule permanently.',

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() ?? '';

    const hasDeleteKeyword =
      text.includes('delete') ||
      text.includes('remove') ||
      text.includes('cancel') ||
      (text.includes('stop') && !text.includes('stop running'));

    const hasCronKeyword =
      text.includes('cron') || text.includes('job') || text.includes('schedule');

    return hasDeleteKeyword && hasCronKeyword;
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
    let jobName: string | undefined;

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
        jobName = job.name;
      }
    }

    if (!jobId) {
      await callback?.({
        text:
          'Please specify which cron job to delete. You can use the job ID or name.\n' +
          'Example: "delete cron job abc-123" or "remove cron called daily-check"',
      });
      return { success: false, error: 'No job identifier provided' };
    }

    // Get job details before deletion for confirmation message
    if (!jobName) {
      const job = await cronService.getJob(jobId);
      if (job) {
        jobName = job.name;
      }
    }

    const deleted = await cronService.deleteJob(jobId);

    if (!deleted) {
      await callback?.({
        text: `No cron job found with ID: ${jobId}`,
      });
      return { success: false, error: 'Job not found' };
    }

    await callback?.({
      text: `Deleted cron job "${jobName || 'unknown'}" (${jobId}).\nThe job has been permanently removed and will no longer run.`,
    });

    return {
      success: true,
      data: {
        jobId,
        jobName,
        deleted: true,
      },
    };
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Delete the cron job called daily-check' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Deleted cron job "daily-check" (abc-123).\nThe job has been permanently removed and will no longer run.',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Remove cron abc-123-def-456' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Deleted cron job "hourly-status" (abc-123-def-456).\nThe job has been permanently removed and will no longer run.',
        },
      },
    ],
  ],
};
