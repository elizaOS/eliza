/**
 * TelegramOwnerPairingService
 *
 * Implements the connector side of the owner-pairing flow for Telegram:
 *   - `/eliza_pair <code>` bot command: relays a 6-digit pair code to the
 *     backend `verifyOwnerBindFromConnector` service and reports the result.
 *   - `sendOwnerLoginDmLink({ externalId, link })`: called by the backend's
 *     `/api/auth/login/owner/dm-link/request` handler to DM a login link to
 *     the Telegram user identified by their numeric user ID.
 *
 * Hard rules:
 *   - Backend is the authority. The connector only relays; it never decides
 *     whether a binding succeeds.
 *   - Fail closed: if the backend service is unreachable, we reply with an
 *     explicit error message and do NOT silently succeed.
 *   - Per-user rate limit on `/eliza_pair` invocations: 5 attempts per minute.
 *   - DM-link sender never pre-fetches or auto-redeems the link.
 *
 * Telegram command naming: underscores instead of hyphens, per Telegram bot
 * command conventions (commands must match [a-z0-9_]{1,32}).
 */

import { type IAgentRuntime, logger, Service } from '@elizaos/core';
import type { Context } from 'telegraf';
import { TELEGRAM_SERVICE_NAME } from './constants';

/** Service type string used by the backend to look up this service. */
export const TELEGRAM_OWNER_PAIRING_SERVICE_TYPE = 'OWNER_PAIRING_TELEGRAM';

/** Maximum pairing attempts per user per window. */
const RATE_LIMIT_MAX_ATTEMPTS = 5;
/** Window length in milliseconds. */
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Shape of the backend `verifyOwnerBindFromConnector` service method.
 * The backend owns this interface; we look it up via the runtime service
 * registry. If it is absent, we fail closed.
 */
interface OwnerBindVerifyService {
  verifyOwnerBindFromConnector(params: {
    connector: 'discord' | 'telegram' | 'wechat' | 'matrix';
    externalId: string;
    displayHandle: string;
    code: string;
  }): Promise<{ success: boolean; error?: string }>;
}

/** Audit-emit helper — best-effort, never throws. */
async function auditEmit(
  runtime: IAgentRuntime,
  action: string,
  outcome: 'success' | 'failure',
  metadata: Record<string, string | number | boolean>,
): Promise<void> {
  try {
    await runtime.emitEvent(
      ['AUTH_AUDIT'] as string[],
      {
        runtime,
        action,
        outcome,
        metadata,
        source: 'telegram',
      } as never,
    );
  } catch {
    // Audit is best-effort; a failure here must not mask the real result.
  }
}

/**
 * In-memory per-user rate-limit state.
 * Key: Telegram user numeric ID as string.
 * Value: list of attempt timestamps within the current window.
 */
const pairAttempts = new Map<string, number[]>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const attempts = (pairAttempts.get(userId) ?? []).filter(
    (ts) => ts > windowStart,
  );
  pairAttempts.set(userId, attempts);
  if (attempts.length >= RATE_LIMIT_MAX_ATTEMPTS) {
    return true;
  }
  attempts.push(now);
  pairAttempts.set(userId, attempts);
  return false;
}

/**
 * Validates that the supplied string is a 6-digit numeric pair code.
 * The backend performs its own authoritative validation; this is a
 * pre-flight check to avoid a round-trip for obviously invalid inputs.
 */
function isValidPairCode(code: string): boolean {
  return /^\d{6}$/.test(code.trim());
}

/**
 * Looks up the backend verify service from the runtime service registry.
 * Returns null when the backend has not yet registered it.
 */
function resolveVerifyService(
  runtime: IAgentRuntime,
): OwnerBindVerifyService | null {
  try {
    const svc = runtime.getService('OWNER_BIND_VERIFY') as unknown;
    if (
      svc &&
      typeof svc === 'object' &&
      typeof (svc as Record<string, unknown>).verifyOwnerBindFromConnector ===
        'function'
    ) {
      return svc as OwnerBindVerifyService;
    }
  } catch {
    // Service not registered yet.
  }
  return null;
}

/**
 * Derives a human-readable display handle from a Telegram user object.
 */
function resolveDisplayHandle(from: {
  id: number;
  username?: string;
  first_name?: string;
}): string {
  if (from.username) {
    return `@${from.username}`;
  }
  if (from.first_name) {
    return from.first_name;
  }
  return String(from.id);
}

