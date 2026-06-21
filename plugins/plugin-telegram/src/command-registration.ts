/**
 * Universal slash-command catalog → Telegram native commands.
 *
 * Maps the connector-neutral command catalog from `@elizaos/plugin-commands`
 * (`getConnectorCommands("telegram")`) onto Telegraf `bot.command(...)` handlers
 * and the Telegram `/` menu (`setMyCommands`), so the same agent-capability and
 * navigation commands the dashboard and Discord expose appear natively in
 * Telegram.
 *
 * This is Telegram's implementation of the shared `ConnectorCommandBridge`
 * contract (#8790): the same register/dispatch shape and the same auth-gating
 * decision Discord uses, so both connectors behave consistently.
 *
 * Per-target dispatch:
 *   - `agent`    → gate-safe commands (help/status/…) resolve to a deterministic
 *                  local reply via `resolveCommand`; other agent commands route
 *                  the reconstructed command text (the user's `/command args`
 *                  message) through the agent's message pipeline via
 *                  `MessageManager.handleMessage(ctx, { forceReply: true })`,
 *                  the same path inbound messages take. `forceReply` bypasses
 *                  the `TELEGRAM_AUTO_REPLY` gate because an explicit slash
 *                  command is an explicit request for a response.
 *   - `navigate` → replies describing the in-app destination, resolving the
 *                  `/settings <section>` argument when present.
 *   - `client`   → GUI/TUI-only behaviors have no Telegram surface; handled
 *                  defensively with a short reply rather than crashing.
 *
 * Auth gating: `requiresAuth` / `requiresElevated` commands are gated at the
 * connector boundary using the agent's role model (`hasRoleAccess`) — the same
 * mechanism every surface uses. The Telegram sender is mapped to a runtime
 * entity (matching `MessageManager`'s account-scoped id), and a command is
 * refused with a clear reply when the sender is not an owner (for
 * `requiresAuth`) or admin (for `requiresElevated`).
 *
 * A matched `bot.command` handler never calls `next()`, so the catch-all
 * message handler registered in `service.ts` does not also process command
 * messages (no double-processing).
 */

import {
  createUniqueUuid,
  hasRoleAccess,
  type IAgentRuntime,
  logger,
  type Memory,
  type UUID,
} from "@elizaos/core";
import {
  type ConnectorCommand,
  type ConnectorSenderAuth,
  gateConnectorCommandByName,
  getConnectorCommands,
  resolveCommand,
  resolveSettingsSection,
} from "@elizaos/plugin-commands";
import type { Context, Telegraf } from "telegraf";
import type { MessageManager } from "./messageManager";

/**
 * Telegram command-name rules (Bot API `setMyCommands`): lowercase, 1-32 chars,
 * only `a-z`, `0-9`, and `_`. Names that cannot be sanitized into this shape are
 * dropped from the native surface.
 */
const TELEGRAM_COMMAND_NAME_RE = /^[a-z0-9_]{1,32}$/;
/** Telegram caps command descriptions at 256 characters. */
const TELEGRAM_COMMAND_DESCRIPTION_MAX = 256;
/** Telegram caps the published command menu at 100 commands. */
const TELEGRAM_MAX_COMMANDS = 100;
/** Telegram caps a single text message at 4096 characters. */
const TELEGRAM_MESSAGE_MAX = 4096;
/** The catalog surface this bridge serves. */
const TELEGRAM_SURFACE = "telegram";
const DEFAULT_ACCOUNT_ID = "default";

/** A catalog command projected onto Telegram's native command surface. */
export interface TelegramCommandDescriptor {
  /** Sanitized Telegram command name (without the leading slash). */
  name: string;
  /** Description, clamped to Telegram's 256-character limit. */
  description: string;
  /** The originating catalog command. */
  command: ConnectorCommand;
}

/**
 * Account-scoped key matching `MessageManager.scopedTelegramKey`, so the entity
 * id this bridge derives for role resolution is the same id the inbound message
 * pipeline assigns to the sender.
 */
function scopedTelegramKey(key: string, accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? key : `${accountId}:${key}`;
}

/**
 * Sanitize a catalog command name into a Telegram-legal command name, or return
 * `null` when no legal name can be derived (so it is dropped rather than
 * rejected by Telegram at registration time).
 */
function sanitizeCommandName(name: string): string | null {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return TELEGRAM_COMMAND_NAME_RE.test(sanitized) ? sanitized : null;
}

/** Clamp a description to Telegram's limit; a description is always required. */
function clampDescription(description: string): string {
  const trimmed = description.trim();
  return trimmed.slice(0, TELEGRAM_COMMAND_DESCRIPTION_MAX);
}

