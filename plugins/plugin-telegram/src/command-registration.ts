/**
 * Universal slash-command registration for the Telegram connector.
 *
 * Bridges the connector-neutral command catalog from `@elizaos/plugin-commands`
 * onto Telegraf's native command surface:
 *
 *   - {@link buildTelegramSetMyCommands} produces the `setMyCommands` payload so
 *     the catalog appears in Telegram's `/`-menu.
 *   - {@link registerTelegramCommandHandlers} registers one `bot.command(name)`
 *     handler per catalog entry, BEFORE `bot.launch()`. Each handler interprets
 *     the command's `target`:
 *       - `agent`   → routes the full command text through the agent and forces
 *                     a reply even when `TELEGRAM_AUTO_REPLY` is off.
 *       - `navigate`→ replies with a short "open this in the Eliza app" hint,
 *                     plus a deep link when an app URL is configured.
 *       - `client`  → these are GUI/TUI-only and never surface for Telegram, so
 *                     this branch is defensive only.
 *
 * Double-processing note:
 * Telegraf composes middleware sequentially. `bot.command(name, handler)` runs
 * the handler only when the command matches, and passes `next` INTO the handler
 * (see telegraf's `Composer.command`). Because our handlers never call `next()`,
 * a matched command terminates the middleware chain and the catch-all
 * `bot.on("message")` handler does NOT also fire for it. No ctx flag or manual
 * short-circuit is required — not calling `next()` is the idiomatic stop. The
 * existing `/eliza_pair` handler relies on the same property and is left intact
 * (we skip re-registering it).
 */

import { type IAgentRuntime, logger } from "@elizaos/core";
import {
  type ConnectorCommand,
  getConnectorCommands,
  getTelegramBotCommands,
} from "@elizaos/plugin-commands";
import type { Context, Telegraf } from "telegraf";
import type { MessageManager } from "./messageManager";

/** Command names already owned by other services; never re-register them. */
const RESERVED_COMMAND_NAMES = new Set<string>(["eliza_pair", "start"]);

/** Optional runtime settings that, when present, provide an app base URL. */
const APP_URL_SETTING_KEYS = [
  "ELIZA_APP_URL",
  "MILADY_APP_URL",
  "APP_BASE_URL",
] as const;

/**
 * The `setMyCommands` payload for the Telegram command menu. A thin re-export of
 * the catalog helper so callers depend on this module rather than reaching into
 * `@elizaos/plugin-commands` directly.
 */
export function buildTelegramSetMyCommands(): Array<{
  command: string;
  description: string;
}> {
  return getTelegramBotCommands();
}

/**
 * Reads a configured app base URL from the runtime, if any. Returns null when no
 * app URL is configured — we never fabricate one (remote Telegram users have no
 * guaranteed app surface to navigate to).
 */
function resolveAppBaseUrl(runtime: IAgentRuntime): string | null {
  for (const key of APP_URL_SETTING_KEYS) {
    const value = runtime.getSetting(key);
    if (typeof value === "string" && value.trim()) {
      return value.trim().replace(/\/+$/, "");
    }
  }
  return null;
}

/**
 * Builds the plain-text reply for a `navigate` command. Telegram has no in-chat
 * app navigation, so we name the destination and append a deep link only when an
 * app base URL is configured. Pure function — unit-testable without a bot.
 */
export function buildNavigateReply(
  command: ConnectorCommand,
  appBaseUrl: string | null,
): string {
  if (command.target.kind !== "navigate") {
    throw new Error(
      `buildNavigateReply called for non-navigate command "${command.name}"`,
    );
  }
  const { section, path } = command.target;
  const where = section ? `${command.name} → ${section}` : command.name;
  if (appBaseUrl && path) {
    const link = `${appBaseUrl}${path}`;
    return `Open ${where} in the Eliza app: ${link}`;
  }
  return `Open ${where} in the Eliza app.`;
}

