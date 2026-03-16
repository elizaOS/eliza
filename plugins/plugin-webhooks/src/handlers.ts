/**
 * @module handlers
 * @description Route handlers for webhook endpoints.
 *
 * Three endpoints:
 *   POST /hooks/wake   - Enqueue system event + optional immediate heartbeat
 *   POST /hooks/agent  - Run isolated agent turn + optional delivery
 *   POST /hooks/:name  - Mapped webhook (resolves via hooks.mappings config)
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
import { validateToken } from './auth.js';
import { findMapping, applyMapping, type HookMapping } from './mappings.js';

// ─── Config resolution ──────────────────────────────────────────────────────

interface HooksConfig {
  token: string;
  mappings: HookMapping[];
  presets: string[];
}

const GMAIL_PRESET_MAPPING: HookMapping = {
  match: { path: 'gmail' },
  action: 'agent',
  name: 'Gmail',
  sessionKey: 'hook:gmail:{{messages[0].id}}',
  messageTemplate:
    'New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}',
  wakeMode: 'now',
  deliver: true,
  channel: 'last',
};

function resolveHooksConfig(runtime: IAgentRuntime): HooksConfig | null {
  const settings = (runtime.character?.settings ?? {}) as Record<string, unknown>;
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;

  if (hooks.enabled === false) {
    return null;
  }

  const token = typeof hooks.token === 'string' ? hooks.token.trim() : '';
  if (!token) {
    return null;
  }

  const rawMappings = Array.isArray(hooks.mappings) ? hooks.mappings : [];
  const mappings: HookMapping[] = rawMappings.filter(
    (m): m is HookMapping => typeof m === 'object' && m !== null,
  );

  const presets = Array.isArray(hooks.presets)
    ? (hooks.presets as string[]).filter((p) => typeof p === 'string')
    : [];

  // Apply presets
  if (presets.includes('gmail')) {
    const hasGmailMapping = mappings.some((m) => m.match?.path === 'gmail');
    if (!hasGmailMapping) {
      mappings.push(GMAIL_PRESET_MAPPING);
    }
  }

  return { token, mappings, presets };
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

// ─── Delivery ───────────────────────────────────────────────────────────────

/**
 * Deliver content to a channel, resolving "last" by scanning rooms.
 * Persists the successful route via a component on the agent entity.
 */
async function deliverToChannel(
  runtime: IAgentRuntime,
  content: Content,
  channel: string,
  to?: string,
): Promise<void> {
  // Resolve target
  let source: string;
  let channelId: string | undefined;

  if (channel !== 'last') {
    source = channel;
    channelId = to;
  } else {
    // Scan rooms for the most recent non-internal channel
    const internalSources = new Set(['cron', 'webhook', 'heartbeat', 'internal']);
    const rooms = await runtime.getRooms(runtime.agentId as UUID).catch(() => []);
    let found = false;
    for (const room of rooms) {
      if (room.source && !internalSources.has(room.source)) {
        source = room.source;
        channelId = to ?? room.channelId ?? undefined;
        found = true;
        break;
      }
    }
    if (!found) {
      logger.warn(`[Webhooks] No delivery target resolved for channel "last"`);
      return;
    }
    source = source!;
  }

  await runtime.sendMessageToTarget(
    { source, channelId },
    content,
  );

  logger.info(`[Webhooks] Delivered to ${source}${channelId ? `:${channelId}` : ''}`);
}

// ─── Event helpers ──────────────────────────────────────────────────────────

/**
 * Emit a heartbeat event. Uses the standard event names that plugin-cron listens for.
 */
async function emitHeartbeatWake(runtime: IAgentRuntime, text?: string, source?: string): Promise<void> {
  await runtime.emitEvent('HEARTBEAT_WAKE', {
    runtime,
    text,
    source: source ?? 'webhook',
  });
}

