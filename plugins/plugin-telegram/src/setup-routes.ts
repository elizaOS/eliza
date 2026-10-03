/**
 * Telegram bot setup HTTP routes.
 *
 * Implements the shared connector setup contract
 * (`eliza/packages/app/src/api/setup-contract.ts`):
 *
 *   GET  /api/setup/telegram/status   read current pairing state
 *   POST /api/setup/telegram/start    validate + save bot token
 *   POST /api/setup/telegram/cancel   remove saved token
 *   POST /api/setup/telegram/disconnect drain and disable the default bot
 *
 * Token validation hits the Telegram Bot API getMe endpoint directly.
 * On success the token is persisted to the connector config so the
 * plugin auto-enables on next restart.
 *
 * These routes are registered with `rawPath: true` so they mount at the
 * canonical `/api/setup/telegram/...` paths without the plugin-name prefix.
 */

import {
  ElizaError,
  type IAgentRuntime,
  logger,
  type SetupState,
} from "@elizaos/core";
import {
  type Route,
  type RouteRequest,
  type RouteResponse,
} from "@elizaos/core/api/http-plugin";
import { DEFAULT_ACCOUNT_ID } from "./accounts";
import { resolveTelegramBotCredential } from "./bot-credential";
import {
  getTelegramPollerClaim,
  listTelegramPollerHealth,
} from "./poller-lock";

