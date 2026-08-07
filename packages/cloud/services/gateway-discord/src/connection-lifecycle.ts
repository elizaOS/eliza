/** Reconciles the in-memory Discord bot lifecycle after WebSocket readiness and resume events. */

export type DiscordConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface DiscordConnectionLifecycleState {
  status: DiscordConnectionStatus;
  guildCount: number;
  connectedAt?: Date;
  statusChangedAt?: Date;
  error?: string;
}

export interface DiscordConnectionReadyTransition {
  changed: boolean;
  previousStatus: DiscordConnectionStatus;
}

/**
 * Marks a Discord connection ready without rewriting its original connection
 * timestamp when duplicate shard-ready/resume notifications arrive.
 */
export function reconcileDiscordConnectionReady(
  connection: DiscordConnectionLifecycleState,
  guildCount: number,
  now: Date = new Date(),
): DiscordConnectionReadyTransition {
  const previousStatus = connection.status;
  connection.guildCount = guildCount;

  if (previousStatus === "connected") {
    return { changed: false, previousStatus };
  }

  connection.status = "connected";
  connection.connectedAt = now;
  connection.statusChangedAt = undefined;
  connection.error = undefined;

  return { changed: true, previousStatus };
}
