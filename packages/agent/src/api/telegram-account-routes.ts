import type http from "node:http";
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
} from "../services/telegram-account-auth.js";
import type { RouteHelpers } from "@elizaos/shared";

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

export interface TelegramAccountRouteState {
  config: Record<string, unknown> & {
    connectors?: Record<string, Record<string, unknown>>;
  };
  saveConfig: () => void;
  runtime?: {
    getService(type: string): unknown;
    getSetting(key: string): string | undefined;
  };
  telegramAccountAuthSession?: TelegramAccountAuthSessionLike | null;
}

export interface TelegramAccountRouteDeps {
  createAuthSession: (options: {
    deviceModel?: string;
    systemVersion?: string;
  }) => TelegramAccountAuthSessionLike;
  authStateExists: () => boolean;
  sessionExists: () => boolean;
  clearAuthState: () => void;
  clearSession: () => void;
}

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

const MAX_BODY_BYTES = 16_384;

function readConnectorConfig(
  state: TelegramAccountRouteState,
): Record<string, unknown> {
  const connectors = state.config.connectors;
  const raw = connectors?.telegramAccount;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw;
}

function hasConfiguredTelegramAccount(
  config: Record<string, unknown>,
): boolean {
  return Boolean(
    typeof config.phone === "string" &&
      config.phone.trim() &&
      (typeof config.appId === "string" || typeof config.appId === "number") &&
      typeof config.appHash === "string" &&
      config.appHash.trim() &&
      typeof config.deviceModel === "string" &&
      config.deviceModel.trim() &&
      typeof config.systemVersion === "string" &&
      config.systemVersion.trim() &&
      config.enabled !== false,
  );
}

function resolveConfiguredPhone(
  state: TelegramAccountRouteState,
  config: Record<string, unknown>,
): string | null {
  if (typeof config.phone === "string" && config.phone.trim().length > 0) {
    return config.phone.trim();
  }
  const setting = state.runtime?.getSetting("TELEGRAM_ACCOUNT_PHONE");
  return typeof setting === "string" && setting.trim().length > 0
    ? setting.trim()
    : null;
}