const TELEGRAM_API_BASE = "https://api.telegram.org";
interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}
// `SetupState` is the canonical connector lifecycle union from @elizaos/core.
// The response below specializes the generic `SetupStatusResponse<TDetail>`
// with Telegram's connector literal + detail shape, so it stays local.
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
    credentialRetained?: boolean;
    disconnectPending?: boolean;
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
  persistConnectorCredential?: (input: {
    provider: string;
    accountId: string;
    credentialType: string;
    value: string;
    caller?: string;
  }) => Promise<string | null>;
  removeConnectorCredentialReference?: (reference: string) => Promise<boolean>;
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
    // A never-configured deployment has no `connectors.telegram` block at all
    // (`handleStart` creates it only when a token is saved), so this lookup is
    // optional in exactly the same way `config.connectors` already is.
    const connectors = (config.connectors ?? {}) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    const tgConfig = connectors.telegram;
    const persisted = tgConfig?.botToken;
    if (typeof persisted === "string" && persisted.length > 0) {
      return persisted;
    }
    if (tgConfig?.enabled === false) return null;
  }
  const fromSetting = runtime.getSetting("TELEGRAM_BOT_TOKEN");
  return typeof fromSetting === "string" && fromSetting.length > 0
    ? fromSetting
    : null;
}
function isConfiguredPollerConnected(
  runtime: IAgentRuntime,
  token: string | null,
): boolean {
  const poller = token ? getTelegramPollerClaim(token) : undefined;
  return Boolean(
    poller?.ok &&
      poller.connected &&
      poller.ownerId === String(runtime.agentId) &&
      poller.accountId === DEFAULT_ACCOUNT_ID,
  );
}
/** Only identities validated by setup are available without contacting Telegram or Vault. */
function readConfiguredBot(config: Record<string, unknown> | undefined):
  | {
      id: number;
      username: string;
      firstName: string;
    }
  | undefined {
  const value = config?.bot;
  if (!value || typeof value !== "object") return undefined;
  const bot = value as Record<string, unknown>;
  if (
    typeof bot.id !== "number" ||
    !Number.isSafeInteger(bot.id) ||
    bot.id <= 0 ||
    typeof bot.username !== "string" ||
    typeof bot.firstName !== "string"
  )
    return undefined;
  return { id: bot.id, username: bot.username, firstName: bot.firstName };
}
async function currentStatus(
  setupService: ConnectorSetupService | null,
  runtime: IAgentRuntime,
): Promise<SetupStatusResponse> {
  const telegram = (
    setupService?.getConfig().connectors as
      | Record<string, Record<string, unknown>>
      | undefined
  )?.telegram;
  const bot = readConfiguredBot(telegram);
  if (telegram?.enabled === false) {
    const pollers = [
      ...listTelegramPollerHealth("full"),
      ...listTelegramPollerHealth("standalone"),
    ].filter((entry) => entry.ownerId === String(runtime.agentId));
    const pending = telegram.disconnectPending === true || pollers.length > 0;
    return {
      connector: "telegram",
      state: pending ? "configuring" : "idle",
      detail: {
        bot,
        disconnectPending: pending,
        hasToken: false,
        serviceConnected: pollers.some((entry) => entry.connected),
        credentialRetained: typeof telegram.botToken === "string",
        message: pending
          ? "Disconnect is incomplete. Retry to finish stopping the bot."
          : "Bot disconnected.",
      },
    };
  }
  const savedToken = readSavedToken(setupService, runtime);
  const token = await resolveTelegramBotCredential(
    runtime,
    savedToken,
    "telegram-setup-status",
  );
  const hasToken = Boolean(token);
  const serviceConnected = isConfiguredPollerConnected(runtime, token);
  const state: SetupState = hasToken
    ? serviceConnected
      ? "paired"
      : "configuring"
    : "idle";
  return {
    connector: "telegram",
    state,
    detail: {
      bot,
      hasToken,
      serviceConnected,
    },
  };
}
const setupMutations = new WeakSet<IAgentRuntime>();
/** Reject overlapping setup effects before token validation or configuration writes. */
function exclusiveSetup(
  handler: NonNullable<Route["handler"]>,
): Route["handler"] {
  return async (req, res, runtime) => {
    if (setupMutations.has(runtime)) {
      sendSetupError(
        res,
        409,
        "setup_pending",
        "Another Telegram setup operation is running. Wait and retry.",
      );
      return;
    }
    setupMutations.add(runtime);
    try {
      await handler(req, res, runtime);
    } finally {
      setupMutations.delete(runtime);
    }
  };
}
interface BotDisconnector {
  assertDefaultBotDisconnect(token?: string): string | null;
  disconnectDefaultBot(token?: string): Promise<void>;
}
function isBotDisconnector(service: unknown): service is BotDisconnector {
  if (!service || typeof service !== "object") return false;
  const candidate = service as Partial<BotDisconnector>;
  return (
    typeof candidate.assertDefaultBotDisconnect === "function" &&
    typeof candidate.disconnectDefaultBot === "function"
  );
}
/** Disconnect the managed default bot without changing personal or named accounts. */
async function handleDisconnect(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const body = await readJsonBody<{
    expectedBotId?: number;
  }>(req);
  const expectedBotId = body?.expectedBotId;
  if (
    typeof expectedBotId !== "number" ||
    !Number.isSafeInteger(expectedBotId) ||
    expectedBotId <= 0
  ) {
    sendSetupError(
      res,
      400,
      "bad_request",
      "The displayed bot identity is required. Refresh before disconnecting.",
    );
    return;
  }
  const matchesDisplayedBot = (token: string) =>
    Number(token.split(":", 1)[0]) === expectedBotId;
  const setup = getSetupService(runtime);
  if (!setup) {
    sendSetupError(
      res,
      503,
      "setup_unavailable",
      "Restore connector configuration access before disconnecting.",
    );
    return;
  }
  try {
    const connectors = setup.getConfig().connectors as
      | Record<string, Record<string, unknown>>
      | undefined;
    const config = connectors?.telegram;
    if (!config || config.accounts || config.personal) {
      sendSetupError(
        res,
        409,
        "disconnect_scope_unsupported",
        "This control disconnects a managed default bot. Review named and personal accounts separately.",
      );
      return;
    }
    const saved = config.botToken;
    const token = await resolveTelegramBotCredential(
      runtime,
      typeof saved === "string" ? saved : null,
      "telegram-disconnect",
    );
    if (token && !matchesDisplayedBot(token)) {
      sendSetupError(
        res,
        409,
        "disconnect_target_changed",
        "The connected bot changed. Refresh before disconnecting.",
      );
      return;
    }
    const services = runtime.getServicesByType("telegram");
    const service = services.length === 1 ? services[0] : null;
    const drainer = isBotDisconnector(service) ? service : null;
    const hasOwnedPoller = () =>
      [
        ...listTelegramPollerHealth("full"),
        ...listTelegramPollerHealth("standalone"),
      ].some((entry) => entry.ownerId === String(runtime.agentId));
    // An unregistered connector has no admitted work; a registered startup may still acquire a poller.
    if (
      (runtime.hasService("telegram") &&
        runtime.getServiceRegistrationStatus("telegram") !== "registered") ||
      (!drainer &&
        (service || runtime.hasService("telegram") || hasOwnedPoller()))
    ) {
      sendSetupError(
        res,
        503,
        "disconnect_service_unavailable",
        "Load the Telegram bot service before disconnecting so pending work can be drained.",
      );
      return;
    }
    if (!token) {
      if (config.enabled === false && !saved && !hasOwnedPoller()) {
        if (drainer) {
          const active = drainer.assertDefaultBotDisconnect();
          if (active && !matchesDisplayedBot(active)) {
            sendSetupError(
              res,
              409,
              "disconnect_target_changed",
              "The connected bot changed. Refresh before disconnecting.",
            );
            return;
          }
          await drainer.disconnectDefaultBot();
        }
        res.status(200).json({
          connector: "telegram",
          state: "disconnected",
          accountId: DEFAULT_ACCOUNT_ID,
        });
      } else {
        sendSetupError(
          res,
          409,
          "disconnect_identity_unavailable",
          "The managed bot credential is unavailable. Restore it before disconnecting.",
        );
      }
      return;
    }
    const claim = getTelegramPollerClaim(token);
    if (
      claim &&
      (claim.ownerId !== String(runtime.agentId) ||
        claim.accountId !== DEFAULT_ACCOUNT_ID ||
        claim.mode !== "full")
    ) {
      sendSetupError(
        res,
        409,
        "disconnect_scope_unsupported",
        "The credential belongs to another polling session. Disconnect it through its owning service.",
      );
      return;
    }
    const updateManaged = (pending: boolean, removeToken = false) =>
      setup.updateConfig((latest) => {
        const current = (
          latest.connectors as
            | Record<string, Record<string, unknown>>
            | undefined
        )?.telegram;
        if (
          !current ||
          current.botToken !== saved ||
          current.accounts ||
          current.personal
        ) {
          throw new ElizaError(
            "Telegram configuration changed. Refresh before retrying.",
            { code: "TELEGRAM_DISCONNECT_CONFIG_CHANGED" },
          );
        }
        current.enabled = false;
        if (pending) current.disconnectPending = true;
        else delete current.disconnectPending;
        if (removeToken) delete current.botToken;
      });
    // Persist the restart barrier before draining; failure keeps the token for retry.
    if (drainer) drainer.assertDefaultBotDisconnect(token);
    updateManaged(true);
    if (drainer) await drainer.disconnectDefaultBot(token);
    // Recheck after the asynchronous drain before touching credential storage.
    updateManaged(false);
    // The connection is disabled and drained even if an orphaned vault secret needs separate cleanup.
    const credentialRetained =
      typeof saved === "string" && saved.startsWith("vault://")
        ? !(await setup.removeConnectorCredentialReference?.(saved))
        : false;
    // Retain a disabled reference when cleanup fails so a retry can remove it.
    updateManaged(false, !credentialRetained);
    res.status(200).json({
      connector: "telegram",
      state: "disconnected",
      accountId: DEFAULT_ACCOUNT_ID,
      credentialRetained,
    });
  } catch (error) {
    // error-policy:J1 Incomplete shutdown remains a retryable failure, never an idle receipt.
    runtime.reportError("telegram.disconnect", error);
    sendSetupError(
      res,
      503,
      "disconnect_incomplete",
      "Telegram disconnect did not complete. Refresh its status and retry.",
    );
  }
}
// ── GET /api/setup/telegram/status ──────────────────────────────────
async function handleStatus(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const setupService = getSetupService(runtime);
  try {
    sendStatus(res, await currentStatus(setupService, runtime));
  } catch {
    // error-policy:J1 Credential-read failures are explicit and never expose secret-store errors.
    sendSetupError(
      res,
      503,
      "credential_unavailable",
      "Telegram readiness could not be checked. Restore access to the configured credential and retry.",
    );
  }
}
// ── POST /api/setup/telegram/start ──────────────────────────────────
async function handleStart(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const body = await readJsonBody<{
    token?: string;
  }>(req);
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
      signal: AbortSignal.timeout(10000),
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
    const storedToken = setupService.persistConnectorCredential
      ? ((await setupService.persistConnectorCredential({
          provider: "telegram",
          accountId: String(bot.id),
          credentialType: "bot-token",
          value: token,
          caller: "telegram-setup",
        })) ?? token)
      : token;
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
      connectors.telegram.botToken = storedToken;
      connectors.telegram.enabled = true;
      connectors.telegram.bot = {
        id: bot.id,
        username: bot.username,
        firstName: bot.first_name,
      };
      delete connectors.telegram.disconnectPending;
    });
    // getMe identifies the bot, not the human owner or an authorized chat.
    // Owner pairing establishes reminder destinations independently of token setup.
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
      serviceConnected: isConfiguredPollerConnected(runtime, token),
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
    let storedToken: string | null = null;
    setupService.updateConfig((config) => {
      const connectors = (config.connectors ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const tgConfig = connectors.telegram;
      if (tgConfig) {
        storedToken =
          typeof tgConfig.botToken === "string" ? tgConfig.botToken : null;
        delete tgConfig.botToken;
      }
    });
    if (storedToken && setupService.removeConnectorCredentialReference) {
      await setupService.removeConnectorCredentialReference(storedToken);
    }
  }
  await handleStatus(_req, res, runtime);
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
    handler: exclusiveSetup(handleStart),
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/setup/telegram/disconnect",
    handler: exclusiveSetup(handleDisconnect),
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/setup/telegram/cancel",
    handler: exclusiveSetup(handleCancel),
    rawPath: true,
  },
];
