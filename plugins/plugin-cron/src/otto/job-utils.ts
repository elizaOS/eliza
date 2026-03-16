/**
 * @module otto/job-utils
 * @description Utility functions for cron job manipulation
 *
 * These functions handle job creation, patching, and validation,
 * including backward-compatible legacy delivery field handling.
 */

import type {
  CronDelivery,
  CronDeliveryPatch,
  CronJob,
  CronJobPatch,
  CronPayload,
  CronPayloadPatch,
} from './types.js';

/**
 * Validates that the job spec is valid for the given session target
 */
export function assertSupportedJobSpec(job: Pick<CronJob, 'sessionTarget' | 'payload'>): void {
  if (job.sessionTarget === 'main' && job.payload.kind !== 'systemEvent') {
    throw new Error('main cron jobs require payload.kind="systemEvent"');
  }
  if (job.sessionTarget === 'isolated' && job.payload.kind !== 'agentTurn') {
    throw new Error('isolated cron jobs require payload.kind="agentTurn"');
  }
}

/**
 * Validates that delivery config is only used with isolated sessions
 */
export function assertDeliverySupport(job: Pick<CronJob, 'sessionTarget' | 'delivery'>): void {
  if (job.delivery && job.sessionTarget !== 'isolated') {
    throw new Error('cron delivery config is only supported for sessionTarget="isolated"');
  }
}

/**
 * Normalizes a name field - trims and ensures non-empty
 */
export function normalizeRequiredName(name: unknown): string {
  const val = typeof name === 'string' ? name.trim() : '';
  if (!val) {
    throw new Error('cron job name is required');
  }
  return val;
}

/**
 * Normalizes an optional text field
 */
export function normalizeOptionalText(text: unknown): string | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }
  const trimmed = text.trim();
  return trimmed || undefined;
}

/**
 * Normalizes an optional agent ID
 */
export function normalizeOptionalAgentId(agentId: unknown): string | undefined {
  if (typeof agentId !== 'string') {
    return undefined;
  }
  const trimmed = agentId.trim().toLowerCase();
  return trimmed || undefined;
}

/**
 * Applies a patch to a job in place, handling legacy delivery fields
 */
export function applyJobPatch(job: CronJob, patch: CronJobPatch): void {
  if ('name' in patch) {
    job.name = normalizeRequiredName(patch.name);
  }
  if ('description' in patch) {
    job.description = normalizeOptionalText(patch.description);
  }
  if (typeof patch.enabled === 'boolean') {
    job.enabled = patch.enabled;
  }
  if (typeof patch.deleteAfterRun === 'boolean') {
    job.deleteAfterRun = patch.deleteAfterRun;
  }
  if (patch.schedule) {
    job.schedule = patch.schedule;
  }
  if (patch.sessionTarget) {
    job.sessionTarget = patch.sessionTarget;
  }
  if (patch.wakeMode) {
    job.wakeMode = patch.wakeMode;
  }
  if (patch.payload) {
    job.payload = mergeCronPayload(job.payload, patch.payload);
  }
  if (!patch.delivery && patch.payload?.kind === 'agentTurn') {
    // Back-compat: legacy clients still update delivery via payload fields.
    const legacyDeliveryPatch = buildLegacyDeliveryPatch(patch.payload);
    if (
      legacyDeliveryPatch &&
      job.sessionTarget === 'isolated' &&
      job.payload.kind === 'agentTurn'
    ) {
      job.delivery = mergeCronDelivery(job.delivery, legacyDeliveryPatch);
    }
  }
  if (patch.delivery) {
    job.delivery = mergeCronDelivery(job.delivery, patch.delivery);
  }
  if (job.sessionTarget === 'main' && job.delivery) {
    job.delivery = undefined;
  }
  if (patch.state) {
    job.state = { ...job.state, ...patch.state };
  }
  if ('agentId' in patch) {
    job.agentId = normalizeOptionalAgentId((patch as { agentId?: unknown }).agentId);
  }
  assertSupportedJobSpec(job);
  assertDeliverySupport(job);
}

/**
 * Merges a payload patch into an existing payload
 */
