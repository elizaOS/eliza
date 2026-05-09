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
 *
 * These routes are registered with `rawPath: true` so they mount at their
 * legacy paths without the plugin-name prefix.
 */

import type {
  IAgentRuntime,
  Route,
  RouteRequest,
  RouteResponse,
} from "@elizaos/core";
import { logger } from "@elizaos/core";

const TELEGRAM_API_BASE = "https://api.telegram.org";

interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}

/**
 * Minimal interface for the connector-setup service exposed by the agent.
 * Plugins access it via `runtime.getService("connector-setup")`.
 */
interface ConnectorSetupService {
  getConfig(): Record<string, unknown>;
  persistConfig(config: Record<string, unknown>): void;
  updateConfig(updater: (config: Record<string, unknown>) => void): void;
  registerEscalationChannel(channelName: string): boolean;
  setOwnerContact(update: {
    source: string;
    channelId?: string;
    entityId?: string;
    roomId?: string;
  }): boolean;
}

function isConnectorSetupService(
  service: unknown,
): service is ConnectorSetupService {
  if (!service || typeof service !== "object") {
    return false;
  }
  const candidate = service as Partial<ConnectorSetupService>;
  return (
    typeof candidate.getConfig === "function" &&
    typeof candidate.updateConfig === "function" &&
    typeof candidate.persistConfig === "function" &&
    typeof candidate.registerEscalationChannel === "function" &&
    typeof candidate.setOwnerContact === "function"
  );
}

function getSetupService(runtime: IAgentRuntime): ConnectorSetupService | null {
  const service = runtime.getService("connector-setup");
  return isConnectorSetupService(service) ? service : null;
}

async function readJsonBody<T>(req: RouteRequest): Promise<T | null> {
  return (req.body as T) ?? null;
}

// ── POST /api/telegram-setup/validate-token ──────────────────────────
async function handleValidateToken(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const body = await readJsonBody<{ token?: string }>(req);
  const token = typeof body?.token === "string" ? body.token.trim() : "";

  if (!token) {
    res.status(200).json({ ok: false, error: "token is required" });
    return;
  }

  // Basic format check: <bot_id>:<alphanumeric>
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
    res.status(200).json({
      ok: false,
      error: "Token format invalid. Expected format: 123456:ABC-DEF...",
    });
    return;
  }

  try {
    const apiRes = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!apiRes.ok) {
      res.status(200).json({
        ok: false,
        error: `Telegram API returned ${apiRes.status}. Check that the token is correct.`,
      });
      return;
    }

    const data = (await apiRes.json()) as {
      ok: boolean;
      result?: TelegramBotInfo;
    };
    if (!data.ok || !data.result) {
      res.status(200).json({
        ok: false,
        error: "Telegram API returned unexpected response",
      });
      return;
    }

    const bot = data.result;
    const setupService = getSetupService(runtime);

    if (setupService) {
      setupService.updateConfig((config) => {
        if (!config.connectors) {
          config.connectors = {};
        }
        const connectors = config.connectors as Record<
          string,
          Record<string, unknown>
        >;
        if (!connectors.telegram || typeof connectors.telegram !== "object") {
          connectors.telegram = {};
        }
        connectors.telegram.botToken = token;
      });

      // Auto-populate owner contact so LifeOps can deliver reminders
      setupService.setOwnerContact({
        source: "telegram",
        channelId: String(bot.id),
      });
      // Add Telegram to the escalation channel list
      setupService.registerEscalationChannel("telegram");
    } else {
      logger.warn(
        "[telegram-setup] connector-setup service not available — token saved to runtime only",
      );
    }

    res.status(200).json({
      ok: true,
      bot: {
        id: bot.id,
        username: bot.username,
        firstName: bot.first_name,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(200).json({
      ok: false,
      error: `Failed to reach Telegram API: ${message}`,
    });
  }
}

// ── GET /api/telegram-setup/status ───────────────────────────────────
async function handleStatus(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const setupService = getSetupService(runtime);
  let hasToken = false;

  if (setupService) {
    const config = setupService.getConfig();
    const connectors = (config.connectors ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const tgConfig = connectors.telegram;
    hasToken = Boolean(tgConfig?.botToken);
  }
  if (!hasToken) {
    hasToken = Boolean(runtime.getSetting("TELEGRAM_BOT_TOKEN"));
  }

  // Check if the Telegram service is running
  const service = runtime.getService("telegram");
  const connected = Boolean(service);

  res.status(200).json({
    available: true,
    hasToken,
    connected,
  });
}

// ── POST /api/telegram-setup/disconnect ──────────────────────────────
async function handleDisconnect(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const setupService = getSetupService(runtime);

  if (setupService) {
    setupService.updateConfig((config) => {
      const connectors = (config.connectors ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const tgConfig = connectors.telegram;
      if (tgConfig) {
        delete tgConfig.botToken;
      }
    });
  }

  res.status(200).json({ ok: true });
}

/**
 * Plugin routes for Telegram bot setup.
 * Registered with `rawPath: true` to preserve legacy `/api/telegram-setup/*` paths.
 */
export const telegramSetupRoutes: Route[] = [
  {
    type: "POST",
    path: "/api/telegram-setup/validate-token",
    handler: handleValidateToken,
    rawPath: true,
  },
  {
    type: "GET",
    path: "/api/telegram-setup/status",
    handler: handleStatus,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/telegram-setup/disconnect",
    handler: handleDisconnect,
    rawPath: true,
  },
];
