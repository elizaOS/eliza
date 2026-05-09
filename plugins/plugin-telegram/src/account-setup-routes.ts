/**
 * Telegram account (user-account) auth HTTP routes.
 *
 * Provides a multi-step login flow for linking a personal Telegram account
 * (as opposed to a bot token) using the `telegram` library (GramJS):
 *
 *   GET  /api/telegram-account/status        current auth/connection status
 *   POST /api/telegram-account/auth/start    begin login (phone + optional app creds)
 *   POST /api/telegram-account/auth/submit   submit provisioning code, telegram code, or 2FA password
 *   POST /api/telegram-account/disconnect    tear down session + clear saved credentials
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
import {
  clearTelegramAccountAuthState,
  clearTelegramAccountSession,
  defaultTelegramAccountDeviceModel,
  defaultTelegramAccountSystemVersion,
  TelegramAccountAuthSession,
  type TelegramAccountAuthSessionLike,
  type TelegramAccountAuthSnapshot,
  telegramAccountAuthStateExists,
  telegramAccountSessionExists,
} from "./account-auth-service.js";

// ── Connector-setup service interface ──────────────────────────────────

interface ConnectorSetupService {
  getConfig(): Record<string, unknown>;
  persistConfig(config: Record<string, unknown>): void;
  updateConfig(updater: (config: Record<string, unknown>) => void): void;
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
    typeof candidate.persistConfig === "function"
  );
}

function getSetupService(runtime: IAgentRuntime): ConnectorSetupService | null {
  const service = runtime.getService("connector-setup");
  return isConnectorSetupService(service) ? service : null;
}

// ── Module-level auth session state ────────────────────────────────────

let telegramAccountAuthSession: TelegramAccountAuthSessionLike | null = null;

/** Called on plugin shutdown to clean up the auth session. */
export async function stopTelegramAccountAuthSession(): Promise<void> {
  if (telegramAccountAuthSession) {
    try {
      await telegramAccountAuthSession.stop();
    } catch {
      /* non-fatal */
    }
    telegramAccountAuthSession = null;
  }
}

// ── Types ──────────────────────────────────────────────────────────────

type TelegramAccountRuntimeServiceLike = {
  isConnected?: () => boolean;
  getAccountSummary?: () => {
    id: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
  } | null;
  stop?: () => Promise<void>;
};

type TelegramAccountStatusResponse = {
  available: true;
  status: string;
  configured: boolean;
  sessionExists: boolean;
  serviceConnected: boolean;
  restartRequired: boolean;
  hasAppCredentials: boolean;
  phone: string | null;
  isCodeViaApp: boolean;
  account: TelegramAccountAuthSnapshot["account"];
  error: string | null;
};

// ── Config helpers ─────────────────────────────────────────────────────

function readConnectorConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const connectors = config.connectors as
    | Record<string, Record<string, unknown>>
    | undefined;
  const raw = connectors?.telegramAccount;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw;
}

function hasConfiguredTelegramAccount(
  connConfig: Record<string, unknown>,
): boolean {
  return Boolean(
    typeof connConfig.phone === "string" &&
      connConfig.phone.trim() &&
      (typeof connConfig.appId === "string" ||
        typeof connConfig.appId === "number") &&
      typeof connConfig.appHash === "string" &&
      connConfig.appHash.trim() &&
      typeof connConfig.deviceModel === "string" &&
      connConfig.deviceModel.trim() &&
      typeof connConfig.systemVersion === "string" &&
      connConfig.systemVersion.trim() &&
      connConfig.enabled !== false,
  );
}

function resolveConfiguredPhone(
  runtime: IAgentRuntime,
  connConfig: Record<string, unknown>,
): string | null {
  if (
    typeof connConfig.phone === "string" &&
    connConfig.phone.trim().length > 0
  ) {
    return connConfig.phone.trim();
  }
  const setting = runtime.getSetting("TELEGRAM_ACCOUNT_PHONE");
  return typeof setting === "string" && setting.trim().length > 0
    ? setting.trim()
    : null;
}

