/**
 * @module heartbeat/worker
 * @description Heartbeat TaskWorker for periodic agent wakeup.
 *
 * Registers as an Eliza TaskWorker named "heartbeat".
 * On each tick the worker:
 *   1. Checks active hours
 *   2. Drains the system events queue
 *   3. Reads HEARTBEAT.md from the workspace
 *   4. Sends a message into a heartbeat room via messageService.handleMessage()
 *   5. Captures the agent's response
 *   6. Suppresses HEARTBEAT_OK; otherwise delivers via sendMessageToTarget()
 */

import {
  logger,
  stringToUuid,
  ChannelType,
  type IAgentRuntime,
  type TaskWorker,
  type Task,
  type Memory,
  type Content,
  type UUID,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { resolveHeartbeatConfig, isWithinActiveHours, type HeartbeatConfig } from './config.js';
import { drainSystemEvents, type SystemEvent } from './queue.js';
import { deliverToTarget } from './delivery.js';

import fs from 'node:fs/promises';
import path from 'node:path';

const HEARTBEAT_OK_TOKEN = 'HEARTBEAT_OK';
const HEARTBEAT_ROOM_KEY = 'heartbeat:main';
const HEARTBEAT_WORKER_NAME = 'heartbeat';

/**
 * Attempt to read the heartbeat prompt file from the workspace.
 * Returns the file content or null if the file doesn't exist.
 */
async function readHeartbeatFile(runtime: IAgentRuntime, filename: string): Promise<string | null> {
  // Check character.settings.workspace or fall back to cwd
  const settings = (runtime.character?.settings ?? {}) as Record<string, unknown>;
  const workspace = typeof settings.workspace === 'string' ? settings.workspace : process.cwd();
  const filePath = path.resolve(workspace, filename);

  const content = await fs.readFile(filePath, 'utf-8').catch(() => null);
  return content;
}

/**
 * Build the heartbeat prompt that the agent will receive.
 */
function buildHeartbeatPrompt(
  heartbeatMd: string | null,
  events: SystemEvent[],
): string {
  const parts: string[] = [];

  parts.push('[Heartbeat]');

  if (heartbeatMd) {
    parts.push('');
    parts.push('# HEARTBEAT.md');
    parts.push(heartbeatMd.trim());
    parts.push('');
    parts.push('Follow the instructions in HEARTBEAT.md strictly.');
  }

  if (events.length > 0) {
    parts.push('');
    parts.push('## System events since last heartbeat');
    for (const ev of events) {
      const age = Math.round((Date.now() - ev.ts) / 1000);
      parts.push(`- [${ev.source}, ${age}s ago] ${ev.text}`);
    }
  }

  parts.push('');
  parts.push(
    'If nothing requires your attention right now, reply with exactly "HEARTBEAT_OK" and nothing else.'
  );

  return parts.join('\n');
}

/**
 * Check if a response is a heartbeat-only acknowledgement (no real content).
 */
function isHeartbeatOk(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed === HEARTBEAT_OK_TOKEN ||
    trimmed.startsWith(HEARTBEAT_OK_TOKEN + '\n') ||
    trimmed.startsWith(HEARTBEAT_OK_TOKEN + ' ')
  );
}

/**
 * Ensure the heartbeat room exists and the agent is a participant.
 */
async function ensureHeartbeatRoom(runtime: IAgentRuntime): Promise<UUID> {
  const roomId = stringToUuid(`${runtime.agentId}-${HEARTBEAT_ROOM_KEY}`) as UUID;

  const existing = await runtime.getRoom(roomId);
  if (!existing) {
    await runtime.createRoom({
      id: roomId,
      name: 'Heartbeat',
      source: 'cron',
      type: ChannelType.GROUP,
      channelId: HEARTBEAT_ROOM_KEY,
    });
    await runtime.addParticipant(runtime.agentId, roomId);
  }

  return roomId;
}

/**
 * Execute a single heartbeat tick.
 */