/**
 * Project the catalog onto Telegram command descriptors, deduped by sanitized
 * name (first occurrence wins) and capped at Telegram's 100-command limit. Pure
 * — no side effects.
 */
export function buildTelegramCommandDescriptors(): TelegramCommandDescriptor[] {
  const out: TelegramCommandDescriptor[] = [];
  const seen = new Set<string>();
  for (const command of getConnectorCommands(TELEGRAM_SURFACE)) {
    if (out.length >= TELEGRAM_MAX_COMMANDS) break;
    const name = sanitizeCommandName(command.name);
    if (!name || seen.has(name)) continue;
    const description = clampDescription(command.description);
    if (!description) continue;
    seen.add(name);
    out.push({ name, description, command });
  }
  return out;
}

/** Human-readable destination for a navigation target. */
function describeNavigation(
  command: ConnectorCommand,
  sectionLabel?: string,
): string {
  const target = command.target;
  if (target.kind !== "navigate") return `Open ${command.name}.`;
  const place = sectionLabel
    ? `${command.name} → ${sectionLabel}`
    : command.name;
  const deepLink = target.path ? ` (${target.path})` : "";
  return `Open ${place} in the Eliza app${deepLink}.`;
}

/**
 * Extract the first positional argument from a Telegram command message. For
 * `/settings appearance` this returns `appearance`. Returns `undefined` when the
 * command was sent without arguments.
 */
function firstCommandArg(text: string): string | undefined {
  const parts = text.trim().split(/\s+/);
  // parts[0] is the `/command` (possibly `/command@botname`); the rest are args.
  const arg = parts[1];
  return arg && arg.length > 0 ? arg : undefined;
}

function messageText(ctx: Context): string {
  return ctx.message && "text" in ctx.message ? ctx.message.text : "";
}

/**
 * Resolve the Telegram sender's trust level using the agent's role model — the
 * same `hasRoleAccess` check every surface runs. OWNER access satisfies
 * `requiresAuth`; ADMIN access satisfies `requiresElevated`. The sender's
 * Telegram user id is mapped through the account-scoped `createUniqueUuid`
 * (matching `MessageManager`), so role resolution reads the canonical-owner /
 * world-role state the inbound pipeline established.
 */
export async function resolveTelegramSenderAuth(
  ctx: Context,
  runtime: IAgentRuntime,
  accountId: string,
): Promise<ConnectorSenderAuth> {
  const fromId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (fromId === undefined || chatId === undefined) {
    // No identity to resolve — fail closed.
    return { isAuthorized: false, isElevated: false };
  }

  const entityId = createUniqueUuid(
    runtime,
    scopedTelegramKey(String(fromId), accountId),
  ) as UUID;
  const roomId = createUniqueUuid(
    runtime,
    scopedTelegramKey(String(chatId), accountId),
  ) as UUID;

  const memory: Memory = {
    id: createUniqueUuid(runtime, `${chatId}-${fromId}-cmd`) as UUID,
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: { text: "/whoami", source: TELEGRAM_SURFACE },
    createdAt: Date.now(),
  };

  const [isOwner, isAdmin] = await Promise.all([
    hasRoleAccess(runtime, memory, "OWNER"),
    hasRoleAccess(runtime, memory, "ADMIN"),
  ]);

  const senderName =
    ctx.from?.username ?? ctx.from?.first_name ?? String(fromId);
  return { isAuthorized: isOwner, isElevated: isAdmin, senderName };
}

/**
 * Run an agent-target command. Gate-safe commands (help/status/whoami/…) are
 * resolved deterministically via `resolveCommand` and answered locally — no
 * round-trip through the LLM pipeline. Everything else routes the command
 * message through the agent pipeline, forcing a reply.
 */
async function dispatchAgentCommand(
  ctx: Context,
  runtime: IAgentRuntime,
  messageManager: MessageManager,
  accountId: string,
  descriptor: TelegramCommandDescriptor,
  sender: ConnectorSenderAuth,
): Promise<void> {
  const fromId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (fromId !== undefined && chatId !== undefined) {
    const entityId = createUniqueUuid(
      runtime,
      scopedTelegramKey(String(fromId), accountId),
    ) as UUID;
    const roomId = createUniqueUuid(
      runtime,
      scopedTelegramKey(String(chatId), accountId),
    ) as UUID;
    const message: Memory = {
      id: createUniqueUuid(runtime, `${chatId}-${fromId}-${Date.now()}`) as UUID,
      entityId,
      agentId: runtime.agentId,
      roomId,
      content: { text: messageText(ctx), source: TELEGRAM_SURFACE },
      createdAt: Date.now(),
    };
    const resolved = await resolveCommand(runtime, message, {
      isAuthorized: sender.isAuthorized,
      isElevated: sender.isElevated,
      ...(sender.senderName ? { senderName: sender.senderName } : {}),
    });
    if (resolved.handled && resolved.reply !== undefined) {
      await ctx.reply(resolved.reply.slice(0, TELEGRAM_MESSAGE_MAX));
      return;
    }
  }

  await messageManager.handleMessage(ctx, { forceReply: true });
  logger.debug(
    {
      src: "plugin:telegram",
      agentId: runtime.agentId,
      accountId,
      command: descriptor.name,
    },
    "Routed slash command to agent",
  );
}