/**
 * Processes a `/eliza_pair <code>` command message in a Telegraf context.
 * Must only be called when `ctx.from` and `ctx.message` are present.
 */
export async function handleElizaPairCommand(
  ctx: Context,
  runtime: IAgentRuntime,
): Promise<void> {
  const from = ctx.from;
  if (!from) {
    // No sender — ignore silently; this should not happen for bot commands.
    return;
  }

  const userId = String(from.id);
  const displayHandle = resolveDisplayHandle(from);

  if (isRateLimited(userId)) {
    logger.warn(
      { src: 'plugin:telegram:owner-pairing', userId },
      'Rate limit hit for /eliza_pair',
    );
    await auditEmit(
      runtime,
      'auth.owner.pair.telegram.rate_limited',
      'failure',
      { externalId: userId },
    );
    await ctx.reply(
      'Too many pairing attempts. Please wait a moment before trying again.',
    );
    return;
  }

  // Extract the code argument from the message text.
  // Telegram delivers command text as: /eliza_pair 123456
  // or /eliza_pair@botname 123456 in group chats.
  const message = ctx.message;
  const rawText = message && 'text' in message ? message.text : undefined;

  let code: string | null = null;
  if (typeof rawText === 'string') {
    // Strip the command token itself and optional @botname, then take the
    // next space-separated token as the code argument.
    const parts = rawText.trim().split(/\s+/);
    if (parts.length >= 2) {
      code = parts[1] ?? null;
    }
  }

  if (!code?.trim()) {
    await ctx.reply(
      'Usage: /eliza\\_pair <code> — enter the 6-digit code shown in the Eliza dashboard.',
    );
    return;
  }

  code = code.trim();
  if (!isValidPairCode(code)) {
    await ctx.reply(
      'The pairing code must be exactly 6 digits. Check the Eliza dashboard and try again.',
    );
    return;
  }

  const verifySvc = resolveVerifyService(runtime);
  if (!verifySvc) {
    logger.error(
      { src: 'plugin:telegram:owner-pairing', userId },
      'OWNER_BIND_VERIFY service not available — cannot complete pairing',
    );
    await auditEmit(
      runtime,
      'auth.owner.pair.telegram.service_unavailable',
      'failure',
      { externalId: userId },
    );
    await ctx.reply(
      'Eliza could not reach the pairing service right now. Please try again in a moment.',
    );
    return;
  }

  let result: { success: boolean; error?: string };
  try {
    result = await verifySvc.verifyOwnerBindFromConnector({
      connector: 'telegram',
      externalId: userId,
      displayHandle,
      code,
    });
  } catch (err) {
    logger.error(
      {
        src: 'plugin:telegram:owner-pairing',
        userId,
        error: err instanceof Error ? err.message : String(err),
      },
      'verifyOwnerBindFromConnector threw unexpectedly',
    );
    await auditEmit(
      runtime,
      'auth.owner.pair.telegram.verify_error',
      'failure',
      { externalId: userId },
    );
    await ctx.reply(
      'Something went wrong while verifying the pairing code. Please try again.',
    );
    return;
  }

  if (result.success) {
    logger.info(
      { src: 'plugin:telegram:owner-pairing', userId, displayHandle },
      'Owner pairing completed successfully',
    );
    await auditEmit(runtime, 'auth.owner.pair.telegram.success', 'success', {
      externalId: userId,
      displayHandle,
    });
    await ctx.reply('Paired with Eliza. You can now log in via Telegram.');
  } else {
    logger.warn(
      {
        src: 'plugin:telegram:owner-pairing',
        userId,
        backendError: result.error,
      },
      'Owner pairing rejected by backend',
    );
    await auditEmit(runtime, 'auth.owner.pair.telegram.failure', 'failure', {
      externalId: userId,
    });
    await ctx.reply(
      'Pair code invalid or expired. Check the Eliza dashboard for a fresh code.',
    );
  }
}

/**
 * Public service interface exposed via the runtime service registry.
 * The backend's `owner-binding.ts` calls `sendOwnerLoginDmLink` when the
 * user requests a DM login link via the dashboard.
 */
