/**
 * Process-local Telegram bot token ownership and liveness state shared by the
 * full and standalone Telegram pollers. Telegram allows only one long-polling
 * `getUpdates` consumer per bot token, so every production poller must claim
 * the token before launching and expose whether that claim is actually polling.
 */
import type { Context, Telegraf } from "telegraf";

export type TelegramPollerMode = "full" | "standalone";

export type TelegramPollerHealth = {
  ok: boolean;
  mode: TelegramPollerMode;
  accountId: string;
  ownerId: string;
  connected: boolean;
  lastUpdateAt?: number;
  lastError?: string;
};

export type TelegramPollerClaim = TelegramPollerHealth & {
  bot: Telegraf<Context>;
};

const LOCKS_KEY = "__elizaosTelegramPollerLocks";

function getLocks(): Map<string, TelegramPollerClaim> {
  const globalState = globalThis as typeof globalThis & {
    __elizaosTelegramPollerLocks?: Map<string, TelegramPollerClaim>;
  };
  if (!globalState[LOCKS_KEY]) {
    globalState[LOCKS_KEY] = new Map<string, TelegramPollerClaim>();
  }
  return globalState[LOCKS_KEY];
}

export function claimTelegramPollerToken(
  token: string,
  claim: Omit<TelegramPollerClaim, "connected" | "ok" | "lastUpdateAt">
): TelegramPollerClaim {
  const locks = getLocks();
  const active = locks.get(token);
  if (active && active.bot !== claim.bot) {
    throw new Error(
      `Telegram bot token already has an active ${active.mode} poller for ${active.ownerId}/${active.accountId}`
    );
  }
  const next: TelegramPollerClaim = {
    ...claim,
    ok: false,
    connected: false,
  };
  locks.set(token, next);
  return next;
}

export function getTelegramPollerClaim(token: string): TelegramPollerClaim | undefined {
  return getLocks().get(token);
}

export function releaseTelegramPollerToken(token: string, bot: Telegraf<Context>): void {
  const locks = getLocks();
  if (locks.get(token)?.bot === bot) {
    locks.delete(token);
  }
}

export function markTelegramPollerConnected(token: string, bot: Telegraf<Context>): void {
  const claim = getLocks().get(token);
  if (claim?.bot === bot) {
    claim.connected = true;
    claim.ok = true;
    claim.lastError = undefined;
  }
}

export function markTelegramPollerUpdate(token: string, bot: Telegraf<Context>): void {
  const claim = getLocks().get(token);
  if (claim?.bot === bot) {
    claim.lastUpdateAt = Date.now();
  }
}

export function markTelegramPollerError(
  token: string,
  bot: Telegraf<Context>,
  error: unknown
): void {
  const claim = getLocks().get(token);
  if (claim?.bot === bot) {
    claim.connected = false;
    claim.ok = false;
    claim.lastError = error instanceof Error ? error.message : String(error);
  }
}

export function listTelegramPollerHealth(mode?: TelegramPollerMode): TelegramPollerHealth[] {
  return Array.from(getLocks().values())
    .filter((claim) => !mode || claim.mode === mode)
    .map(({ bot: _bot, ...health }) => ({ ...health }));
}
