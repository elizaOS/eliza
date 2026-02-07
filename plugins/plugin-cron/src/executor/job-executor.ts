/**
 * @module job-executor
 * @description Executes cron job payloads with timeout and error handling
 *
 * Execution strategies by payload type:
 * - prompt: Uses runtime.useModel() to process the prompt
 * - action: Finds and invokes the named action via runtime.processActions()
 * - event: Emits an event via runtime.emitEvent()
 */

import type { IAgentRuntime, Memory, UUID, Content } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import type {
  CronJob,
  CronPayload,
  CronExecutionResult,
  CronExecutionContext,
  CronServiceConfig,
  CronJobStatus,
} from '../types.js';
import { DEFAULT_CRON_CONFIG } from '../types.js';
import { isOttoPayload } from '../otto/detect.js';
import { executeOttoJob } from '../otto/executor.js';
import type { CronJob as OttoCronJob } from '../otto/types.js';

/**
 * Creates an abort controller with timeout
 */
function createTimeoutController(timeoutMs: number): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error('Job execution timeout'));
  }, timeoutMs);

  return {
    controller,
    cleanup: () => clearTimeout(timer),
  };
}

/**
 * Wraps an async operation with a timeout that actually enforces the time limit.
 * Unlike just using AbortController (which requires the operation to support it),
 * this uses Promise.race to guarantee the timeout is enforced.
 */
async function withEnforcedTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal
): Promise<T> {
  // Check if already aborted before starting
  if (signal.aborted) {
    throw new Error('Job execution timeout');
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Job execution timeout'));
    }, timeoutMs);

    // Also listen for abort signal
    signal.addEventListener('abort', () => {
      clearTimeout(timeoutId);
      reject(new Error('Job execution timeout'));
    });
  });

  // Race the operation against the timeout
  return Promise.race([operation(), timeoutPromise]);
}

/**
 * Executes a prompt payload
 */
async function executePromptPayload(
  runtime: IAgentRuntime,
  payload: Extract<CronPayload, { kind: 'prompt' }>,
  context: CronExecutionContext
): Promise<string> {
  // Build a context prefix for the cron job
  const cronContext = `[Cron Job: ${context.job.name}]${context.job.description ? ` - ${context.job.description}` : ''}`;

  // Include context in the prompt itself
  const fullPrompt = `${cronContext}\n\n${payload.text}`;

  // Use the runtime's text generation
  const result = await runtime.useModel('TEXT_LARGE', {
    prompt: fullPrompt,
  });

  return result;
}

/**
 * Executes an action payload
 */
async function executeActionPayload(
  runtime: IAgentRuntime,
  payload: Extract<CronPayload, { kind: 'action' }>,
  context: CronExecutionContext
): Promise<string> {
  // Find the action by name
  const actions = runtime.actions ?? [];
  const action = actions.find(
    (a) => a.name.toLowerCase() === payload.actionName.toLowerCase()
  );

  if (!action) {
    throw new Error(`Action not found: ${payload.actionName}`);
  }

  // Create a synthetic memory for the action
  const roomId = payload.roomId || (runtime.agentId as UUID);
  const memory: Memory = {
    id: uuidv4() as UUID,
    entityId: runtime.agentId,
    roomId,
    agentId: runtime.agentId,
    content: {
      text: `[Cron Job: ${context.job.name}] Executing action: ${payload.actionName}`,
      // Spread params into content for actions to access
      ...(payload.params as Record<string, unknown>),
    } as Content,
    createdAt: Date.now(),
  };

  // Collect responses from callback
  const callbackResponses: string[] = [];
  const callback = async (response: Content): Promise<Memory[]> => {
    if (response.text) {
      callbackResponses.push(response.text);
    }
    return [];
  };

  // Validate the action
  const isValid = await action.validate(runtime, memory, undefined);
  if (!isValid) {
    throw new Error(`Action validation failed: ${payload.actionName}`);
  }

  // Execute the action and capture the return value
  const handlerResult = await action.handler(runtime, memory, undefined, undefined, callback);

  // Build output from both callback responses and handler return value
  const outputParts: string[] = [];

  // Include callback responses
  if (callbackResponses.length > 0) {
    outputParts.push(...callbackResponses);
  }

  // Include handler result if it provides useful data
  if (handlerResult !== undefined && handlerResult !== null) {
    if (typeof handlerResult === 'string') {
      outputParts.push(handlerResult);
    } else if (typeof handlerResult === 'object') {
      // Try to extract meaningful data from the result
      const result = handlerResult as unknown as Record<string, unknown>;
      if (result.text && typeof result.text === 'string') {
        outputParts.push(result.text);
      } else if (result.success !== undefined || result.data !== undefined) {
        // Include structured result summary
        outputParts.push(JSON.stringify(handlerResult));
      }
    }
  }

  return outputParts.join('\n') || `Action ${payload.actionName} completed`;
}

/**
 * Executes an event payload
 */