function resolveService(
  runtime: IAgentRuntime,
): TelegramAccountRuntimeServiceLike | null {
  const service = runtime.getService("telegram-account");
  return (
    (service as TelegramAccountRuntimeServiceLike | null | undefined) ?? null
  );
}

function isServiceConnected(
  service: TelegramAccountRuntimeServiceLike | null,
): boolean {
  if (!service) {
    return false;
  }
  if (typeof service.isConnected === "function") {
    return service.isConnected();
  }
  const withFlags = service as TelegramAccountRuntimeServiceLike & {
    connected?: unknown;
    isServiceConnected?: () => boolean;
  };
  if (typeof withFlags.isServiceConnected === "function") {
    return withFlags.isServiceConnected();
  }
  return withFlags.connected === true;
}

function statusFromState(
  runtime: IAgentRuntime,
  config: Record<string, unknown>,
): TelegramAccountStatusResponse {
  const connectorConfig = readConnectorConfig(config);
  const configured = hasConfiguredTelegramAccount(connectorConfig);
  const sessExists = telegramAccountSessionExists();
  const authSnapshot = telegramAccountAuthSession?.getSnapshot() ?? null;
  const service = resolveService(runtime);
  const serviceConnected = isServiceConnected(service);
  const serviceAccount =
    typeof service?.getAccountSummary === "function"
      ? service.getAccountSummary()
      : null;
  const fallbackPhone = resolveConfiguredPhone(runtime, connectorConfig);

  let status =
    authSnapshot?.status ??
    (serviceConnected
      ? "connected"
      : configured || sessExists
        ? "configured"
        : "idle");

  if (serviceConnected && status === "configured") {
    status = "connected";
  }

  return {
    available: true,
    status,
    configured,
    sessionExists: sessExists,
    serviceConnected,
    restartRequired: status === "configured" && !serviceConnected,
    hasAppCredentials: Boolean(
      (typeof connectorConfig.appId === "string" ||
        typeof connectorConfig.appId === "number") &&
        typeof connectorConfig.appHash === "string" &&
        connectorConfig.appHash.trim().length > 0,
    ),
    phone: authSnapshot?.phone ?? fallbackPhone,
    isCodeViaApp: authSnapshot?.isCodeViaApp ?? false,
    account: authSnapshot?.account ?? serviceAccount ?? null,
    error: authSnapshot?.error ?? null,
  };
}

function ensureConnectorBlock(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!config.connectors) {
    config.connectors = {};
  }
  const connectors = config.connectors as Record<
    string,
    Record<string, unknown>
  >;
  if (
    !connectors.telegramAccount ||
    typeof connectors.telegramAccount !== "object" ||
    Array.isArray(connectors.telegramAccount)
  ) {
    connectors.telegramAccount = {};
  }
  return connectors.telegramAccount;
}

function createSessionOptions(config: Record<string, unknown>): {
  deviceModel?: string;
  systemVersion?: string;
} {
  const connectorConfig = readConnectorConfig(config);
  return {
    deviceModel:
      typeof connectorConfig.deviceModel === "string" &&
      connectorConfig.deviceModel.trim().length > 0
        ? connectorConfig.deviceModel.trim()
        : defaultTelegramAccountDeviceModel(),
    systemVersion:
      typeof connectorConfig.systemVersion === "string" &&
      connectorConfig.systemVersion.trim().length > 0
        ? connectorConfig.systemVersion.trim()
        : defaultTelegramAccountSystemVersion(),
  };
}

function ensureAuthSession(
  config: Record<string, unknown>,
): TelegramAccountAuthSessionLike | null {
  if (telegramAccountAuthSession) {
    return telegramAccountAuthSession;
  }
  if (!telegramAccountAuthStateExists()) {
    return null;
  }
  telegramAccountAuthSession = new TelegramAccountAuthSession(
    createSessionOptions(config),
  );
  return telegramAccountAuthSession;
}

