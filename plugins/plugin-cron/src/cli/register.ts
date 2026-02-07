/**
 * @module cli/register
 * @description Register cron CLI commands with the program
 *
 * This integrates with Otto's plugin CLI system, registering
 * commands that operate directly on the CronService.
 */

import type { CliContext, CliLogger } from '@elizaos/plugin-cli';
import type { CronJob, CronJobCreate, CronJobPatch, CronSchedule, CronPayload } from '../types.js';
import type { CronPayload as OttoPayload, CronDelivery } from '../otto/types.js';
import { CronService } from '../services/cron-service.js';
import { CRON_SERVICE_TYPE } from '../constants.js';
import { parseAt, parseDurationMs, printCronList } from './index.js';

/** Default logger for CLI output when not provided */
const defaultLogger: CliLogger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
  debug: (msg: string) => {
    if (process.env.DEBUG) console.debug(msg);
  },
};

/** Get logger from context, with fallback to default */
function getLogger(ctx: CliContext): CliLogger {
  return ctx.logger ?? defaultLogger;
}

/**
 * Get the CronService from the runtime
 */
function getCronService(ctx: CliContext): CronService | null {
  const logger = getLogger(ctx);
  const runtime = ctx.getRuntime?.();
  if (!runtime) {
    logger.error('No runtime available');
    return null;
  }

  const service = runtime.getService<CronService>(CRON_SERVICE_TYPE);
  if (!service) {
    logger.error('CronService not available. Is the cron plugin enabled?');
    return null;
  }

  return service;
}

/**
 * Register the cron CLI commands
 */
