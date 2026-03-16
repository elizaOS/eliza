/**
 * @module heartbeat/delivery
 * @description Delivery target resolution with persistent "last route" tracking.
 *
 * Uses Eliza's component storage to persist the last successful delivery target
 * per agent. When channel is "last", reads the stored target. On successful
 * delivery, updates the stored target.
 *
 * Fallback: if no stored target exists, scans the agent's rooms for the most
 * recent non-internal channel (Discord, Telegram, WhatsApp, etc.).
 */

import {
  logger,
  type Component,
  type IAgentRuntime,
  type TargetInfo,
  type UUID,
  type Content,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

const LAST_ROUTE_COMPONENT_TYPE = 'last_delivery_route';
const INTERNAL_SOURCES = new Set(['cron', 'webhook', 'heartbeat', 'internal']);

export interface DeliveryTarget {
  source: string;
  channelId?: string;
}

/**
 * Read the last delivery route from component storage.
 */
async function readLastRoute(runtime: IAgentRuntime): Promise<DeliveryTarget | null> {
  const component = await runtime.getComponent(
    runtime.agentId as UUID,
    LAST_ROUTE_COMPONENT_TYPE,
  );

  if (!component?.data) {
    return null;
  }

  const data = component.data as Record<string, unknown>;
  const source = typeof data.source === 'string' ? data.source : '';
  if (!source) {
    return null;
  }

  return {
    source,
    channelId: typeof data.channelId === 'string' ? data.channelId : undefined,
  };
}

/**
 * Write the last delivery route to component storage.
 */
async function writeLastRoute(runtime: IAgentRuntime, target: DeliveryTarget): Promise<void> {
  const existing = await runtime.getComponent(
    runtime.agentId as UUID,
    LAST_ROUTE_COMPONENT_TYPE,
  );

  const data = {
    source: target.source,
    channelId: target.channelId ?? null,
    updatedAt: Date.now(),
  };

  if (existing) {
    await runtime.updateComponent({
      ...existing,
      data,
    });
  } else {
    await runtime.createComponent({
      id: uuidv4() as UUID,
      entityId: runtime.agentId as UUID,
      type: LAST_ROUTE_COMPONENT_TYPE,
      data,
      createdAt: Date.now(),
    } as unknown as Component);
  }
}

/**
 * Scan the agent's rooms for the most recent non-internal channel.
 * Used as a fallback when no stored last-route exists.
 */
async function scanRoomsForExternalTarget(runtime: IAgentRuntime): Promise<DeliveryTarget | null> {
  const rooms = await runtime.getRooms(runtime.agentId as UUID).catch(() => []);

  for (const room of rooms) {
    if (room.source && !INTERNAL_SOURCES.has(room.source)) {
      return {
        source: room.source,
        channelId: room.channelId ?? undefined,
      };
    }
  }

  return null;
}

/**
 * Resolve a delivery target.
 *
 * For explicit channels (e.g. "discord", "whatsapp"), returns directly.
 * For "last", reads the stored last-route, falling back to room scanning.
 *
 * Returns null if no target can be resolved.
 */
export async function resolveDeliveryTarget(
  runtime: IAgentRuntime,
  channel: string,
  to?: string,
): Promise<DeliveryTarget | null> {
  if (channel !== 'last') {
    return { source: channel, channelId: to };
  }

  // Try stored last route first
  const stored = await readLastRoute(runtime);
  if (stored) {
    // If caller provided an explicit `to`, override the stored channelId
    if (to) {
      return { source: stored.source, channelId: to };
    }
    return stored;
  }

  // Fallback: scan rooms
  const scanned = await scanRoomsForExternalTarget(runtime);
  if (scanned) {
    logger.debug(
      `[Delivery] Resolved "last" via room scan: ${scanned.source}:${scanned.channelId ?? '(default)'}`
    );
    if (to) {
      return { source: scanned.source, channelId: to };
    }
    return scanned;
  }

  return null;
}

/**
 * Deliver content to a target and record the successful route.
 *
 * This is the primary delivery function that should be used by heartbeat,
 * cron executor, and webhook handlers. It:
 *   1. Resolves the target (handling "last")
 *   2. Calls runtime.sendMessageToTarget()
 *   3. On success, persists the route as the new "last" target
 *
 * Returns the resolved target on success, or null if no target could be resolved.
 * Throws on delivery failure (unless bestEffort is true, in which case logs a warning).
 */
export async function deliverToTarget(
  runtime: IAgentRuntime,
  content: Content,
  channel: string,
  to?: string,
  bestEffort?: boolean,
): Promise<DeliveryTarget | null> {
  const target = await resolveDeliveryTarget(runtime, channel, to);

  if (!target) {
    const msg = `No delivery target resolved for channel "${channel}"`;
    if (bestEffort) {
      logger.warn(`[Delivery] ${msg}`);
      return null;
    }
    throw new Error(msg);
  }

  const deliveryError = await runtime.sendMessageToTarget(
    { source: target.source, channelId: target.channelId } as TargetInfo,
    content,
  ).then(() => null, (err: Error) => err);

  if (deliveryError) {
    if (bestEffort) {
      logger.warn(
        `[Delivery] Best-effort delivery failed to ${target.source}: ${deliveryError.message}`
      );
      return null;
    }
    throw deliveryError;
  }

  // Success -- persist this route as the "last" target
  await writeLastRoute(runtime, target).catch((err: Error) => {
    logger.debug(`[Delivery] Failed to persist last route: ${err.message}`);
  });

  logger.info(
    `[Delivery] Delivered to ${target.source}${target.channelId ? `:${target.channelId}` : ''}`
  );

  return target;
}