// ── Route handlers ─────────────────────────────────────────────────────

async function handleStatus(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const setupService = getSetupService(runtime);
  const config = setupService?.getConfig() ?? {};
  ensureAuthSession(config);
  res.status(200).json(statusFromState(runtime, config));
}

async function handleAuthStart(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const body = (req.body ?? {}) as { phone?: string };
  const setupService = getSetupService(runtime);
  const config = setupService?.getConfig() ?? {};
  const connectorConfig = readConnectorConfig(config);

  const phone =
    (typeof body.phone === "string" && body.phone.trim()) ||
    resolveConfiguredPhone(runtime, connectorConfig);
  if (!phone) {
    res.status(400).json({ error: "telegram phone number is required" });
    return;
  }

  await telegramAccountAuthSession?.stop();
  telegramAccountAuthSession = new TelegramAccountAuthSession(
    createSessionOptions(config),
  );

  const credentials =
    hasConfiguredTelegramAccount(connectorConfig) &&
    (typeof connectorConfig.appId === "string" ||
      typeof connectorConfig.appId === "number") &&
    typeof connectorConfig.appHash === "string"
      ? {
          apiId: Number(connectorConfig.appId),
          apiHash: connectorConfig.appHash,
        }
      : null;

  try {
    await telegramAccountAuthSession.start({ phone, credentials });
    const resolved = telegramAccountAuthSession.getResolvedConnectorConfig();
    if (resolved && setupService) {
      setupService.updateConfig((cfg) => {
        Object.assign(ensureConnectorBlock(cfg), resolved);
      });
    }
    // Re-read config after potential update
    const freshConfig = setupService?.getConfig() ?? config;
    res.status(200).json(statusFromState(runtime, freshConfig));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleAuthSubmit(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const body = (req.body ?? {}) as {
    provisioningCode?: string;
    telegramCode?: string;
    password?: string;
  };
  const setupService = getSetupService(runtime);
  const config = setupService?.getConfig() ?? {};

  if (!ensureAuthSession(config)) {
    res
      .status(400)
      .json({ error: "telegram login session has not been started" });
    return;
  }
  if (!telegramAccountAuthSession) {
    res
      .status(400)
      .json({ error: "telegram login session has not been started" });
    return;
  }

  try {
    await telegramAccountAuthSession.submit(body);
    const resolved = telegramAccountAuthSession.getResolvedConnectorConfig();
    if (resolved && setupService) {
      setupService.updateConfig((cfg) => {
        Object.assign(ensureConnectorBlock(cfg), resolved);
      });
    }
    const freshConfig = setupService?.getConfig() ?? config;
    res.status(200).json(statusFromState(runtime, freshConfig));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleDisconnect(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  await telegramAccountAuthSession?.stop();
  telegramAccountAuthSession = null;
  clearTelegramAccountAuthState();
  clearTelegramAccountSession();

  const service = resolveService(runtime);
  if (typeof service?.stop === "function") {
    await service.stop();
  }

  const setupService = getSetupService(runtime);
  if (setupService) {
    setupService.updateConfig((cfg) => {
      const connectors = cfg.connectors as Record<string, unknown> | undefined;
      if (connectors?.telegramAccount) {
        delete connectors.telegramAccount;
      }
    });
  }

  const config = setupService?.getConfig() ?? {};
  res.status(200).json({
    ok: true,
    ...statusFromState(runtime, config),
  });
}

// ── Exported route definitions ─────────────────────────────────────────

/**
 * Plugin routes for Telegram account (user-account) auth.
 * Registered with `rawPath: true` to preserve legacy `/api/telegram-account/*` paths.
 */
export const telegramAccountRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/telegram-account/status",
    handler: handleStatus,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/telegram-account/auth/start",
    handler: handleAuthStart,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/telegram-account/auth/submit",
    handler: handleAuthSubmit,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/telegram-account/disconnect",
    handler: handleDisconnect,
    rawPath: true,
  },
];
