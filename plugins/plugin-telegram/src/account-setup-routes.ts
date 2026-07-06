/**
 * Telegram account (user-account) auth HTTP routes.
 *
 * Implements the shared connector setup contract
 * (`eliza/packages/app-core/src/api/setup-contract.ts`) with one extra
 * connector-specific route for the two-step login flow used by the
 * `telegram` library (GramJS):
 *
 *   GET  /api/setup/telegram-account/status        current auth/connection status
 *   POST /api/setup/telegram-account/start         begin login (phone + optional app creds)
 *   POST /api/setup/telegram-account/submit-code   submit provisioning code, telegram code, or 2FA password
 *   POST /api/setup/telegram-account/cancel        tear down session + clear saved credentials
 *
 * The `submit-code` route is connector-specific. The contract requires
 * `status`/`start`/`cancel` but does not forbid additional routes under the
 * same `/api/setup/<connector>/...` prefix.
 *
 * These routes are registered with `rawPath: true` so they mount at the
 * canonical `/api/setup/telegram-account/*` paths without the plugin-name prefix.
 */

import type {
  IAgentRuntime,
  Route,
  RouteRequest,
  RouteResponse,
  SetupState,
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

function sendSetupError(
  res: RouteResponse,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ error: { code, message } });
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

interface TelegramAccountDetail {
  /**
   * Connector-internal flow status, retained verbatim so the UI can drive
   * its multi-step login wizard. Distinct from the canonical `state`.
   */
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
}

interface TelegramAccountStatusResponse {
  connector: "telegram-account";
  state: SetupState;
  detail: TelegramAccountDetail;
}

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

// Public Telegram Desktop app credentials (api_id 2040). api_id/api_hash
// identify the CLIENT APP, not the user, and grant no account access on their
// own — the minted StringSession is the real secret. Bundling a working default
// makes personal-account onboarding zero-friction: the user never has to visit
// my.telegram.org to register an app.
//
// Future option: instead of one shared bundled app, auto-fetch each user's OWN
// api_id/api_hash by repairing the my.telegram.org scraper
// (account-auth-service.ts getOrCreateProvisionedApp), whose HTML parser Telegram
// broke. That path is only reached when NO credentials resolve here — which,
// with this bundled default, is never — so it is documented, not wired.
const BUNDLED_TELEGRAM_APP_ID = 2040;
const BUNDLED_TELEGRAM_APP_HASH = "b18441a1ff607e10a989891a5462e627";

/**
 * Resolve the MTProto app credentials for the personal-account login, in
 * priority order: (1) per-account configured creds (power users / own app
 * identity), (2) deployment settings `TELEGRAM_APP_ID` / `TELEGRAM_APP_HASH`,
 * (3) the bundled default. Never returns null, so the fragile my.telegram.org
 * provisioning scrape is bypassed entirely. Exported for direct unit coverage
 * of the three-tier precedence.
 */
export function resolveTelegramAppCredentials(
  runtime: IAgentRuntime,
  connConfig: Record<string, unknown>,
): { apiId: number; apiHash: string } {
  if (
    (typeof connConfig.appId === "string" ||
      typeof connConfig.appId === "number") &&
    typeof connConfig.appHash === "string" &&
    connConfig.appHash.trim().length > 0
  ) {
    return {
      apiId: Number(connConfig.appId),
      apiHash: connConfig.appHash.trim(),
    };
  }
  const envId = runtime.getSetting("TELEGRAM_APP_ID");
  const envHash = runtime.getSetting("TELEGRAM_APP_HASH");
  const parsedEnvId =
    typeof envId === "string" || typeof envId === "number"
      ? Number(envId)
      : Number.NaN;
  if (
    Number.isInteger(parsedEnvId) &&
    parsedEnvId > 0 &&
    typeof envHash === "string" &&
    envHash.trim().length > 0
  ) {
    return { apiId: parsedEnvId, apiHash: envHash.trim() };
  }
  return {
    apiId: BUNDLED_TELEGRAM_APP_ID,
    apiHash: BUNDLED_TELEGRAM_APP_HASH,
  };
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

function setupStateFromFlow(
  flowStatus: string,
  configured: boolean,
  sessionExists: boolean,
  serviceConnected: boolean,
): SetupState {
  if (flowStatus === "error") return "error";
  if (serviceConnected || flowStatus === "connected") return "paired";
  if (
    flowStatus === "waiting_for_provisioning_code" ||
    flowStatus === "waiting_for_telegram_code" ||
    flowStatus === "waiting_for_password" ||
    configured ||
    sessionExists
  ) {
    return "configuring";
  }
  return "idle";
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

  let flowStatus =
    authSnapshot?.status ??
    (serviceConnected
      ? "connected"
      : configured || sessExists
        ? "configured"
        : "idle");

  if (serviceConnected && flowStatus === "configured") {
    flowStatus = "connected";
  }

  const state = setupStateFromFlow(
    flowStatus,
    configured,
    sessExists,
    serviceConnected,
  );

  return {
    connector: "telegram-account",
    state,
    detail: {
      status: flowStatus,
      configured,
      sessionExists: sessExists,
      serviceConnected,
      restartRequired: flowStatus === "configured" && !serviceConnected,
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
    },
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

async function handleStart(
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
    sendSetupError(
      res,
      400,
      "bad_request",
      "telegram phone number is required",
    );
    return;
  }

  await telegramAccountAuthSession?.stop();
  telegramAccountAuthSession = new TelegramAccountAuthSession(
    createSessionOptions(config),
  );

  const credentials = resolveTelegramAppCredentials(runtime, connectorConfig);

  try {
    await telegramAccountAuthSession.start({ phone, credentials });
    const resolved = telegramAccountAuthSession.getResolvedConnectorConfig();
    if (resolved && setupService) {
      setupService.updateConfig((cfg) => {
        Object.assign(ensureConnectorBlock(cfg), resolved);
      });
    }
    const freshConfig = setupService?.getConfig() ?? config;
    res.status(200).json(statusFromState(runtime, freshConfig));
  } catch (err) {
    sendSetupError(
      res,
      500,
      "internal_error",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function handleSubmitCode(
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

  if (!ensureAuthSession(config) || !telegramAccountAuthSession) {
    sendSetupError(
      res,
      400,
      "bad_request",
      "telegram login session has not been started",
    );
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
  } catch (err) {
    sendSetupError(
      res,
      500,
      "internal_error",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function handleCancel(
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
  res.status(200).json(statusFromState(runtime, config));
}

// ── Exported route definitions ─────────────────────────────────────────

/**
 * Plugin routes for Telegram account (user-account) auth.
 * Registered with `rawPath: true` to expose the canonical
 * `/api/setup/telegram-account/*` surface without the plugin-name prefix.
 */
export const telegramAccountRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/setup/telegram-account/status",
    handler: handleStatus,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/setup/telegram-account/start",
    handler: handleStart,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/setup/telegram-account/submit-code",
    handler: handleSubmitCode,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/setup/telegram-account/cancel",
    handler: handleCancel,
    rawPath: true,
  },
];
