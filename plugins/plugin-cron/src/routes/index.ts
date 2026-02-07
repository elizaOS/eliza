/**
 * @module routes
 * @description HTTP route handlers for cron management.
 *
 * These routes expose the CronService via the Eliza plugin routes system.
 * The UI (apps/ui) calls these endpoints for cron management:
 *   /api/cron/list, /api/cron/status, /api/cron/add, /api/cron/update,
 *   /api/cron/remove, /api/cron/run, /api/cron/runs
 */

import type { Route, RouteRequest, RouteResponse, IAgentRuntime } from '@elizaos/core';
import { CRON_SERVICE_TYPE } from '../constants.js';
import type { CronService } from '../services/cron-service.js';
import {
  normalizeCronJobCreate,
  normalizeCronJobPatch,
  resolveCronRunLogPath,
  readCronRunLogEntries,
  resolveCronStorePath,
} from '../otto/index.js';

function getCronService(runtime: IAgentRuntime): CronService {
  const svc = runtime.getService(CRON_SERVICE_TYPE) as CronService | undefined;
  if (!svc) {
    throw new Error('CronService not available');
  }
  return svc;
}

// ─── Route handlers ─────────────────────────────────────────────────────────

async function handleCronStatus(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const svc = getCronService(runtime);
  const status = await svc.getStatus();
  // nextWakeAtMs: expose from timer manager if available, otherwise omit
  res.json({
    enabled: status.initialized,
    jobs: status.jobCount,
    tracked: status.trackedJobCount,
    config: status.config,
  });
}

async function handleCronList(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const includeDisabled = req.body?.includeDisabled === true;
  const svc = getCronService(runtime);
  const jobs = await svc.listJobs({ includeDisabled });
  res.json({ jobs });
}

async function handleCronAdd(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const normalized = normalizeCronJobCreate(body);
  if (!normalized) {
    res.status(400).json({ error: 'Invalid job input' });
    return;
  }
  const svc = getCronService(runtime);
  const job = await svc.createJob(normalized as Parameters<CronService['createJob']>[0]);
  res.json({ job });
}

async function handleCronUpdate(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const jobId =
    typeof body.jobId === 'string'
      ? body.jobId
      : typeof body.id === 'string'
        ? body.id
        : '';
  if (!jobId) {
    res.status(400).json({ error: 'Missing jobId' });
    return;
  }
  const patch = normalizeCronJobPatch(body.patch ?? body);
  if (!patch) {
    res.status(400).json({ error: 'Invalid patch' });
    return;
  }
  const svc = getCronService(runtime);
  const job = await svc.updateJob(jobId, patch as Parameters<CronService['updateJob']>[1]);
  res.json({ job });
}

async function handleCronRemove(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const jobId =
    typeof body.jobId === 'string'
      ? body.jobId
      : typeof body.id === 'string'
        ? body.id
        : '';
  if (!jobId) {
    res.status(400).json({ error: 'Missing jobId' });
    return;
  }
  const svc = getCronService(runtime);
  const deleted = await svc.deleteJob(jobId);
  res.json({ deleted });
}

async function handleCronRun(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const jobId =
    typeof body.jobId === 'string'
      ? body.jobId
      : typeof body.id === 'string'
        ? body.id
        : '';
  if (!jobId) {
    res.status(400).json({ error: 'Missing jobId' });
    return;
  }
  const mode = body.mode === 'due' ? 'due' as const : 'force' as const;
  const svc = getCronService(runtime);
  const result = await svc.runJob(jobId, mode);
  res.json(result);
}

async function handleCronRuns(
  req: RouteRequest,
  res: RouteResponse,
  _runtime: IAgentRuntime,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const jobId = typeof body.id === 'string' ? body.id : '';
  const limit = typeof body.limit === 'number' ? body.limit : 50;

  if (!jobId) {
    res.status(400).json({ error: 'Missing id' });
    return;
  }

  const storePath = resolveCronStorePath();
  if (!storePath) {
    res.json({ entries: [] });
    return;
  }
  const logPath = resolveCronRunLogPath({ storePath, jobId });
  const entries = await readCronRunLogEntries(logPath, { limit, jobId });
  res.json({ entries });
}

// ─── Export routes ──────────────────────────────────────────────────────────

export const cronRoutes: Route[] = [
  { type: 'POST', path: '/api/cron/status', handler: handleCronStatus },
  { type: 'POST', path: '/api/cron/list', handler: handleCronList },
  { type: 'POST', path: '/api/cron/add', handler: handleCronAdd },
  { type: 'POST', path: '/api/cron/update', handler: handleCronUpdate },
  { type: 'POST', path: '/api/cron/remove', handler: handleCronRemove },
  { type: 'POST', path: '/api/cron/run', handler: handleCronRun },
  { type: 'POST', path: '/api/cron/runs', handler: handleCronRuns },
];