export interface TelegramOwnerPairingService {
  /**
   * DMs the Telegram user identified by `externalId` (a numeric Telegram user
   * ID as a string) with a login link. The link is presented as-is; this
   * method never pre-fetches or auto-redeems it.
   *
   * Throws if the DM cannot be delivered (Telegram API error, bot blocked by
   * user, etc.). The caller is responsible for surfacing the error.
   */
  sendOwnerLoginDmLink(params: {
    externalId: string;
    link: string;
  }): Promise<void>;
}

export class TelegramOwnerPairingServiceImpl
  extends Service
  implements TelegramOwnerPairingService
{
  static serviceType = TELEGRAM_OWNER_PAIRING_SERVICE_TYPE;
  capabilityDescription =
    'Handles Telegram-side owner pairing (command code verification) and DM login-link delivery for Eliza remote auth';

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new TelegramOwnerPairingServiceImpl(runtime);
    if (resolveVerifyService(runtime)) {
      service.registerPairCommand(runtime);
      logger.info(
        {
          src: 'plugin:telegram:owner-pairing',
          agentId: runtime.agentId,
        },
        'TelegramOwnerPairingService started; /eliza_pair command registered',
      );
    } else {
      logger.info(
        {
          src: 'plugin:telegram:owner-pairing',
          agentId: runtime.agentId,
        },
        'TelegramOwnerPairingService started without /eliza_pair because OWNER_BIND_VERIFY is not registered',
      );
    }
    return service;
  }

  async stop(): Promise<void> {
    pairAttempts.clear();
  }

  /**
   * Registers the /eliza_pair command with the active Telegraf bot instance
   * by looking up the TelegramService from the runtime service registry.
   * Called during `start`; it is safe to call this before or after the bot
   * has finished initialising because Telegraf accepts handler registration
   * at any point before `launch()`.
   *
   * If the TelegramService is unavailable, the command is not registered.
   */
  private registerPairCommand(runtime: IAgentRuntime): void {
    const telegramSvc = runtime.getService(TELEGRAM_SERVICE_NAME) as unknown;
    if (!telegramSvc || typeof telegramSvc !== 'object') {
      logger.warn(
        { src: 'plugin:telegram:owner-pairing', agentId: runtime.agentId },
        'TelegramService unavailable during owner-pairing start; /eliza_pair command not registered',
      );
      return;
    }

    const bot =
      'bot' in (telegramSvc as Record<string, unknown>)
        ? (telegramSvc as { bot: unknown }).bot
        : null;

    if (
      !bot ||
      typeof (bot as Record<string, unknown>).command !== 'function'
    ) {
      logger.warn(
        { src: 'plugin:telegram:owner-pairing', agentId: runtime.agentId },
        'Telegraf bot instance not available — /eliza_pair will not be registered',
      );
      return;
    }

    const telegrafBot = bot as import('telegraf').Telegraf<Context>;
    telegrafBot.command('eliza_pair', async (ctx) => {
      await handleElizaPairCommand(ctx, runtime);
    });

    logger.debug(
      { src: 'plugin:telegram:owner-pairing', agentId: runtime.agentId },
      '/eliza_pair command registered with Telegraf bot',
    );
  }

  async sendOwnerLoginDmLink(params: {
    externalId: string;
    link: string;
  }): Promise<void> {
    const { externalId, link } = params;

    const telegramSvc = this.runtime.getService(
      TELEGRAM_SERVICE_NAME,
    ) as unknown;
    const bot =
      telegramSvc &&
      typeof telegramSvc === 'object' &&
      'bot' in (telegramSvc as Record<string, unknown>)
        ? (telegramSvc as { bot: unknown }).bot
        : null;

    if (!bot || typeof (bot as Record<string, unknown>).telegram !== 'object') {
      throw new Error(
        'Telegram bot is not available — cannot send DM login link',
      );
    }

    const telegrafBot = bot as import('telegraf').Telegraf<Context>;
    const chatId = Number(externalId);
    if (!Number.isFinite(chatId) || chatId <= 0) {
      throw new Error(
        `Invalid Telegram externalId "${externalId}" — must be a positive numeric user ID`,
      );
    }

    const message =
      `Click to log in to Eliza: ${link}\n\n` +
      '_This link expires in 5 minutes. Do not share it._';

    try {
      await telegrafBot.telegram.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
      });
      logger.info(
        { src: 'plugin:telegram:owner-pairing', externalId },
        'Login DM link sent',
      );
    } catch (err) {
      throw new Error(
        `Failed to send DM login link to Telegram user ${externalId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
