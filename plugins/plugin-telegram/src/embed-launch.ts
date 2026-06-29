/**
 * Telegram Mini App launch surface (#9947).
 *
 * Adds a role-gated `/app` command that emits a Telegram `web_app` inline
 * button opening the dashboard embed view inside Telegram's Mini App webview.
 * The button is ONLY emitted for OWNER/ADMIN senders — resolved through the
 * same `resolveTelegramSenderAuth` / `hasRoleAccess` gate every other Telegram
 * command surface uses. A non-elevated sender gets a refusal and never sees a
 * launch button (fail closed).
 *
 * The embed page authenticates separately: once opened, the Mini App reads
 * `Telegram.WebApp.initData` and posts it to the server, which re-verifies the
 * HMAC and mints a scoped embed session token (see app-core `embed-auth`). The
 * button is the entry point; the cryptographic gate is enforced server-side.
 */

import { type IAgentRuntime, logger } from "@elizaos/core";
import type { ConnectorSenderAuth } from "@elizaos/plugin-commands";
import type { InlineKeyboardButton } from "@telegraf/types";
import { type Context, Markup, type Telegraf } from "telegraf";
import { resolveTelegramSenderAuth } from "./command-registration";

/** Command that opens the dashboard Mini App. */
export const EMBED_LAUNCH_COMMAND = "app";
const EMBED_LAUNCH_BUTTON_TEXT = "Open dashboard";
const EMBED_LAUNCH_REPLY = "Open the Eliza dashboard:";
const EMBED_LAUNCH_DENIED_REPLY =
  "The dashboard is available to owners and admins only.";

/**
 * Resolve the HTTPS URL of the dashboard embed surface. Telegram requires a
 * `web_app` URL to be HTTPS, so a non-HTTPS or unset value yields `null`
 * (no button is shown). An explicit `TELEGRAM_MINI_APP_URL` wins; otherwise the
 * public app URL gets the `/embed` path appended.
 */
export function resolveEmbedLaunchUrl(runtime: IAgentRuntime): string | null {
  const explicit = runtime.getSetting("TELEGRAM_MINI_APP_URL");
  if (typeof explicit === "string" && explicit.startsWith("https://")) {
    return explicit;
  }
  const base =
    runtime.getSetting("ELIZA_PUBLIC_URL") ??
    runtime.getSetting("APP_PUBLIC_URL") ??
    runtime.getSetting("ELIZA_APP_URL");
  if (typeof base === "string" && base.startsWith("https://")) {
    return `${base.replace(/\/+$/, "")}/embed`;
  }
  return null;
}

/**
 * Build the `web_app` inline-keyboard rows for the launch button, or `null`
 * when the sender is not OWNER/ADMIN or no HTTPS embed URL is configured.
 * Fail-closed: an unauthorized sender always yields `null`.
 */
export function buildTelegramEmbedLaunchButton(params: {
  sender: ConnectorSenderAuth;
  url: string | null;
}): InlineKeyboardButton[][] | null {
  if (!params.url) return null;
  // `isElevated` is the ADMIN check (true for OWNER and ADMIN); `isAuthorized`
  // is the OWNER check. Either grants the embed admin surface.
  if (!params.sender.isElevated && !params.sender.isAuthorized) return null;
  return [[{ text: EMBED_LAUNCH_BUTTON_TEXT, web_app: { url: params.url } }]];
}

/**
 * Register the `/app` Mini App launch command. The handler resolves the
 * sender's trust level and only attaches the `web_app` button for OWNER/ADMIN.
 */
export function registerTelegramEmbedLaunchCommand(
  bot: Telegraf<Context>,
  runtime: IAgentRuntime,
  accountId: string,
): void {
  bot.command(EMBED_LAUNCH_COMMAND, async (ctx) => {
    try {
      const sender = await resolveTelegramSenderAuth(ctx, runtime, accountId);
      const rows = buildTelegramEmbedLaunchButton({
        sender,
        url: resolveEmbedLaunchUrl(runtime),
      });
      if (!rows) {
        await ctx.reply(EMBED_LAUNCH_DENIED_REPLY);
        return;
      }
      await ctx.reply(EMBED_LAUNCH_REPLY, {
        reply_markup: Markup.inlineKeyboard(rows).reply_markup,
      });
    } catch (error) {
      logger.error(
        {
          src: "plugin:telegram",
          agentId: runtime.agentId,
          accountId,
          command: EMBED_LAUNCH_COMMAND,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error handling /app launch command",
      );
      await ctx.reply("Could not open the dashboard.").catch(() => undefined);
    }
  });
}
