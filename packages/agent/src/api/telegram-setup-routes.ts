/**
 * Telegram bot setup HTTP routes.
 *
 * Provides a guided setup flow for connecting a Telegram bot:
 *
 *   POST /api/telegram-setup/validate-token   validate + save bot token
 *   GET  /api/telegram-setup/status           check current connection
 *   POST /api/telegram-setup/disconnect       remove saved token
 *
 * Token validation hits the Telegram Bot API getMe endpoint directly.
 * On success the token is persisted to the connector config so the
 * plugin auto-enables on next restart.
 */

import type http from "node:http";
import { registerEscalationChannel } from "../services/escalation.js";
import { setOwnerContact } from "./owner-contact-helpers.js";
import type { RouteHelpers } from "@elizaos/shared";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_BODY_BYTES = 4096;

interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}

export interface TelegramSetupRouteState {
  config: Record<string, unknown> & {
    connectors?: Record<string, Record<string, unknown>>;
  };
  saveConfig: () => void;
  runtime?: {
    getService(type: string): unknown;
    getSetting(key: string): string | undefined;
  };
}

export async function handleTelegramSetupRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: TelegramSetupRouteState,
  helpers: RouteHelpers,
): Promise<boolean> {
  if (!pathname.startsWith("/api/telegram-setup")) return false;

  // ── POST /api/telegram-setup/validate-token ──────────────────────────
  if (method === "POST" && pathname === "/api/telegram-setup/validate-token") {
    const body = await helpers.readJsonBody<{ token?: string }>(req, res, {
      maxBytes: MAX_BODY_BYTES,
    });
    if (!body) return true;

    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) {
      helpers.json(res, { ok: false, error: "token is required" });
      return true;
    }

    // Basic format check: <bot_id>:<alphanumeric>
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
      helpers.json(res, {
        ok: false,
        error: "Token format invalid. Expected format: 123456:ABC-DEF...",
      });
      return true;
    }

    try {
      const apiRes = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getMe`, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!apiRes.ok) {
        helpers.json(res, {
          ok: false,
          error: `Telegram API returned ${apiRes.status}. Check that the token is correct.`,
        });
        return true;
      }

      const data = (await apiRes.json()) as {
        ok: boolean;
        result?: TelegramBotInfo;
      };
      if (!data.ok || !data.result) {
        helpers.json(res, {
          ok: false,
          error: "Telegram API returned unexpected response",
        });
        return true;
      }

      const bot = data.result;

      // Save token to connector config
      let connectors = state.config.connectors;
      if (!connectors) {
        connectors = {};
        (state.config as Record<string, unknown>).connectors = connectors;
      }
      if (!connectors.telegram || typeof connectors.telegram !== "object") {
        connectors.telegram = {};
      }
      (connectors.telegram as Record<string, unknown>).botToken = token;

      // Auto-populate owner contact so LifeOps can deliver reminders
      setOwnerContact(state.config as Parameters<typeof setOwnerContact>[0], {
        source: "telegram",
        channelId: String(bot.id),
      });
      // Add Telegram to the escalation channel list so it is reachable
      // without the user explicitly configuring escalation.
      registerEscalationChannel("telegram");

      state.saveConfig();

      helpers.json(res, {
        ok: true,
        bot: {
          id: bot.id,
          username: bot.username,
          firstName: bot.first_name,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      helpers.json(res, {
        ok: false,
        error: `Failed to reach Telegram API: ${message}`,
      });
    }
    return true;
  }

  // ── GET /api/telegram-setup/status ───────────────────────────────────
  if (method === "GET" && pathname === "/api/telegram-setup/status") {
    const connectors = state.config.connectors ?? {};
    const tgConfig = connectors.telegram as Record<string, unknown> | undefined;
    const hasToken = Boolean(
      tgConfig?.botToken || state.runtime?.getSetting("TELEGRAM_BOT_TOKEN"),
    );

    // Check if the Telegram service is running
    const service = state.runtime?.getService("telegram");
    const connected = Boolean(service);

    helpers.json(res, {
      available: true,
      hasToken,
      connected,
    });
    return true;
  }

  // ── POST /api/telegram-setup/disconnect ──────────────────────────────
  if (method === "POST" && pathname === "/api/telegram-setup/disconnect") {
    const connectors = state.config.connectors ?? {};
    const tgConfig = connectors.telegram as Record<string, unknown> | undefined;
    if (tgConfig) {
      delete tgConfig.botToken;
      state.saveConfig();
    }
    helpers.json(res, { ok: true });
    return true;
  }

  return false;
}
