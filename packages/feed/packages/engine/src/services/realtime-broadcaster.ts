import type { JsonValue } from '@feed/db';

export type BroadcastToChannelFn = (
  channel: string,
  data: Record<string, JsonValue>
) => Promise<void>;

let broadcastFn: BroadcastToChannelFn | null = null;

/**
 * Set the broadcast function used by engine services.
 *
 * The web/api layer should call this once per process (or per invocation) to
 * wire `@feed/api`'s SSE broadcaster into the engine.
 */
export function setBroadcastToChannel(fn: BroadcastToChannelFn | null): void {
  broadcastFn = fn;
}

export async function broadcastToChannel(
  channel: string,
  data: Record<string, JsonValue>
): Promise<void> {
  if (!broadcastFn) return;
  await broadcastFn(channel, data);
}