export function registerCronCli(ctx: CliContext): void {
  const logger = getLogger(ctx);
  const cron = ctx.program
    .command('cron')
    .description('Manage cron jobs');

  // cron status
  cron
    .command('status')
    .description('Show cron scheduler status')
    .option('--json', 'Output JSON', false)
    .action(async (opts) => {
      const service = getCronService(ctx);
      if (!service) {
        process.exitCode = 1;
        return;
      }

      try {
        const status = await service.getStatus();
        if (opts.json) {
          logger.info(JSON.stringify(status, null, 2));
        } else {
          logger.info(`Cron Service Status:`);
          logger.info(`  Initialized: ${status.initialized}`);
          logger.info(`  Jobs: ${status.jobCount}`);
          logger.info(`  Tracked: ${status.trackedJobCount}`);
        }
      } catch (err) {
        logger.error(`Failed to get status: ${err}`);
        process.exitCode = 1;
      }
    });

  // cron list
  cron
    .command('list')
    .description('List cron jobs')
    .option('--all', 'Include disabled jobs', false)
    .option('--json', 'Output JSON', false)
    .action(async (opts) => {
      const service = getCronService(ctx);
      if (!service) {
        process.exitCode = 1;
        return;
      }

      try {
        const jobs = await service.listJobs({
          includeDisabled: opts.all,
        });

        if (opts.json) {
          logger.info(JSON.stringify({ jobs }, null, 2));
        } else {
          printCronList(jobs, logger.info);
        }
      } catch (err) {
        logger.error(`Failed to list jobs: ${err}`);
        process.exitCode = 1;
      }
    });

  // cron add
  cron
    .command('add')
    .alias('create')
    .description('Add a cron job')
    .requiredOption('--name <name>', 'Job name')
    .option('--description <text>', 'Optional description')
    .option('--disabled', 'Create job disabled', false)
    .option('--delete-after-run', 'Delete one-shot job after it succeeds', false)
    .option('--at <when>', 'Run once at time (ISO) or +duration (e.g. 20m)')
    .option('--every <duration>', 'Run every duration (e.g. 10m, 1h)')
    .option('--cron <expr>', 'Cron expression (5-field)')
    .option('--tz <iana>', 'Timezone for cron expressions (IANA)')
    // Base payload options
    .option('--prompt <text>', 'Prompt to execute')
    .option('--action <name>', 'Action to execute')
    .option('--event <name>', 'Event to emit')
    // Otto-specific options
    .option('--session <target>', 'Session target: main or isolated')
    .option('--system-event <text>', 'System event text (main session)')
    .option('--message <text>', 'Agent message (isolated session)')
    .option('--wake <mode>', 'Wake mode: now or next-heartbeat', 'next-heartbeat')
    .option('--announce', 'Enable announce delivery for isolated jobs', false)
    .option('--channel <name>', 'Delivery channel (e.g. whatsapp, telegram, discord, last)')
    .option('--to <target>', 'Delivery target (e.g. phone number, channel ID)')
    .option('--agent <id>', 'Agent ID to bind this job to')
    .option('--json', 'Output JSON', false)
    .action(async (opts) => {
      const service = getCronService(ctx);
      if (!service) {
        process.exitCode = 1;
        return;
      }

      // Detect whether this is an Otto-style or base-style job
      const isOttoStyle = Boolean(opts.session || opts.systemEvent || opts.message);

      // Parse schedule
      const schedule = parseScheduleOpts(opts);
      if (!schedule) {
        logger.error('Choose exactly one schedule: --at, --every, or --cron');
        process.exitCode = 1;
        return;
      }

      if (isOttoStyle) {
        // Otto-style job creation
        const ottoInput = buildOttoJobInput(opts, schedule, logger);
        if (!ottoInput) {
          process.exitCode = 1;
          return;
        }
        // Otto jobs are stored with the full Otto shape – the service
        // accepts them because the executor detects Otto payloads at runtime.
        const job = await service.createJob(ottoInput as CronJobCreate);
        if (opts.json) {
          logger.info(JSON.stringify(job, null, 2));
        } else {
          logger.info(`Created job: ${job.id}`);
          logger.info(`  Name: ${ottoInput.name}`);
          logger.info(`  Session: ${(ottoInput as Record<string, unknown>).sessionTarget ?? 'n/a'}`);
          logger.info(`  Wake: ${(ottoInput as Record<string, unknown>).wakeMode ?? 'next-heartbeat'}`);
          logger.info(`  Next run: ${job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : 'N/A'}`);
        }
      } else {
        // Base-style job creation
        const payload = parsePayloadOpts(opts);
        if (!payload) {
          logger.error('Choose exactly one payload: --prompt, --action, --event, --system-event, or --message');
          process.exitCode = 1;
          return;
        }

        const input: CronJobCreate = {
          name: opts.name,
          description: opts.description,
          enabled: !opts.disabled,
          deleteAfterRun: opts.deleteAfterRun || undefined,
          schedule,
          payload,
        };

        const job = await service.createJob(input);

        if (opts.json) {
          logger.info(JSON.stringify(job, null, 2));
        } else {
          logger.info(`Created job: ${job.id}`);
          logger.info(`  Name: ${job.name}`);
          logger.info(`  Enabled: ${job.enabled}`);
          logger.info(`  Next run: ${job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : 'N/A'}`);
        }
      }
    });

  // cron edit
  cron
    .command('edit')
    .description('Edit a cron job')
    .argument('<id>', 'Job ID')
    .option('--name <name>', 'Set name')
    .option('--description <text>', 'Set description')
    .option('--enable', 'Enable job')
    .option('--disable', 'Disable job')
    .option('--at <when>', 'Set one-shot time')
    .option('--every <duration>', 'Set interval')
    .option('--cron <expr>', 'Set cron expression')
    .option('--tz <iana>', 'Set timezone')
    .option('--json', 'Output JSON', false)
    .action(async (id, opts) => {
      const service = getCronService(ctx);
      if (!service) {
        process.exitCode = 1;
        return;
      }

      try {
        const patch: CronJobPatch = {};

        if (opts.name) patch.name = opts.name;
        if (opts.description) patch.description = opts.description;
        if (opts.enable) patch.enabled = true;
        if (opts.disable) patch.enabled = false;

        // Parse schedule if provided
        const schedule = parseScheduleOpts(opts);
        if (schedule) {
          patch.schedule = schedule;
        }

        const job = await service.updateJob(id, patch);

        if (opts.json) {
          logger.info(JSON.stringify(job, null, 2));
        } else {
          logger.info(`Updated job: ${job.id}`);
        }
      } catch (err) {
        logger.error(`Failed to update job: ${err}`);
        process.exitCode = 1;
      }
    });

  // cron rm
  cron
    .command('rm')
    .alias('remove')
    .alias('delete')
    .description('Remove a cron job')
    .argument('<id>', 'Job ID')
    .option('--json', 'Output JSON', false)
    .action(async (id, opts) => {
      const service = getCronService(ctx);
      if (!service) {
        process.exitCode = 1;
        return;
      }

      try {
        const deleted = await service.deleteJob(id);

        if (opts.json) {
          logger.info(JSON.stringify({ deleted }, null, 2));
        } else {
          logger.info(deleted ? `Deleted job: ${id}` : `Job not found: ${id}`);
        }
      } catch (err) {
        logger.error(`Failed to delete job: ${err}`);
        process.exitCode = 1;
      }
    });

  // cron enable
  cron
    .command('enable')
    .description('Enable a cron job')
    .argument('<id>', 'Job ID')
    .action(async (id) => {
      const service = getCronService(ctx);
      if (!service) {
        process.exitCode = 1;
        return;
      }

      try {
        await service.updateJob(id, { enabled: true });
        logger.info(`Enabled job: ${id}`);
      } catch (err) {
        logger.error(`Failed to enable job: ${err}`);
        process.exitCode = 1;
      }
    });

  // cron disable
  cron
    .command('disable')
    .description('Disable a cron job')
    .argument('<id>', 'Job ID')
    .action(async (id) => {
      const service = getCronService(ctx);
      if (!service) {
        process.exitCode = 1;
        return;
      }

      try {
        await service.updateJob(id, { enabled: false });
        logger.info(`Disabled job: ${id}`);
      } catch (err) {
        logger.error(`Failed to disable job: ${err}`);
        process.exitCode = 1;
      }
    });

  // cron run
  cron
    .command('run')
    .description('Run a cron job now')
    .argument('<id>', 'Job ID')
    .option('--force', 'Run even if not due', false)
    .action(async (id, opts) => {
      const service = getCronService(ctx);
      if (!service) {
        process.exitCode = 1;
        return;
      }

      try {
        const result = await service.runJob(id, opts.force ? 'force' : 'due');
        logger.info(JSON.stringify(result, null, 2));
      } catch (err) {
        logger.error(`Failed to run job: ${err}`);
        process.exitCode = 1;
      }
    });
}

