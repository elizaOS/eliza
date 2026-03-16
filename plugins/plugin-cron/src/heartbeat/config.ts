/**
 * @module heartbeat/config
 * @description Configuration for the heartbeat worker.
 *
 * Reads heartbeat settings from the agent's runtime settings,
 * supporting the same config shape as the Otto docs:
 *   agents.defaults.heartbeat.every
 *   agents.defaults.heartbeat.activeHours
 *   agents.defaults.heartbeat.target
 *   agents.defaults.heartbeat.prompt
 */

import type { IAgentRuntime } from '@elizaos/core';

export interface ActiveHours {
  start: string; // "HH:MM" in 24h local time
  end: string;
}

export interface HeartbeatConfig {
  /** Interval between heartbeats in milliseconds. */
  everyMs: number;
  /** Optional active hours window. Heartbeats outside this window are skipped. */
  activeHours: ActiveHours | null;
  /** Delivery target. "last" uses the agent's last delivery route. */
  target: string;
  /** Name of the workspace file to read as heartbeat instructions. */
  promptFile: string;
  /** If true the heartbeat worker is enabled. */
  enabled: boolean;
}

const DEFAULT_EVERY_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_PROMPT_FILE = 'HEARTBEAT.md';

function parseDurationToMs(raw: string): number {
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day|ms)?$/i);
  if (!match) {
    return DEFAULT_EVERY_MS;
  }
  const value = Number.parseFloat(match[1]);
  const unit = (match[2] ?? 'm').toLowerCase();
  switch (unit) {
    case 'ms':
      return value;
    case 's':
    case 'sec':
      return value * 1000;
    case 'm':
    case 'min':
      return value * 60_000;
    case 'h':
    case 'hr':
      return value * 3_600_000;
    case 'd':
    case 'day':
      return value * 86_400_000;
    default:
      return value * 60_000;
  }
}

function parseActiveHours(raw: Record<string, unknown>): ActiveHours | null {
  const start = typeof raw.start === 'string' ? raw.start.trim() : '';
  const end = typeof raw.end === 'string' ? raw.end.trim() : '';
  if (!start || !end) {
    return null;
  }
  return { start, end };
}

/**
 * Resolve heartbeat config from runtime settings.
 *
 * Looks for the `heartbeat` key in the character settings object,
 * which matches the Otto config shape:
 *   heartbeat: { every: "30m", activeHours: { start, end }, target, prompt }
 */
export function resolveHeartbeatConfig(runtime: IAgentRuntime): HeartbeatConfig {
  const settings = (runtime.character?.settings ?? {}) as Record<string, unknown>;
  const hb = (settings.heartbeat ?? {}) as Record<string, unknown>;

  const everyRaw = typeof hb.every === 'string' ? hb.every : '';
  const everyMs = everyRaw ? parseDurationToMs(everyRaw) : DEFAULT_EVERY_MS;

  const activeHours =
    hb.activeHours && typeof hb.activeHours === 'object'
      ? parseActiveHours(hb.activeHours as Record<string, unknown>)
      : null;

  const target = typeof hb.target === 'string' ? hb.target.trim() : 'last';
  const promptFile =
    typeof hb.prompt === 'string' && hb.prompt.trim()
      ? hb.prompt.trim()
      : DEFAULT_PROMPT_FILE;

  const enabled = hb.enabled !== false;

  return { everyMs, activeHours, target, promptFile, enabled };
}

/**
 * Check whether the current local time falls inside the active hours window.
 * Returns true if no active hours are configured (always active).
 */
export function isWithinActiveHours(activeHours: ActiveHours | null): boolean {
  if (!activeHours) {
    return true;
  }
  const now = new Date();
  const hh = now.getHours();
  const mm = now.getMinutes();
  const currentMinutes = hh * 60 + mm;

  const [startH, startM] = activeHours.start.split(':').map(Number);
  const [endH, endM] = activeHours.end.split(':').map(Number);
  const startMinutes = (startH ?? 0) * 60 + (startM ?? 0);
  const endMinutes = (endH ?? 0) * 60 + (endM ?? 0);

  if (startMinutes <= endMinutes) {
    // Normal range, e.g. 08:00 – 22:00
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Wrapping range, e.g. 22:00 – 06:00
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}