async function emitHeartbeatSystemEvent(runtime: IAgentRuntime, text: string, source?: string): Promise<void> {
  await runtime.emitEvent('HEARTBEAT_SYSTEM_EVENT', {
    runtime,
    text,
    source: source ?? 'webhook',
  });
}

/**
 * Run an isolated agent turn in a dedicated room.
 */
async function runIsolatedAgentTurn(
  runtime: IAgentRuntime,
  params: {
    message: string;
    name: string;
    sessionKey: string;
    model?: string;
    timeoutSeconds?: number;
  },
): Promise<string> {
  const roomId = stringToUuid(`${runtime.agentId}-${params.sessionKey}`) as UUID;

  const existing = await runtime.getRoom(roomId);
  if (!existing) {
    await runtime.createRoom({
      id: roomId,
      name: `Hook: ${params.name}`,
      source: 'webhook',
      type: ChannelType.GROUP,
      channelId: params.sessionKey,
    });
    await runtime.addParticipant(runtime.agentId, roomId);
  }

  const messageId = uuidv4() as UUID;
  const memory: Memory = {
    id: messageId,
    entityId: runtime.agentId,
    roomId,
    agentId: runtime.agentId,
    content: { text: `[${params.name}] ${params.message}` } as Content,
    createdAt: Date.now(),
  };

  let responseText = '';
  const callback = async (response: Content): Promise<Memory[]> => {
    if (response.text) {
      responseText += response.text;
    }
    return [];
  };

  const timeoutMs = params.timeoutSeconds ? params.timeoutSeconds * 1000 : 300_000;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Agent turn timeout')), timeoutMs);
  });

  await Promise.race([
    runtime.messageService.handleMessage(runtime, memory, callback),
    timeout,
  ]).finally(() => clearTimeout(timer!));

  return responseText;
}

// ─── Route handlers ─────────────────────────────────────────────────────────

// Use Eliza's actual RouteRequest/RouteResponse types.
// Re-import here so the handler signatures match Plugin.routes expectations.
import type { RouteRequest, RouteResponse } from '@elizaos/core';

/**
 * POST /hooks/wake
 */
export async function handleWake(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const config = resolveHooksConfig(runtime);
  if (!config) {
    res.status(404).json({ error: 'Hooks not enabled' });
    return;
  }

  if (!validateToken(req as { headers: Record<string, string | undefined> }, config.token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'Missing required field: text' });
    return;
  }

  const mode = body.mode === 'next-heartbeat' ? 'next-heartbeat' : 'now';

  await emitHeartbeatSystemEvent(runtime, text, 'hook:wake');

  if (mode === 'now') {
    await emitHeartbeatWake(runtime, undefined, 'hook:wake');
  }

  logger.info(`[Webhooks] /hooks/wake: "${text.slice(0, 80)}" (mode: ${mode})`);
  res.json({ ok: true });
}

/**
 * POST /hooks/agent
 */