async function runHeartbeatTick(runtime: IAgentRuntime, config: HeartbeatConfig): Promise<void> {
  // 1. Active hours check
  if (!isWithinActiveHours(config.activeHours)) {
    logger.debug('[Heartbeat] Outside active hours, skipping');
    return;
  }

  // 2. Drain pending system events
  const events = drainSystemEvents(runtime.agentId as string);

  // 3. Read HEARTBEAT.md
  const heartbeatMd = await readHeartbeatFile(runtime, config.promptFile);

  // If no heartbeat file and no events, skip silently
  if (!heartbeatMd && events.length === 0) {
    logger.debug('[Heartbeat] No HEARTBEAT.md and no pending events, skipping');
    return;
  }

  // 4. Build prompt
  const promptText = buildHeartbeatPrompt(heartbeatMd, events);

  // 5. Send message into heartbeat room
  const roomId = await ensureHeartbeatRoom(runtime);
  const messageId = uuidv4() as UUID;

  const memory: Memory = {
    id: messageId,
    entityId: runtime.agentId,
    roomId,
    agentId: runtime.agentId,
    content: { text: promptText } as Content,
    createdAt: Date.now(),
  };

  // Capture the agent's response via callback
  let responseText = '';
  const callback = async (response: Content): Promise<Memory[]> => {
    if (response.text) {
      responseText += response.text;
    }
    return [];
  };

  logger.info(
    `[Heartbeat] Running tick (${events.length} pending events, HEARTBEAT.md: ${heartbeatMd ? 'yes' : 'no'})`
  );

  if (!runtime.messageService) {
    logger.warn('[Heartbeat] Runtime messageService is not available, skipping');
    return;
  }
  await runtime.messageService.handleMessage(runtime, memory, callback);

  // 6. Check response
  if (!responseText.trim() || isHeartbeatOk(responseText)) {
    logger.debug('[Heartbeat] Agent responded HEARTBEAT_OK, suppressing delivery');
    return;
  }

  // 7. Deliver response to target
  logger.info(`[Heartbeat] Agent has something to say, delivering to target "${config.target}"`);

  if (config.target === 'none') {
    return;
  }

  // Parse channel and to from the target config.
  // Formats: "last", "whatsapp", "discord:channel:123456"
  let channel: string;
  let to: string | undefined;

  if (config.target === 'last' || config.target === 'none') {
    channel = config.target;
  } else {
    const colonIdx = config.target.indexOf(':');
    if (colonIdx === -1) {
      channel = config.target;
    } else {
      channel = config.target.slice(0, colonIdx);
      to = config.target.slice(colonIdx + 1) || undefined;
    }
  }

  if (channel === 'none') {
    return;
  }

  await deliverToTarget(
    runtime,
    { text: responseText } as Content,
    channel,
    to,
    true, // bestEffort for heartbeat -- don't crash the tick on delivery failure
  );
}

/**
 * The heartbeat TaskWorker. Register this with the runtime and create
 * a recurring task to drive periodic heartbeats.
 */
export const heartbeatWorker: TaskWorker = {
  name: HEARTBEAT_WORKER_NAME,

  async execute(
    runtime: IAgentRuntime,
    _options: Record<string, unknown>,
    _task: Task,
  ): Promise<void> {
    const config = resolveHeartbeatConfig(runtime);
    if (!config.enabled) {
      return;
    }
    await runHeartbeatTick(runtime, config);
  },
};

/**
 * Register the heartbeat worker and create the recurring task.
 */
export async function startHeartbeat(runtime: IAgentRuntime): Promise<void> {
  const config = resolveHeartbeatConfig(runtime);
  if (!config.enabled) {
    logger.info('[Heartbeat] Disabled via config');
    return;
  }

  // Register the worker
  runtime.registerTaskWorker(heartbeatWorker);

  // Create the recurring task (if not already present)
  const existingTasks = await runtime.getTasks({
    roomId: runtime.agentId as UUID,
    tags: ['heartbeat', 'queue', 'repeat'],
  });

  const alreadyExists = existingTasks.some(
    (t) => t.name === HEARTBEAT_WORKER_NAME,
  );

  if (!alreadyExists) {
    await runtime.createTask({
      name: HEARTBEAT_WORKER_NAME,
      description: 'Periodic agent heartbeat – reads HEARTBEAT.md and checks system events',
      roomId: runtime.agentId as UUID,
      tags: ['heartbeat', 'queue', 'repeat'],
      metadata: {
        updateInterval: config.everyMs,
        updatedAt: Date.now(),
        blocking: true,
      },
    });
    logger.info(
      `[Heartbeat] Created recurring task (every ${Math.round(config.everyMs / 1000)}s)`
    );
  } else {
    logger.info('[Heartbeat] Recurring task already exists');
  }
}

/**
 * Trigger an immediate heartbeat. Creates a one-shot "immediate" task
 * that the TaskService will pick up on the next 1-second tick.
 */
export async function wakeHeartbeatNow(runtime: IAgentRuntime): Promise<void> {
  runtime.registerTaskWorker(heartbeatWorker);

  await runtime.createTask({
    name: HEARTBEAT_WORKER_NAME,
    description: 'Immediate heartbeat wake',
    roomId: runtime.agentId as UUID,
    tags: ['heartbeat', 'queue'],
    metadata: {
      updatedAt: 0, // ensures it runs immediately
      blocking: false,
    },
  });

  logger.info('[Heartbeat] Queued immediate wake');
}

export { HEARTBEAT_WORKER_NAME };