/**
 * Build the Telegraf handler for a catalog command. Resolves the sender's trust
 * level, gates `requiresAuth` / `requiresElevated` commands (refusing with a
 * clear reply when the sender lacks access), then dispatches by target kind.
 * The handler never calls `next()`, terminating the middleware chain so the
 * catch-all message handler does not re-process the command.
 */
function buildCommandHandler(
  descriptor: TelegramCommandDescriptor,
  runtime: IAgentRuntime,
  messageManager: MessageManager,
  accountId: string,
): (ctx: Context) => Promise<void> {
  const { command } = descriptor;

  return async (ctx: Context) => {
    const sender = await resolveTelegramSenderAuth(ctx, runtime, accountId);
    const gate = gateConnectorCommandByName(
      runtime.agentId,
      command.name,
      sender,
    );
    if (!gate.allowed) {
      await ctx.reply(gate.reply);
      return;
    }

    const target = command.target;
    if (target.kind === "navigate") {
      let sectionLabel: string | undefined;
      if (command.name === "settings") {
        const raw = firstCommandArg(messageText(ctx));
        if (raw) sectionLabel = resolveSettingsSection(raw) ?? raw;
      }
      await ctx.reply(describeNavigation(command, sectionLabel));
      return;
    }

    if (target.kind === "client") {
      // GUI/TUI-only behaviors have no Telegram surface; the catalog should not
      // emit them for remote connectors, so this branch is defensive only.
      await ctx.reply(`/${descriptor.name} is only available in the Eliza app.`);
      return;
    }

    await dispatchAgentCommand(
      ctx,
      runtime,
      messageManager,
      accountId,
      descriptor,
      sender,
    );
  };
}

/**
 * Register Telegraf `bot.command(...)` handlers for every catalog command.
 * Returns the registered descriptors (the caller reads `.length`). Each handler
 * routes per the command's target and never calls `next()`.
 */
export function registerTelegramCommandHandlers(
  bot: Telegraf<Context>,
  runtime: IAgentRuntime,
  messageManager: MessageManager,
  accountId: string,
): TelegramCommandDescriptor[] {
  const descriptors = buildTelegramCommandDescriptors();
  for (const descriptor of descriptors) {
    const handler = buildCommandHandler(
      descriptor,
      runtime,
      messageManager,
      accountId,
    );
    bot.command(descriptor.name, async (ctx) => {
      try {
        await handler(ctx);
      } catch (error) {
        logger.error(
          {
            src: "plugin:telegram",
            agentId: runtime.agentId,
            accountId,
            command: descriptor.name,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error handling slash command",
        );
        await ctx
          .reply(`Could not run /${descriptor.name}.`)
          .catch(() => undefined);
      }
    });
  }
  return descriptors;
}

/**
 * Publish the catalog to Telegram's `/` command menu via `setMyCommands`.
 *
 * Failure is logged and swallowed: `setMyCommands` is a best-effort network
 * call made during boot, and a transient API/network error must not crash the
 * service. `service.ts` relies on this being non-throwing.
 */
export async function applyTelegramSetMyCommands(
  bot: Telegraf<Context>,
  runtime: IAgentRuntime,
  accountId: string,
): Promise<void> {
  const descriptors = buildTelegramCommandDescriptors();
  if (descriptors.length === 0) return;
  const commands = descriptors.map((descriptor) => ({
    command: descriptor.name,
    description: descriptor.description,
  }));
  try {
    await bot.telegram.setMyCommands(commands);
    logger.debug(
      {
        src: "plugin:telegram",
        agentId: runtime.agentId,
        accountId,
        commandCount: commands.length,
      },
      "Published slash-command menu to Telegram",
    );
  } catch (error) {
    logger.warn(
      {
        src: "plugin:telegram",
        agentId: runtime.agentId,
        accountId,
        error: error instanceof Error ? error.message : String(error),
      },
      "setMyCommands failed; slash-command menu not published",
    );
  }
}
