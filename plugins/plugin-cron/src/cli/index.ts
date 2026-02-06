/**
 * @module cli
 * @description CLI commands for plugin-cron
 *
 * This module registers cron CLI commands that operate directly on the
 * CronService, bypassing the gateway RPC layer for better performance
 * and fewer dependencies.
 *
 * Self-registers with the plugin-cli registry at module load.
 */

import type { CronJob } from '../types.js';
import { registerCliCommand, defineCliCommand } from '@elizaos/plugin-cli';
import { formatSchedule } from '../scheduler/schedule-utils.js';
import { registerCronCli } from './register.js';

// Self-register at module load
registerCliCommand(
  defineCliCommand(
    'cron',
    'Cron job scheduling commands',
    (ctx) => registerCronCli(ctx),
    { priority: 50 }
  )
);

/**
 * Parse a duration string like "10m", "1h", "30s" to milliseconds
 */
export function parseDurationMs(input: string): number | null {
  const raw = input.trim();
  if (!raw) return null;

  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (!match) return null;

  const n = Number.parseFloat(match[1] ?? '');
  if (!Number.isFinite(n) || n <= 0) return null;

  const unit = (match[2] ?? '').toLowerCase();
  const factor =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : 86_400_000;

  return Math.floor(n * factor);
}

/**
 * Parse an "at" time specification (ISO string or relative duration)
 */
export function parseAt(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  // Try parsing as ISO date
  const date = new Date(raw);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString();
  }

  // Try parsing as relative duration
  const dur = parseDurationMs(raw);
  if (dur !== null) {
    return new Date(Date.now() + dur).toISOString();
  }

  return null;
}

/**
 * Format a cron job for display
 */
export function formatCronJob(job: CronJob): string {
  const status = job.enabled ? 'enabled' : 'disabled';
  const schedule = formatSchedule(job.schedule);
  const next = job.state.nextRunAtMs
    ? new Date(job.state.nextRunAtMs).toISOString()
    : 'N/A';

  return `${job.id} | ${job.name} | ${status} | ${schedule} | Next: ${next}`;
}

/**
 * Print a list of cron jobs
 */
export function printCronList(jobs: CronJob[], log: (msg: string) => void): void {
  if (jobs.length === 0) {
    log('No cron jobs.');
    return;
  }

  log('ID                                   | Name                     | Status   | Schedule                         | Next Run');
  log('-------------------------------------|--------------------------|----------|----------------------------------|--------------------');

  for (const job of jobs) {
    const id = job.id.padEnd(36);
    const name = (job.name || '(unnamed)').slice(0, 24).padEnd(24);
    const status = (job.enabled ? 'enabled' : 'disabled').padEnd(8);
    const schedule = formatSchedule(job.schedule).slice(0, 32).padEnd(32);
    const next = job.state.nextRunAtMs
      ? new Date(job.state.nextRunAtMs).toISOString().slice(0, 19)
      : 'N/A';

    log(`${id} | ${name} | ${status} | ${schedule} | ${next}`);
  }
}
