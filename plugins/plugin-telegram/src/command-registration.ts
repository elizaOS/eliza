/**
 * Universal slash-command catalog → Telegram native commands.
 *
 * Maps the connector-neutral command catalog from `@elizaos/plugin-commands`
 * (`getConnectorCommands("telegram")`) onto Telegraf `bot.command(...)` handlers
 * and the Telegram `/` menu (`setMyCommands`), so the same agent-capability and
 * navigation commands the dashboard and Discord expose appear natively in
 * Telegram.
 *
 * Per-target dispatch:
 *   - `agent`    → the reconstructed command text (the user's `/command args`
 *                  message) is routed through the agent's message pipeline via
 *                  `MessageManager.handleMessage(ctx, { forceReply: true })`,
 *                  the same path inbound messages take. `forceReply` bypasses
 *                  the `TELEGRAM_AUTO_REPLY` gate because an explicit slash
 *                  command is an explicit request for a response.
 *   - `navigate` → replies describing the in-app destination, resolving the
 *                  `/settings <section>` argument when present.
 *   - `client`   → GUI/TUI-only behaviors have no Telegram surface; handled
 *                  defensively with a short reply rather than crashing.
 *
 * A matched `bot.command` handler never calls `next()`, so the catch-all
 * message handler registered in `service.ts` does not also process command
 * messages (no double-processing).
 */

import { type IAgentRuntime, logger } from "@elizaos/core";
import {
  type ConnectorCommand,
  getConnectorCommands,
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
  for (const command of getConnectorCommands("telegram")) {
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

/**
 * Build the Telegraf handler for a catalog command, branching on its target.
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
  const target = command.target;

  if (target.kind === "navigate") {
    return async (ctx: Context) => {
      const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
      let sectionLabel: string | undefined;
      if (command.name === "settings") {
        const raw = firstCommandArg(text);
        if (raw) sectionLabel = resolveSettingsSection(raw) ?? raw;
      }
      await ctx.reply(describeNavigation(command, sectionLabel));
    };
  }

  if (target.kind === "client") {
    // GUI/TUI-only behaviors have no Telegram surface; the catalog should not
    // emit them for remote connectors, so this branch is defensive only.
    return async (ctx: Context) => {
      await ctx.reply(
        `/${descriptor.name} is only available in the Eliza app.`,
      );
    };
  }

  // target.kind === "agent": route the command message through the agent
  // pipeline, forcing a reply since the user explicitly invoked the command.
  return async (ctx: Context) => {
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