function mergeCronPayload(existing: CronPayload, patch: CronPayloadPatch): CronPayload {
  if (patch.kind !== existing.kind) {
    return buildPayloadFromPatch(patch);
  }

  if (patch.kind === 'systemEvent') {
    if (existing.kind !== 'systemEvent') {
      return buildPayloadFromPatch(patch);
    }
    const text = typeof patch.text === 'string' ? patch.text : existing.text;
    return { kind: 'systemEvent', text };
  }

  if (existing.kind !== 'agentTurn') {
    return buildPayloadFromPatch(patch);
  }

  const next: Extract<CronPayload, { kind: 'agentTurn' }> = { ...existing };
  if (typeof patch.message === 'string') {
    next.message = patch.message;
  }
  if (typeof patch.model === 'string') {
    next.model = patch.model;
  }
  if (typeof patch.thinking === 'string') {
    next.thinking = patch.thinking;
  }
  if (typeof patch.timeoutSeconds === 'number') {
    next.timeoutSeconds = patch.timeoutSeconds;
  }
  if (typeof patch.deliver === 'boolean') {
    next.deliver = patch.deliver;
  }
  if (typeof patch.channel === 'string') {
    next.channel = patch.channel;
  }
  if (typeof patch.to === 'string') {
    next.to = patch.to;
  }
  if (typeof patch.bestEffortDeliver === 'boolean') {
    next.bestEffortDeliver = patch.bestEffortDeliver;
  }
  return next;
}

/**
 * Builds a delivery patch from legacy payload fields
 */
function buildLegacyDeliveryPatch(
  payload: Extract<CronPayloadPatch, { kind: 'agentTurn' }>
): CronDeliveryPatch | null {
  const deliver = payload.deliver;
  const toRaw = typeof payload.to === 'string' ? payload.to.trim() : '';
  const hasLegacyHints =
    typeof deliver === 'boolean' ||
    typeof payload.bestEffortDeliver === 'boolean' ||
    Boolean(toRaw);
  if (!hasLegacyHints) {
    return null;
  }

  const patch: CronDeliveryPatch = {};
  let hasPatch = false;

  if (deliver === false) {
    patch.mode = 'none';
    hasPatch = true;
  } else if (deliver === true || toRaw) {
    patch.mode = 'announce';
    hasPatch = true;
  }

  if (typeof payload.channel === 'string') {
    const channel = payload.channel.trim().toLowerCase();
    patch.channel = channel ? channel : undefined;
    hasPatch = true;
  }
  if (typeof payload.to === 'string') {
    patch.to = payload.to.trim();
    hasPatch = true;
  }
  if (typeof payload.bestEffortDeliver === 'boolean') {
    patch.bestEffort = payload.bestEffortDeliver;
    hasPatch = true;
  }

  return hasPatch ? patch : null;
}

/**
 * Builds a payload from a patch (when switching payload kinds)
 */
function buildPayloadFromPatch(patch: CronPayloadPatch): CronPayload {
  if (patch.kind === 'systemEvent') {
    if (typeof patch.text !== 'string' || patch.text.length === 0) {
      throw new Error('cron.update payload.kind="systemEvent" requires text');
    }
    return { kind: 'systemEvent', text: patch.text };
  }

  if (typeof patch.message !== 'string' || patch.message.length === 0) {
    throw new Error('cron.update payload.kind="agentTurn" requires message');
  }

  return {
    kind: 'agentTurn',
    message: patch.message,
    model: patch.model,
    thinking: patch.thinking,
    timeoutSeconds: patch.timeoutSeconds,
    deliver: patch.deliver,
    channel: patch.channel,
    to: patch.to,
    bestEffortDeliver: patch.bestEffortDeliver,
  };
}

/**
 * Merges a delivery patch into an existing delivery config
 */
function mergeCronDelivery(
  existing: CronDelivery | undefined,
  patch: CronDeliveryPatch
): CronDelivery {
  const next: CronDelivery = {
    mode: existing?.mode ?? 'none',
    channel: existing?.channel,
    to: existing?.to,
    bestEffort: existing?.bestEffort,
  };

  if (typeof patch.mode === 'string') {
    next.mode = (patch.mode as string) === 'deliver' ? 'announce' : patch.mode;
  }
  if ('channel' in patch) {
    const channel = typeof patch.channel === 'string' ? patch.channel.trim() : '';
    next.channel = channel ? channel : undefined;
  }
  if ('to' in patch) {
    const to = typeof patch.to === 'string' ? patch.to.trim() : '';
    next.to = to ? to : undefined;
  }
  if (typeof patch.bestEffort === 'boolean') {
    next.bestEffort = patch.bestEffort;
  }

  return next;
}
