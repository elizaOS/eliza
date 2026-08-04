/**
 * Process-local Telegram bot token ownership and liveness state shared by the
 * full and standalone Telegram pollers. Telegram allows only one long-polling
 * `getUpdates` consumer per bot token, so every production poller must claim
 * the token before launching and expose whether that claim is actually polling.
 * Global records are fingerprinted and bot-free because this map is visible to
 * every tenant sharing the process.
 */
import { createHash } from "node:crypto";
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
  bot?: Telegraf<Context>;
};

type TelegramPollerClaimInput = Omit<
  TelegramPollerHealth,
  "connected" | "ok" | "lastUpdateAt"
> & {
  bot: Telegraf<Context>;
};

type StoredTelegramPollerClaim = TelegramPollerHealth & {
  ownerKey: symbol;
  reclaimable: boolean;
};

const LOCKS_KEY = Symbol.for("elizaos.telegram.pollerLocks");
const LEGACY_LOCKS_KEY = "__elizaosTelegramPollerLocks";
const botOwnerKeys = new WeakMap<Telegraf<Context>, symbol>();
const botByOwnerKey = new Map<symbol, Telegraf<Context>>();

function credentialFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function lockKeyForToken(token: string): string {
  return `bot:${credentialFingerprint(token)}`;
}

function getLocks(): Map<string, StoredTelegramPollerClaim> {
  const globalState = globalThis as typeof globalThis & {
    [LOCKS_KEY]?: Map<string, StoredTelegramPollerClaim>;
    [LEGACY_LOCKS_KEY]?: unknown;
  };
  delete globalState[LEGACY_LOCKS_KEY];
  if (!globalState[LOCKS_KEY]) {
    globalState[LOCKS_KEY] = new Map<string, StoredTelegramPollerClaim>();
  }
  return globalState[LOCKS_KEY];
}

function ownerKeyForBot(bot: Telegraf<Context>): symbol {
  const existing = botOwnerKeys.get(bot);
  if (existing) {
    return existing;
  }
  const ownerKey = Symbol("telegram-poller-owner");
  botOwnerKeys.set(bot, ownerKey);
  botByOwnerKey.set(ownerKey, bot);
  return ownerKey;
}

function attachBot(claim: StoredTelegramPollerClaim): TelegramPollerClaim {
  const { ownerKey, reclaimable: _reclaimable, ...health } = claim;
  return {
    ...health,
    bot: botByOwnerKey.get(ownerKey),
  };
}

function isReclaimable(claim: StoredTelegramPollerClaim): boolean {
  // `connected` and `lastUpdateAt` are health observations, not leases. A new
  // poller is briefly disconnected, and a healthy bot can receive no updates
  // for hours, so neither state proves that ownership is dead. Only an explicit
  // terminal transition makes a claim safe to replace.
  return claim.reclaimable;
}

function redactErrorMessage(token: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return raw
    .replace(new RegExp(`/bot${escaped}`, "g"), "/bot[REDACTED]")
    .replace(new RegExp(escaped, "g"), "[REDACTED]");
}

export function ensureTelegramPollerTokenAvailable(
  token: string,
  bot: Telegraf<Context>,
): void {
  const locks = getLocks();
  const key = lockKeyForToken(token);
  const active = locks.get(key);
  if (!active || botByOwnerKey.get(active.ownerKey) === bot) {
    return;
  }
  if (isReclaimable(active)) {
    botByOwnerKey.delete(active.ownerKey);
    locks.delete(key);
    return;
  }
  throw new Error(
    `Telegram bot token already has an active ${active.mode} poller for ${active.ownerId}/${active.accountId}`,
  );
}

export function claimTelegramPollerToken(
  token: string,
  claim: TelegramPollerClaimInput,
): TelegramPollerClaim {
  const locks = getLocks();
  const key = lockKeyForToken(token);
  const ownerKey = ownerKeyForBot(claim.bot);
  const active = locks.get(key);
  if (active && active.ownerKey !== ownerKey) {
    if (!isReclaimable(active)) {
      throw new Error(
        `Telegram bot token already has an active ${active.mode} poller for ${active.ownerId}/${active.accountId}`,
      );
    }
    botByOwnerKey.delete(active.ownerKey);
  }
  const { bot, ...health } = claim;
  const next: StoredTelegramPollerClaim = {
    ...health,
    ownerKey,
    reclaimable: false,
    ok: false,
    connected: false,
  };
  botByOwnerKey.set(ownerKey, bot);
  locks.set(key, next);
  return attachBot(next);
}

export function getTelegramPollerClaim(
  token: string,
): TelegramPollerClaim | undefined {
  const claim = getLocks().get(lockKeyForToken(token));
  return claim ? attachBot(claim) : undefined;
}

export function releaseTelegramPollerToken(
  token: string,
  bot: Telegraf<Context>,
): void {
  const locks = getLocks();
  const key = lockKeyForToken(token);
  const claim = locks.get(key);
  const ownerKey = botOwnerKeys.get(bot);
  if (claim && ownerKey && claim.ownerKey === ownerKey) {
    locks.delete(key);
    botByOwnerKey.delete(ownerKey);
  }
}

export function markTelegramPollerConnected(
  token: string,
  bot: Telegraf<Context>,
): void {
  const claim = getLocks().get(lockKeyForToken(token));
  if (claim && claim.ownerKey === botOwnerKeys.get(bot)) {
    claim.connected = true;
    claim.ok = true;
    claim.lastUpdateAt = Date.now();
    claim.lastError = undefined;
  }
}

export function markTelegramPollerUpdate(
  token: string,
  bot: Telegraf<Context>,
): void {
  const claim = getLocks().get(lockKeyForToken(token));
  if (claim && claim.ownerKey === botOwnerKeys.get(bot)) {
    claim.lastUpdateAt = Date.now();
  }
}

export function markTelegramPollerTerminated(
  token: string,
  bot: Telegraf<Context>,
  error: unknown,
): void {
  const claim = getLocks().get(lockKeyForToken(token));
  if (claim && claim.ownerKey === botOwnerKeys.get(bot)) {
    claim.connected = false;
    claim.ok = false;
    claim.lastError = redactErrorMessage(token, error);
    claim.reclaimable = true;
    botByOwnerKey.delete(claim.ownerKey);
  }
}

export function markTelegramPollerError(
  token: string,
  bot: Telegraf<Context>,
  error: unknown,
): void {
  const claim = getLocks().get(lockKeyForToken(token));
  if (claim && claim.ownerKey === botOwnerKeys.get(bot)) {
    claim.connected = false;
    claim.ok = false;
    claim.lastError = redactErrorMessage(token, error);
  }
}

export function listTelegramPollerHealth(
  mode?: TelegramPollerMode,
): TelegramPollerHealth[] {
  return Array.from(getLocks().values())
    .filter((claim) => !mode || claim.mode === mode)
    .map(({ ownerKey: _ownerKey, reclaimable: _reclaimable, ...health }) => ({
      ...health,
    }));
}