export async function handleAgent(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const config = resolveHooksConfig(runtime);
  if (!config) {
    res.status(404).json({ error: 'Hooks not enabled' });
    return;
  }

  if (!validateToken(req as { headers: Record<string, string | undefined> }, config.token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    res.status(400).json({ error: 'Missing required field: message' });
    return;
  }

  const name = typeof body.name === 'string' ? body.name : 'Webhook';
  const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey : `hook:${uuidv4()}`;
  const wakeMode = body.wakeMode === 'next-heartbeat' ? 'next-heartbeat' : 'now';
  const deliver = body.deliver !== false;
  const channel = typeof body.channel === 'string' ? body.channel : 'last';
  const to = typeof body.to === 'string' ? body.to : undefined;
  const model = typeof body.model === 'string' ? body.model : undefined;
  const timeoutSeconds = typeof body.timeoutSeconds === 'number' ? body.timeoutSeconds : undefined;

  logger.info(`[Webhooks] /hooks/agent: "${message.slice(0, 80)}" (session: ${sessionKey})`);

  // Run async – return 202 immediately
  const runAsync = async () => {
    const responseText = await runIsolatedAgentTurn(runtime, {
      message,
      name,
      sessionKey,
      model,
      timeoutSeconds,
    });

    // Deliver response
    if (deliver && responseText.trim() && responseText.trim() !== 'HEARTBEAT_OK') {
      await deliverToChannel(runtime, { text: responseText } as Content, channel, to)
        .catch((err: Error) => {
          logger.warn(`[Webhooks] Delivery failed for hook agent: ${err.message}`);
        });
    }

    // Post summary to heartbeat
    if (responseText.trim() && responseText.trim() !== 'HEARTBEAT_OK') {
      const summary = responseText.length > 200
        ? `${responseText.slice(0, 200)}…`
        : responseText;
      await emitHeartbeatSystemEvent(runtime, `[Hook "${name}" completed] ${summary}`, `hook:${name}`);
    }

    if (wakeMode === 'now') {
      await emitHeartbeatWake(runtime, undefined, `hook:${name}`);
    }
  };

  // Fire and forget – we return 202 to the caller
  runAsync().catch((err: Error) => {
    logger.error(`[Webhooks] Agent hook run failed: ${err.message}`);
  });

  res.status(202).json({ ok: true, sessionKey });
}

/**
 * POST /hooks/:name (mapped)
 */
export async function handleMapped(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const config = resolveHooksConfig(runtime);
  if (!config) {
    res.status(404).json({ error: 'Hooks not enabled' });
    return;
  }

  if (!validateToken(req as { headers: Record<string, string | undefined> }, config.token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const hookName = req.params?.name ?? '';
  if (!hookName) {
    res.status(400).json({ error: 'Missing hook name' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  // Find matching mapping
  const mapping = findMapping(config.mappings, hookName, body);
  if (!mapping) {
    res.status(404).json({ error: `No mapping found for hook: ${hookName}` });
    return;
  }

  // Apply mapping
  const resolved = applyMapping(mapping, hookName, body);

  logger.info(`[Webhooks] /hooks/${hookName}: action=${resolved.action}`);

  if (resolved.action === 'wake') {
    await emitHeartbeatSystemEvent(runtime, resolved.text ?? '', `hook:${hookName}`);
    if (resolved.wakeMode === 'now') {
      await emitHeartbeatWake(runtime, undefined, `hook:${hookName}`);
    }
    res.json({ ok: true });
    return;
  }

  // action === 'agent'
  const runAsync = async () => {
    const responseText = await runIsolatedAgentTurn(runtime, {
      message: resolved.message ?? '',
      name: resolved.name ?? hookName,
      sessionKey: resolved.sessionKey ?? `hook:${hookName}:${Date.now()}`,
      model: resolved.model,
      timeoutSeconds: resolved.timeoutSeconds,
    });

    if (resolved.deliver && responseText.trim() && responseText.trim() !== 'HEARTBEAT_OK') {
      await deliverToChannel(runtime, { text: responseText } as Content, resolved.channel ?? 'last', resolved.to)
        .catch((err: Error) => {
          logger.warn(`[Webhooks] Delivery failed for mapped hook "${hookName}": ${err.message}`);
        });
    }

    if (responseText.trim() && responseText.trim() !== 'HEARTBEAT_OK') {
      const summary = responseText.length > 200
        ? `${responseText.slice(0, 200)}…`
        : responseText;
      await emitHeartbeatSystemEvent(
        runtime,
        `[Hook "${resolved.name ?? hookName}" completed] ${summary}`,
        `hook:${hookName}`,
      );
    }

    if (resolved.wakeMode === 'now') {
      await emitHeartbeatWake(runtime, undefined, `hook:${hookName}`);
    }
  };

  runAsync().catch((err: Error) => {
    logger.error(`[Webhooks] Mapped hook "${hookName}" run failed: ${err.message}`);
  });

  res.status(202).json({ ok: true });
}
