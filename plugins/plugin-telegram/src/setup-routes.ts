/**
 * Telegram bot setup HTTP routes.
 *
 * Implements the shared connector setup contract
 * (`eliza/packages/app-core/src/api/setup-contract.ts`):
 *
 *   GET  /api/setup/telegram/status   read current pairing state
 *   POST /api/setup/telegram/start    validate + save bot token
 *   POST /api/setup/telegram/cancel   remove saved token
 *
 * Token validation hits the Telegram Bot API getMe endpoint directly.
 * On success the token is persisted to the connector config so the
 * plugin auto-enables on next restart.
 *
 * These routes are registered with `rawPath: true` so they mount at the
 * canonical `/api/setup/telegram/...` paths without the plugin-name prefix.
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

/** Canonical setup state matching `SetupState` in app-core setup-contract.ts. */
type SetupState = "idle" | "configuring" | "paired" | "error";

interface SetupStatusResponse {
  connector: "telegram";
  state: SetupState;
  detail?: {
    bot?: {
      id: number;
      username: string;
      firstName: string;
    };
    hasToken?: boolean;
    serviceConnected?: boolean;
    message?: string;
  };
}

function sendSetupError(
  res: RouteResponse,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ error: { code, message } });
}

function sendStatus(res: RouteResponse, body: SetupStatusResponse): void {
  res.status(200).json(body);
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

function readSavedToken(
  setupService: ConnectorSetupService | null,
  runtime: IAgentRuntime,
): string | null {
  if (setupService) {
    const config = setupService.getConfig();
    const connectors = (config.connectors ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const tgConfig = connectors.telegram;
    const persisted = tgConfig?.botToken;
    if (typeof persisted === "string" && persisted.length > 0) {
      return persisted;
    }
  }
  const fromSetting = runtime.getSetting("TELEGRAM_BOT_TOKEN");
  return typeof fromSetting === "string" && fromSetting.length > 0
    ? fromSetting
    : null;
}

function currentStatus(
  setupService: ConnectorSetupService | null,
  runtime: IAgentRuntime,
): SetupStatusResponse {
  const hasToken = Boolean(readSavedToken(setupService, runtime));
  const serviceConnected = Boolean(runtime.getService("telegram"));
  const state: SetupState = hasToken
    ? serviceConnected
      ? "paired"
      : "configuring"
    : "idle";
  return {
    connector: "telegram",
    state,
    detail: {
      hasToken,
      serviceConnected,
    },
  };
}

// ── GET /api/setup/telegram/status ──────────────────────────────────
async function handleStatus(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const setupService = getSetupService(runtime);
  sendStatus(res, currentStatus(setupService, runtime));
}

// ── POST /api/setup/telegram/start ──────────────────────────────────
async function handleStart(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const body = await readJsonBody<{ token?: string }>(req);
  const token = typeof body?.token === "string" ? body.token.trim() : "";

  if (!token) {
    sendSetupError(res, 400, "bad_request", "token is required");
    return;
  }

  // Basic format check: <bot_id>:<alphanumeric>
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
    sendSetupError(
      res,
      400,
      "bad_request",
      "Token format invalid. Expected format: 123456:ABC-DEF...",
    );
    return;
  }

  let apiRes: Response;
  try {
    apiRes = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendSetupError(
      res,
      502,
      "upstream_unreachable",
      `Failed to reach Telegram API: ${message}`,
    );
    return;
  }

  if (!apiRes.ok) {
    sendSetupError(
      res,
      502,
      "upstream_unreachable",
      `Telegram API returned ${apiRes.status}. Check that the token is correct.`,
    );
    return;
  }

  const data = (await apiRes.json()) as {
    ok: boolean;
    result?: TelegramBotInfo;
  };
  if (!data.ok || !data.result) {
    sendSetupError(
      res,
      502,
      "upstream_unreachable",
      "Telegram API returned unexpected response",
    );
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

  sendStatus(res, {
    connector: "telegram",
    state: "configuring",
    detail: {
      bot: {
        id: bot.id,
        username: bot.username,
        firstName: bot.first_name,
      },
      hasToken: true,
      serviceConnected: Boolean(runtime.getService("telegram")),
    },
  });
}

// ── POST /api/setup/telegram/cancel ─────────────────────────────────
async function handleCancel(
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

  sendStatus(res, currentStatus(setupService, runtime));
}

/**
 * Plugin routes for Telegram bot setup.
 * Registered with `rawPath: true` to expose the canonical `/api/setup/telegram/*`
 * surface without the plugin-name prefix.
 */
export const telegramSetupRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/setup/telegram/status",
    handler: handleStatus,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/setup/telegram/start",
    handler: handleStart,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/setup/telegram/cancel",
    handler: handleCancel,
    rawPath: true,
  },
];
