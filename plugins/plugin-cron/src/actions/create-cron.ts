/**
 * @module create-cron
 * @description Action to create a new cron job
 *
 * Supports natural language and structured input:
 * - "Create a cron job that runs every hour to check the weather"
 * - "Schedule a daily reminder at 9am"
 * - Structured JSON payload for programmatic use
 */

import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import { CronService } from '../services/cron-service.js';
import { CRON_SERVICE_TYPE, CronActions } from '../constants.js';
import type { CronJobCreate, CronSchedule, CronPayload } from '../types.js';
import {
  parseScheduleDescription,
  formatSchedule,
  validateSchedule,
} from '../scheduler/schedule-utils.js';
import { DEFAULT_CRON_CONFIG } from '../types.js';

/**
 * Parses a natural language cron request into components
 */
function parseNaturalLanguageRequest(text: string): {
  name?: string;
  schedule?: CronSchedule;
  prompt?: string;
  description?: string;
} {
  const result: {
    name?: string;
    schedule?: CronSchedule;
    prompt?: string;
    description?: string;
  } = {};

  const normalized = text.toLowerCase();

  // Try to extract schedule from various patterns
  // Pattern: "every X" (interval)
  const everyMatch = /every\s+(\d+\s*(?:second|minute|hour|day|week)s?)/i.exec(text);
  if (everyMatch) {
    result.schedule = parseScheduleDescription(`every ${everyMatch[1]}`);
  }

  // Pattern: "at X" (one-time or cron)
  const atMatch = /at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i.exec(text);
  if (atMatch && !result.schedule) {
    // Convert time to cron expression
    const timeStr = atMatch[1].toLowerCase();
    let hours: number;
    let minutes = 0;

    const timeParts = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(timeStr);
    if (timeParts) {
      hours = parseInt(timeParts[1], 10);
      if (timeParts[2]) {
        minutes = parseInt(timeParts[2], 10);
      }
      if (timeParts[3]) {
        if (timeParts[3].toLowerCase() === 'pm' && hours !== 12) {
          hours += 12;
        } else if (timeParts[3].toLowerCase() === 'am' && hours === 12) {
          hours = 0;
        }
      }

      // Check for day patterns
      if (normalized.includes('daily') || normalized.includes('every day')) {
        result.schedule = {
          kind: 'cron',
          expr: `${minutes} ${hours} * * *`,
        };
      } else if (normalized.includes('weekday') || normalized.includes('monday to friday')) {
        result.schedule = {
          kind: 'cron',
          expr: `${minutes} ${hours} * * 1-5`,
        };
      } else if (normalized.includes('weekend')) {
        result.schedule = {
          kind: 'cron',
          expr: `${minutes} ${hours} * * 0,6`,
        };
      } else {
        // Default to daily
        result.schedule = {
          kind: 'cron',
          expr: `${minutes} ${hours} * * *`,
        };
      }
    }
  }

  // Pattern: "in X" (one-time delay)
  const inMatch = /in\s+(\d+\s*(?:second|minute|hour|day)s?)/i.exec(text);
  if (inMatch && !result.schedule) {
    result.schedule = parseScheduleDescription(`in ${inMatch[1]}`);
  }

  // Try to extract the action/prompt from "to X" or "that X"
  const toMatch = /(?:to|that)\s+(.+?)(?:\s+every|\s+at|\s+in\s+\d|$)/i.exec(text);
  if (toMatch) {
    result.prompt = toMatch[1].trim();
    // Use the prompt as the name if no explicit name
    result.name = toMatch[1].slice(0, 50).trim();
  }

  // Try to extract name from "called X" or "named X"
  const nameMatch = /(?:called|named)\s+["']?([^"']+)["']?/i.exec(text);
  if (nameMatch) {
    result.name = nameMatch[1].trim();
  }

  // If we still don't have a name, generate one
  if (!result.name && result.schedule) {
    const scheduleDesc = formatSchedule(result.schedule);
    result.name = `Cron job (${scheduleDesc})`;
  }

  return result;
}

/**
 * Formats a job for display
 */
