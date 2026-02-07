/**
 * @module run-cron
 * @description Action to manually run a cron job
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

export const runCronAction: Action = {
  name: CronActions.RUN_CRON,
  similes: [
    'EXECUTE_CRON',
    'TRIGGER_CRON',
    'FIRE_CRON',
    'RUN_SCHEDULED_JOB',
    'EXECUTE_JOB',
    'TRIGGER_JOB',
  ],
  description:
    'Manually runs a cron job immediately, regardless of its schedule. Useful for testing or one-off execution.',

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() ?? '';

    const hasRunKeyword =
      text.includes('run') ||
      text.includes('execute') ||
      text.includes('trigger') ||
      text.includes('fire');

    const hasCronKeyword =
      text.includes('cron') || text.includes('job') || text.includes('schedule');

    // Exclude "run every" which is for creating jobs
    const isCreateIntent = text.includes('run every') || text.includes('runs every');

    return hasRunKeyword && hasCronKeyword && !isCreateIntent;
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
          'Please specify which cron job to run. You can use the job ID or name.\n' +
          'Example: "run cron job abc-123" or "execute cron called daily-check"',
      });
      return { success: false, error: 'No job identifier provided' };
    }

    // Get job details if not already known
    if (!jobName) {
      const job = await cronService.getJob(jobId);
      if (job) {
        jobName = job.name;
      }
    }

    // Run the job with force mode (ignores schedule)
    const result = await cronService.runJob(jobId, 'force');

    if (!result.ran) {
      await callback?.({
        text: `Could not run job: ${result.error}`,
      });
      return { success: false, error: result.error };
    }

    // Format result message
    let responseText = `Ran cron job "${jobName || 'unknown'}" (${jobId})\n`;
    responseText += `Status: ${result.status}\n`;
    responseText += `Duration: ${result.durationMs}ms\n`;

    if (result.status === 'ok' && result.output) {
      // Truncate long output
      const outputPreview =
        result.output.length > 500
          ? result.output.slice(0, 500) + '... (truncated)'
          : result.output;
      responseText += `\nOutput:\n${outputPreview}`;
    }

    if (result.error) {
      responseText += `\nError: ${result.error}`;
    }

    await callback?.({
      text: responseText,
    });

    return {
      success: result.status === 'ok',
      data: {
        jobId,
        jobName,
        result,
      },
    };
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Run the cron job called daily-check now' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Ran cron job "daily-check" (abc-123)\nStatus: ok\nDuration: 1250ms\n\nOutput:\nDaily check completed successfully. All systems operational.',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Execute cron abc-123-def-456' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Ran cron job "status-checker" (abc-123-def-456)\nStatus: ok\nDuration: 850ms',
        },
      },
    ],
  ],
};