/**
 * Parse schedule options from CLI flags
 */
function parseScheduleOpts(opts: Record<string, unknown>): CronSchedule | null {
  const at = typeof opts.at === 'string' ? opts.at : '';
  const every = typeof opts.every === 'string' ? opts.every : '';
  const cronExpr = typeof opts.cron === 'string' ? opts.cron : '';

  const chosen = [Boolean(at), Boolean(every), Boolean(cronExpr)].filter(Boolean).length;

  if (chosen === 0) return null;
  if (chosen > 1) return null;

  if (at) {
    const atIso = parseAt(at);
    if (!atIso) return null;
    return { kind: 'at', at: atIso };
  }

  if (every) {
    const everyMs = parseDurationMs(every);
    if (!everyMs) return null;
    return { kind: 'every', everyMs };
  }

  if (cronExpr) {
    const tz = typeof opts.tz === 'string' && opts.tz.trim() ? opts.tz.trim() : undefined;
    return { kind: 'cron', expr: cronExpr, tz };
  }

  return null;
}

/**
 * Parse payload options from CLI flags (base plugin payloads).
 */
function parsePayloadOpts(opts: Record<string, unknown>): CronPayload | null {
  const prompt = typeof opts.prompt === 'string' ? opts.prompt : '';
  const action = typeof opts.action === 'string' ? opts.action : '';
  const event = typeof opts.event === 'string' ? opts.event : '';

  const chosen = [Boolean(prompt), Boolean(action), Boolean(event)].filter(Boolean).length;

  if (chosen === 0) return null;
  if (chosen > 1) return null;

  if (prompt) {
    return { kind: 'prompt', text: prompt };
  }

  if (action) {
    return { kind: 'action', actionName: action };
  }

  if (event) {
    return { kind: 'event', eventName: event };
  }

  return null;
}

/**
 * Build an Otto-style job input from CLI flags.
 * Returns null and logs an error if the flags are inconsistent.
 */
function buildOttoJobInput(
  opts: Record<string, unknown>,
  schedule: CronSchedule,
  cliLogger: CliLogger,
): Record<string, unknown> | null {
  const systemEvent = typeof opts.systemEvent === 'string' ? opts.systemEvent.trim() : '';
  const message = typeof opts.message === 'string' ? opts.message.trim() : '';

  // Determine session target
  let sessionTarget: string;
  if (typeof opts.session === 'string') {
    sessionTarget = opts.session.trim().toLowerCase();
  } else if (systemEvent) {
    sessionTarget = 'main';
  } else if (message) {
    sessionTarget = 'isolated';
  } else {
    cliLogger.error('Provide --system-event (main) or --message (isolated)');
    return null;
  }

  if (sessionTarget !== 'main' && sessionTarget !== 'isolated') {
    cliLogger.error('--session must be "main" or "isolated"');
    return null;
  }

  // Build payload
  let payload: OttoPayload;

  if (sessionTarget === 'main') {
    if (!systemEvent) {
      cliLogger.error('Main session jobs require --system-event <text>');
      return null;
    }
    payload = { kind: 'systemEvent', text: systemEvent };
  } else {
    if (!message) {
      cliLogger.error('Isolated session jobs require --message <text>');
      return null;
    }
    payload = { kind: 'agentTurn', message };
  }

  // Build delivery
  let delivery: CronDelivery | undefined;
  if (sessionTarget === 'isolated' && (opts.announce || opts.channel || opts.to)) {
    delivery = {
      mode: opts.announce ? 'announce' : 'none',
      channel: typeof opts.channel === 'string' ? opts.channel.trim() : 'last',
      to: typeof opts.to === 'string' ? opts.to.trim() : undefined,
    };
  }

  // Wake mode
  const wakeMode = typeof opts.wake === 'string' && opts.wake.trim() === 'now'
    ? 'now'
    : 'next-heartbeat';

  return {
    name: typeof opts.name === 'string' ? opts.name : '',
    description: typeof opts.description === 'string' ? opts.description : undefined,
    enabled: !opts.disabled,
    deleteAfterRun: Boolean(opts.deleteAfterRun) || (schedule.kind === 'at' ? true : undefined),
    schedule,
    sessionTarget,
    wakeMode,
    payload,
    delivery,
    agentId: typeof opts.agent === 'string' && opts.agent.trim() ? opts.agent.trim() : undefined,
  };
}