function formatJobResponse(job: {
  id: string;
  name: string;
  schedule: CronSchedule;
  enabled: boolean;
  state: { nextRunAtMs?: number };
}): string {
  const scheduleStr = formatSchedule(job.schedule);
  const nextRun = job.state.nextRunAtMs
    ? new Date(job.state.nextRunAtMs).toLocaleString()
    : 'not scheduled';

  return (
    `Created cron job "${job.name}"\n` +
    `- ID: ${job.id}\n` +
    `- Schedule: ${scheduleStr}\n` +
    `- Status: ${job.enabled ? 'enabled' : 'disabled'}\n` +
    `- Next run: ${nextRun}`
  );
}

export const createCronAction: Action = {
  name: CronActions.CREATE_CRON,
  similes: [
    'SCHEDULE_CRON',
    'ADD_CRON',
    'NEW_CRON',
    'CREATE_SCHEDULED_JOB',
    'SET_UP_CRON',
    'SCHEDULE_JOB',
    'CREATE_RECURRING_JOB',
  ],
  description:
    'Creates a new cron job that runs on a schedule. Supports interval-based schedules (every X minutes), cron expressions, and one-time schedules.',

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() ?? '';

    // Check for scheduling-related keywords
    const hasScheduleKeyword =
      text.includes('cron') ||
      text.includes('schedule') ||
      text.includes('every ') ||
      text.includes('recurring') ||
      text.includes('repeat') ||
      text.includes('daily') ||
      text.includes('hourly') ||
      text.includes('weekly');

    // Check for creation intent
    const hasCreateIntent =
      text.includes('create') ||
      text.includes('add') ||
      text.includes('set up') ||
      text.includes('schedule') ||
      text.includes('make');

    return hasScheduleKeyword && hasCreateIntent;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    // Get the cron service
    const cronService = runtime.getService<CronService>(CRON_SERVICE_TYPE);
    if (!cronService) {
      await callback?.({
        text: 'Cron service is not available. Please ensure the plugin is loaded.',
      });
      return { success: false, error: 'Cron service not available' };
    }

    const text = message.content?.text ?? '';

    // Check if this is a structured request (JSON in options)
    if (options?.jobInput && typeof options.jobInput === 'object') {
      const input = options.jobInput as CronJobCreate;

      // Validate the input
      const scheduleError = validateSchedule(input.schedule, DEFAULT_CRON_CONFIG);
      if (scheduleError) {
        await callback?.({
          text: `Invalid schedule: ${scheduleError}`,
        });
        return { success: false, error: scheduleError };
      }

      const job = await cronService.createJob(input);
      await callback?.({
        text: formatJobResponse(job),
      });
      return { success: true, data: { jobId: job.id, job } };
    }

    // Parse natural language request
    const parsed = parseNaturalLanguageRequest(text);

    if (!parsed.schedule) {
      await callback?.({
        text:
          "I couldn't understand the schedule. Please specify when the job should run, for example:\n" +
          '- "every 5 minutes"\n' +
          '- "every hour"\n' +
          '- "daily at 9am"\n' +
          '- "every weekday at 8:30am"',
      });
      return { success: false, error: 'Could not parse schedule' };
    }

    // Build the job input
    const jobInput: CronJobCreate = {
      name: parsed.name || 'Unnamed cron job',
      description: parsed.description,
      enabled: true,
      schedule: parsed.schedule,
      payload: {
        kind: 'prompt',
        text: parsed.prompt || 'Run scheduled task',
      } as CronPayload,
    };

    // If the user specified a one-time schedule, mark it for deletion after run
    if (parsed.schedule.kind === 'at') {
      jobInput.deleteAfterRun = true;
    }

    const job = await cronService.createJob(jobInput);

    await callback?.({
      text: formatJobResponse(job),
    });

    return {
      success: true,
      data: {
        jobId: job.id,
        job,
      },
    };
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Create a cron job to check the news every hour' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Created cron job "check the news"\n- ID: abc-123\n- Schedule: every 1 hour\n- Status: enabled\n- Next run: in 1 hour',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Schedule a daily reminder at 9am to review my goals' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Created cron job "review my goals"\n- ID: def-456\n- Schedule: cron: 0 9 * * *\n- Status: enabled\n- Next run: tomorrow at 9:00 AM',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Set up a recurring job every 5 minutes to check server status' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Created cron job "check server status"\n- ID: ghi-789\n- Schedule: every 5 minutes\n- Status: enabled\n- Next run: in 5 minutes',
        },
      },
    ],
  ],
};
