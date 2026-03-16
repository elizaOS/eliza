/**
 * @module otto/executor
 * @description Otto-specific job executor.
 *
 * Handles the two Otto payload kinds:
 *
 *  - systemEvent: pushes text to the heartbeat system events queue and
 *    optionally triggers an immediate heartbeat wake.
 *
 *  - agentTurn:  creates an isolated room (cron:<jobId>), sends the
 *    message via messageService.handleMessage() so the agent processes
 *    it through its normal pipeline, captures the response, and delivers
 *    it to the configured channel via sendMessageToTarget().
 *
 * This module follows the same connector pattern as Discord/Telegram –
 * it is an "internal connector" that manufactures Memory objects and
 * calls handleMessage().
 */

import {
  logger,
  stringToUuid,
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type Content,
  type UUID,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import type { CronExecutionResult, CronJobStatus, CronServiceConfig } from '../types.js';
import { DEFAULT_CRON_CONFIG } from '../types.js';
import type { CronJob, CronPayload } from './types.js';
import { resolveCronDeliveryPlan } from './delivery.js';
import { pushSystemEvent } from '../heartbeat/queue.js';
import { wakeHeartbeatNow } from '../heartbeat/worker.js';
import { deliverToTarget } from '../heartbeat/delivery.js';

// ─── Timeout helper ─────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Job execution timeout')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

// ─── systemEvent execution ──────────────────────────────────────────────────

async function executeSystemEvent(
  runtime: IAgentRuntime,
  job: CronJob,
  payload: Extract<CronPayload, { kind: 'systemEvent' }>,
): Promise<CronExecutionResult> {
  const startedAtMs = Date.now();

  pushSystemEvent(runtime.agentId as string, payload.text, `cron:${job.id}`);
  logger.info(`[Otto Executor] Queued system event for heartbeat: "${payload.text.slice(0, 80)}"`);

  if (job.wakeMode === 'now') {
    await wakeHeartbeatNow(runtime);
  }

  return {
    status: 'ok',
    durationMs: Date.now() - startedAtMs,
    output: `System event queued (wake: ${job.wakeMode})`,
  };
}

// ─── agentTurn execution ────────────────────────────────────────────────────

/**
 * Ensure the isolated cron room exists.
 */
async function ensureCronRoom(runtime: IAgentRuntime, jobId: string, jobName: string): Promise<UUID> {
  const roomKey = `cron:${jobId}`;
  const roomId = stringToUuid(`${runtime.agentId}-${roomKey}`) as UUID;

  const existing = await runtime.getRoom(roomId);
  if (!existing) {
    await runtime.createRoom({
      id: roomId,
      name: `Cron: ${jobName}`,
      source: 'cron',
      type: ChannelType.GROUP,
      channelId: roomKey,
    });
    await runtime.addParticipant(runtime.agentId, roomId);
  }

  return roomId;
}

async function executeAgentTurn(
  runtime: IAgentRuntime,
  job: CronJob,
  payload: Extract<CronPayload, { kind: 'agentTurn' }>,
  config: CronServiceConfig,
): Promise<CronExecutionResult> {
  const startedAtMs = Date.now();
  const timeoutMs = payload.timeoutSeconds
    ? payload.timeoutSeconds * 1000
    : (config.defaultTimeoutMs ?? DEFAULT_CRON_CONFIG.defaultTimeoutMs);

  // 1. Ensure isolated room
  const roomId = await ensureCronRoom(runtime, job.id, job.name);

  // 2. Build prompt
  const promptPrefix = `[cron:${job.id} ${job.name}]`;
  const messageText = `${promptPrefix} ${payload.message}`;

  // 3. Create Memory (same pattern as Discord/Telegram connectors)
  const messageId = uuidv4() as UUID;
  const memory: Memory = {
    id: messageId,
    entityId: runtime.agentId,
    roomId,
    agentId: runtime.agentId,
    content: { text: messageText } as Content,
    createdAt: Date.now(),
  };

  // 4. Capture response via callback
  let responseText = '';
  const callback = async (response: Content): Promise<Memory[]> => {
    if (response.text) {
      responseText += response.text;
    }
    return [];
  };

  // 5. Execute via messageService (with timeout)
  let status: CronJobStatus = 'ok';
  let error: string | undefined;

  if (!runtime.messageService) {
    return {
      status: 'error',
      durationMs: Date.now() - startedAtMs,
      error: 'Runtime messageService is not available',
    };
  }
  const runPromise = runtime.messageService.handleMessage(runtime, memory, callback);
  await withTimeout(runPromise, timeoutMs).catch((err: Error) => {
    if (err.message === 'Job execution timeout') {
      status = 'timeout';
      error = 'Execution timed out';
    } else {
      status = 'error';
      error = err.message;
    }
  });

  const durationMs = Date.now() - startedAtMs;

  if (status !== 'ok') {
    return { status, durationMs, error };
  }

  // 6. Delivery
  const plan = resolveCronDeliveryPlan(job);

  if (plan.requested && responseText.trim() && responseText.trim() !== 'HEARTBEAT_OK') {
    logger.info(
      `[Otto Executor] Delivering response for "${job.name}" to ${plan.channel}${plan.to ? `:${plan.to}` : ''}`
    );

    const deliveryError = await deliverToTarget(
      runtime,
      { text: responseText } as Content,
      plan.channel,
      plan.to,
      job.delivery?.bestEffort,
    ).then(() => null, (err: Error) => err);

    if (deliveryError) {
      return {
        status: 'error' as CronJobStatus,
        durationMs: Date.now() - startedAtMs,
        output: responseText,
        error: `Delivery failed: ${deliveryError.message}`,
      };
    }
  }

  // 7. Post summary to main session heartbeat queue
  if (responseText.trim() && responseText.trim() !== 'HEARTBEAT_OK') {
    const summary = responseText.length > 200
      ? `${responseText.slice(0, 200)}…`
      : responseText;
    pushSystemEvent(
      runtime.agentId as string,
      `[Cron "${job.name}" completed] ${summary}`,
      `cron:${job.id}`,
    );

    if (job.wakeMode === 'now') {
      await wakeHeartbeatNow(runtime);
    }
  }

  return {
    status: 'ok',
    durationMs,
    output: responseText || undefined,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

// Re-export from detect.ts (separate file to avoid pulling @elizaos/core in tests)
export { isOttoPayload } from './detect.js';

/**
 * Execute an Otto job. Called from the main CronService when the payload
 * kind is systemEvent or agentTurn.
 */
export async function executeOttoJob(
  runtime: IAgentRuntime,
  job: CronJob,
  config: CronServiceConfig,
): Promise<CronExecutionResult> {
  const { payload } = job;

  switch (payload.kind) {
    case 'systemEvent':
      return executeSystemEvent(runtime, job, payload);

    case 'agentTurn':
      return executeAgentTurn(runtime, job, payload, config);

    default: {
      // Should not reach here if isOttoPayload() was checked first
      const kind = (payload as { kind: string }).kind;
      return {
        status: 'error',
        durationMs: 0,
        error: `Unknown Otto payload kind: ${kind}`,
      };
    }
  }
}