/**
 * The reply for a `client` command, which runs a pure-client behavior with no
 * agent round-trip. Client commands are GUI/TUI-only and are filtered out of the
 * Telegram surface, so this is defensive only.
 */
export function buildClientReply(command: ConnectorCommand): string {
  return `/${command.name} isn't available on Telegram — use the Eliza app or terminal.`;
}

/**
 * Registers a `bot.command(...)` handler for every catalog command on the given
 * surface. Must be called BEFORE `bot.launch()`. Returns the list of command
 * names that were registered (excludes reserved/duplicate names).
 *
 * @param bot - The Telegraf instance for this account.
 * @param runtime - The agent runtime.
 * @param messageManager - The account's MessageManager, used to route `agent`
 *   commands through the runtime with a forced reply.
 * @param accountId - The Telegram account id (for log context).
 */
export function registerTelegramCommandHandlers(
  bot: Telegraf<Context>,
  runtime: IAgentRuntime,
  messageManager: MessageManager,
  accountId: string,
): string[] {
  const registered: string[] = [];
  const seen = new Set<string>();

  for (const command of getConnectorCommands("telegram")) {
    if (RESERVED_COMMAND_NAMES.has(command.name) || seen.has(command.name)) {
      continue;
    }
    seen.add(command.name);
    registered.push(command.name);

    bot.command(command.name, async (ctx) => {
      await executeTelegramCommand(
        command,
        ctx,
        runtime,
        messageManager,
        accountId,
      );
    });
  }

  return registered;
}

/**
 * Executes a single catalog command against a Telegraf context. Extracted from
 * the handler closure so it can be unit-tested directly with a mocked ctx,
 * runtime, and message manager.
 */
export async function executeTelegramCommand(
  command: ConnectorCommand,
  ctx: Context,
  runtime: IAgentRuntime,
  messageManager: MessageManager,
  accountId: string,
): Promise<void> {
  switch (command.target.kind) {
    case "agent": {
      // Explicit command = explicit intent: force a reply even when
      // TELEGRAM_AUTO_REPLY is off. handleMessage rebuilds the memory from the
      // command text (e.g. "/model gpt-5") and routes it to the message service.
      await messageManager.handleMessage(ctx, { forceReply: true });
      return;
    }
    case "navigate": {
      const reply = buildNavigateReply(command, resolveAppBaseUrl(runtime));
      await ctx.reply(reply);
      return;
    }
    case "client": {
      await ctx.reply(buildClientReply(command));
      return;
    }
    default: {
      // Exhaustiveness guard: a new CommandTarget kind would surface here.
      logger.warn(
        {
          src: "plugin:telegram:commands",
          agentId: runtime.agentId,
          accountId,
          command: command.name,
          targetKind: (command.target as { kind: string }).kind,
        },
        "Unhandled command target kind; ignoring",
      );
      return;
    }
  }
}

/**
 * Pushes the catalog command menu to Telegram via `setMyCommands`. Network
 * failures are logged and swallowed — a transient Telegram outage must not crash
 * bot startup. Returns true on success, false when the call failed or there were
 * no commands to publish.
 */
export async function applyTelegramSetMyCommands(
  bot: Telegraf<Context>,
  runtime: IAgentRuntime,
  accountId: string,
): Promise<boolean> {
  const commands = buildTelegramSetMyCommands();
  if (commands.length === 0) {
    return false;
  }
  try {
    await bot.telegram.setMyCommands(commands);
    logger.debug(
      {
        src: "plugin:telegram:commands",
        agentId: runtime.agentId,
        accountId,
        commandCount: commands.length,
      },
      "Published slash-command menu to Telegram",
    );
    return true;
  } catch (error) {
    logger.warn(
      {
        src: "plugin:telegram:commands",
        agentId: runtime.agentId,
        accountId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to publish slash-command menu to Telegram (setMyCommands)",
    );
    return false;
  }
}