async function executeEventPayload(
  runtime: IAgentRuntime,
  payload: Extract<CronPayload, { kind: 'event' }>,
  context: CronExecutionContext
): Promise<string> {
  // Build the event payload
  const eventPayload = {
    runtime,
    source: `cron:${context.job.id}`,
    cronJob: {
      id: context.job.id,
      name: context.job.name,
    },
    ...(payload.payload || {}),
  };

  // Emit the event
  await runtime.emitEvent(payload.eventName, eventPayload);

  return `Event ${payload.eventName} emitted`;
}

/**
 * Executes a cron job payload
 * @param runtime The agent runtime
 * @param job The cron job to execute
 * @param config Service configuration
 * @returns Execution result
 */
export async function executeJob(
  runtime: IAgentRuntime,
  job: CronJob,
  config: CronServiceConfig
): Promise<CronExecutionResult> {
  // Delegate Otto-specific payloads (systemEvent, agentTurn) to the Otto executor.
  // These payloads use Eliza's messageService.handleMessage() and room system
  // rather than raw useModel() calls.
  const payloadRecord = job.payload as unknown as Record<string, unknown>;
  if (isOttoPayload(payloadRecord)) {
    return executeOttoJob(runtime, job as unknown as OttoCronJob, config);
  }

  const startedAtMs = Date.now();

  // Determine timeout
  let timeoutMs = config.defaultTimeoutMs ?? DEFAULT_CRON_CONFIG.defaultTimeoutMs;
  if (job.payload.kind === 'prompt' && job.payload.timeoutSeconds) {
    timeoutMs = job.payload.timeoutSeconds * 1000;
  }

  // Create abort controller with timeout
  const { controller, cleanup } = createTimeoutController(timeoutMs);

  const context: CronExecutionContext = {
    job,
    startedAtMs,
    signal: controller.signal,
  };

  let status: CronJobStatus = 'ok';
  let output: string | undefined;
  let error: string | undefined;

  try {
    // Check if already aborted
    if (controller.signal.aborted) {
      throw new Error('Job execution timeout');
    }

    // Execute based on payload type, with enforced timeout
    // This ensures the operation actually times out even if the underlying
    // API doesn't support abort signals
    const executeOperation = async (): Promise<string> => {
      switch (job.payload.kind) {
        case 'prompt':
          return executePromptPayload(runtime, job.payload, context);

        case 'action':
          return executeActionPayload(runtime, job.payload, context);

        case 'event':
          return executeEventPayload(runtime, job.payload, context);

        default: {
          const _exhaustive: never = job.payload;
          throw new Error(`Unknown payload kind: ${(job.payload as CronPayload).kind}`);
        }
      }
    };

    output = await withEnforcedTimeout(executeOperation, timeoutMs, controller.signal);
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === 'Job execution timeout' || controller.signal.aborted) {
        status = 'timeout';
        error = 'Execution timed out';
      } else {
        status = 'error';
        error = err.message;
      }
    } else {
      status = 'error';
      error = String(err);
    }
  } finally {
    cleanup();
  }

  const durationMs = Date.now() - startedAtMs;

  return {
    status,
    durationMs,
    output,
    error,
  };
}

/**
 * Validates that a job can be executed
 * @returns Error message if invalid, null if valid
 */
export function validateJobExecutability(
  runtime: IAgentRuntime,
  job: CronJob
): string | null {
  const { payload } = job;

  // Otto payloads are validated differently – they just need non-empty text/message
  const payloadRecord = payload as unknown as Record<string, unknown>;
  if (isOttoPayload(payloadRecord)) {
    if (payloadRecord.kind === 'systemEvent') {
      const text = typeof payloadRecord.text === 'string' ? payloadRecord.text.trim() : '';
      return text ? null : 'systemEvent payload must have non-empty text';
    }
    if (payloadRecord.kind === 'agentTurn') {
      const message = typeof payloadRecord.message === 'string' ? payloadRecord.message.trim() : '';
      return message ? null : 'agentTurn payload must have non-empty message';
    }
    return null;
  }

  switch (payload.kind) {
    case 'prompt': {
      // Validate prompt payload has actual text content
      const text = payload.text?.trim();
      if (!text) {
        return 'Prompt payload must have non-empty text';
      }
      // Verify runtime has model capability
      if (typeof runtime.useModel !== 'function') {
        return 'Runtime does not support useModel for prompt execution';
      }
      return null;
    }

    case 'event': {
      // Validate event payload has a valid event name
      const eventName = payload.eventName?.trim();
      if (!eventName) {
        return 'Event payload must have non-empty eventName';
      }
      // Verify runtime has event emitting capability
      if (typeof runtime.emitEvent !== 'function') {
        return 'Runtime does not support emitEvent for event execution';
      }
      return null;
    }

    case 'action': {
      // Validate action name is present
      const actionName = payload.actionName?.trim();
      if (!actionName) {
        return 'Action payload must have non-empty actionName';
      }
      const actions = runtime.actions ?? [];
      const action = actions.find(
        (a) => a.name.toLowerCase() === actionName.toLowerCase()
      );
      return action ? null : `Action not found: ${payload.actionName}`;
    }

    default: {
      // Unknown payload kind – could be a future extension
      return `Unknown payload kind: ${(payload as { kind: string }).kind}`;
    }
  }
}