function resolveService(
  state: TelegramAccountRouteState,
): TelegramAccountRuntimeServiceLike | null {
  if (!state.runtime) {
    return null;
  }
  const service = state.runtime.getService("telegram-account");
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
  state: TelegramAccountRouteState,
  deps: TelegramAccountRouteDeps,
): TelegramAccountStatusResponse {
  const connectorConfig = readConnectorConfig(state);
  const configured = hasConfiguredTelegramAccount(connectorConfig);
  const sessionExists = deps.sessionExists();
  const authSnapshot = state.telegramAccountAuthSession?.getSnapshot() ?? null;
  const service = resolveService(state);
  const serviceConnected = isServiceConnected(service);
  const serviceAccount =
    typeof service?.getAccountSummary === "function"
      ? service.getAccountSummary()
      : null;
  const fallbackPhone = resolveConfiguredPhone(state, connectorConfig);

  let status =
    authSnapshot?.status ??
    (serviceConnected
      ? "connected"
      : configured || sessionExists
        ? "configured"
        : "idle");

  if (serviceConnected && status === "configured") {
    status = "connected";
  }

  return {
    available: true,
    status,
    configured,
    sessionExists,
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
  state: TelegramAccountRouteState,
): Record<string, unknown> {
  if (!state.config.connectors) {
    state.config.connectors = {};
  }
  const connectors = state.config.connectors;
  if (
    !connectors.telegramAccount ||
    typeof connectors.telegramAccount !== "object" ||
    Array.isArray(connectors.telegramAccount)
  ) {
    connectors.telegramAccount = {};
  }
  return connectors.telegramAccount;
}

function createSessionOptions(state: TelegramAccountRouteState): {
  deviceModel?: string;
  systemVersion?: string;
} {
  const connectorConfig = readConnectorConfig(state);
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
  state: TelegramAccountRouteState,
  deps: TelegramAccountRouteDeps,
): TelegramAccountAuthSessionLike | null {
  if (state.telegramAccountAuthSession) {
    return state.telegramAccountAuthSession;
  }
  if (!deps.authStateExists()) {
    return null;
  }
  state.telegramAccountAuthSession = deps.createAuthSession(
    createSessionOptions(state),
  );
  return state.telegramAccountAuthSession;
}

export async function handleTelegramAccountRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: TelegramAccountRouteState,
  helpers: RouteHelpers,
  deps: TelegramAccountRouteDeps = {
    createAuthSession: (options) => new TelegramAccountAuthSession(options),
    authStateExists: telegramAccountAuthStateExists,
    sessionExists: telegramAccountSessionExists,
    clearAuthState: clearTelegramAccountAuthState,
    clearSession: clearTelegramAccountSession,
  },
): Promise<boolean> {
  if (!pathname.startsWith("/api/telegram-account")) {
    return false;
  }

  if (method === "GET" && pathname === "/api/telegram-account/status") {
    ensureAuthSession(state, deps);
    helpers.json(res, statusFromState(state, deps));
    return true;
  }

  if (method === "POST" && pathname === "/api/telegram-account/auth/start") {
    const body = await helpers.readJsonBody<{ phone?: string }>(req, res, {
      maxBytes: MAX_BODY_BYTES,
    });
    if (!body) {
      return true;
    }

    const connectorConfig = readConnectorConfig(state);
    const phone =
      (typeof body.phone === "string" && body.phone.trim()) ||
      resolveConfiguredPhone(state, connectorConfig);
    if (!phone) {
      helpers.error(res, "telegram phone number is required", 400);
      return true;
    }

    await state.telegramAccountAuthSession?.stop();
    state.telegramAccountAuthSession = deps.createAuthSession(
      createSessionOptions(state),
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
      await state.telegramAccountAuthSession.start({ phone, credentials });
      const resolved =
        state.telegramAccountAuthSession.getResolvedConnectorConfig();
      if (resolved) {
        Object.assign(ensureConnectorBlock(state), resolved);
        state.saveConfig();
      }
      helpers.json(res, statusFromState(state, deps));
    } catch (error) {
      helpers.error(
        res,
        error instanceof Error ? error.message : String(error),
        500,
      );
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/telegram-account/auth/submit") {
    const body = await helpers.readJsonBody<{
      provisioningCode?: string;
      telegramCode?: string;
      password?: string;
    }>(req, res, {
      maxBytes: MAX_BODY_BYTES,
    });
    if (!body) {
      return true;
    }
    if (!ensureAuthSession(state, deps)) {
      helpers.error(res, "telegram login session has not been started", 400);
      return true;
    }
    const authSession = state.telegramAccountAuthSession;
    if (!authSession) {
      helpers.error(res, "telegram login session has not been started", 400);
      return true;
    }

    try {
      await authSession.submit(body);
      const resolved = authSession.getResolvedConnectorConfig();
      if (resolved) {
        Object.assign(ensureConnectorBlock(state), resolved);
        state.saveConfig();
      }
      helpers.json(res, statusFromState(state, deps));
    } catch (error) {
      helpers.error(
        res,
        error instanceof Error ? error.message : String(error),
        500,
      );
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/telegram-account/disconnect") {
    await state.telegramAccountAuthSession?.stop();
    state.telegramAccountAuthSession = null;
    deps.clearAuthState();
    deps.clearSession();
    const service = resolveService(state);
    if (typeof service?.stop === "function") {
      await service.stop();
    }

    const connectors = state.config.connectors;
    if (connectors?.telegramAccount) {
      delete connectors.telegramAccount;
      state.saveConfig();
    }

    helpers.json(res, {
      ok: true,
      ...statusFromState(state, deps),
    });
    return true;
  }

  return false;
}
