/**
 * Signal connector setup HTTP routes.
 *
 * Implements the shared setup contract defined in
 * `@elizaos/app-core/api/setup-contract.ts`:
 *
 *   GET  /api/setup/signal/status   check current connection / pairing state
 *   POST /api/setup/signal/start    start (or restart) a QR device-linking session
 *   POST /api/setup/signal/cancel   stop active pairing and disconnect Signal
 *
 * The underlying QR pairing logic is unchanged from the legacy
 * `/api/signal/*` routes — only the path layout, the canonical response
 * envelope, and the structured error shape have been normalized.
 *
 * Cancel folds the old "stop pairing in progress" and "disconnect already
 * paired Signal" cases into a single endpoint: it stops any in-flight
 * session and wipes auth on disk in one call.
 *
 * These routes are registered with `rawPath: true` so they mount at their
 * canonical paths without the plugin-name prefix.
 */

import path from "node:path";
import type { IAgentRuntime, Route, RouteRequest, RouteResponse } from "@elizaos/core";
import {
  type SignalPairingEvent,
  SignalPairingSession,
  type SignalPairingSnapshot,
  type SignalPairingStatus,
  sanitizeAccountId,
  signalAuthExists,
  signalLogout,
} from "./pairing-service";

// ── Setup contract types (mirror @elizaos/app-core/api/setup-contract) ──

type SetupState = "idle" | "configuring" | "paired" | "error";

interface SetupStatusResponse<TDetail = unknown> {
  connector: string;
  state: SetupState;
  detail?: TDetail;
}

interface SetupErrorResponse {
  error: { code: string; message: string };
}

function setupError(code: string, message: string): SetupErrorResponse {
  return { error: { code, message } };
}

// ── Module-level state ──────────────────────────────────────────────────
// These maps survive across requests within the same process lifetime,
// mirroring how they were held on ServerState in the monolithic server.

interface SignalPairingSessionLike {
  start(): Promise<void>;
  stop(): void;
  getStatus(): SignalPairingStatus;
  getSnapshot(): SignalPairingSnapshot;
}

const signalPairingSessions = new Map<string, SignalPairingSessionLike>();
const signalPairingSnapshots = new Map<string, SignalPairingSnapshot>();

export const MAX_PAIRING_SESSIONS = 10;
const TERMINAL_SIGNAL_PAIRING_STATUSES = new Set<SignalPairingStatus>([
  "connected",
  "disconnected",
  "timeout",
  "error",
]);

// ── Connector setup service interface ───────────────────────────────────

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
  getWorkspaceDir(): string;
  broadcastWs(data: object): void;
}

function isConnectorSetupService(service: unknown): service is ConnectorSetupService {
  if (!service || typeof service !== "object") {
    return false;
  }
  const candidate = service as Partial<ConnectorSetupService>;
  return (
    typeof candidate.getConfig === "function" &&
    typeof candidate.updateConfig === "function" &&
    typeof candidate.persistConfig === "function" &&
    typeof candidate.registerEscalationChannel === "function" &&
    typeof candidate.setOwnerContact === "function" &&
    typeof candidate.getWorkspaceDir === "function" &&
    typeof candidate.broadcastWs === "function"
  );
}

function getSetupService(runtime: IAgentRuntime): ConnectorSetupService | null {
  const service = runtime.getService("connector-setup");
  return isConnectorSetupService(service) ? service : null;
}

// ── Helpers ─────────────────────────────────────────────────────────────

interface SignalSetupDetail {
  accountId: string;
  pairingStatus: SignalPairingStatus | "idle";
  authExists: boolean;
  serviceConnected: boolean;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  pairingError: string | null;
}

function buildSignalStatusResponse(
  accountId: string,
  session: SignalPairingSessionLike | undefined,
  previousSnapshot: SignalPairingSnapshot | undefined,
  authExists: boolean,
  serviceConnected: boolean
): SetupStatusResponse<SignalSetupDetail> {
  const snapshot = session?.getSnapshot() ?? previousSnapshot;
  const pairingStatus = snapshot?.status ?? (authExists || serviceConnected ? "connected" : "idle");

  const state: SetupState =
    pairingStatus === "connected"
      ? "paired"
      : pairingStatus === "error" || pairingStatus === "timeout"
        ? "error"
        : pairingStatus === "idle" || pairingStatus === "disconnected"
          ? "idle"
          : "configuring";

  return {
    connector: "signal",
    state,
    detail: {
      accountId,
      pairingStatus,
      authExists,
      serviceConnected,
      qrDataUrl: snapshot?.qrDataUrl ?? null,
      phoneNumber: snapshot?.phoneNumber ?? null,
      pairingError: snapshot?.error ?? null,
    },
  };
}

/** Reap terminal pairing sessions before handling a request. */
function reapTerminalSessions(): void {
  for (const [id, session] of signalPairingSessions) {
    const status = session.getStatus();
    if (status === "disconnected" || status === "timeout" || status === "error") {
      signalPairingSnapshots.set(id, session.getSnapshot());
      session.stop();
      signalPairingSessions.delete(id);
    }
  }
}

function resolveServiceConnected(runtime: IAgentRuntime): boolean {
  const sigService = runtime.getService("signal") as {
    connected?: unknown;
    isConnected?: unknown;
    isServiceConnected?: () => boolean;
  } | null;
  if (!sigService) return false;
  return (
    Boolean(sigService.connected) ||
    Boolean(sigService.isConnected) ||
    (typeof sigService.isServiceConnected === "function" &&
      Boolean((sigService.isServiceConnected as () => boolean)()))
  );
}

function extractAccountId(value: unknown): string {
  return sanitizeAccountId(typeof value === "string" && value.trim() ? value.trim() : "default");
}

// ── GET /api/setup/signal/status ────────────────────────────────────────

async function handleStatus(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  reapTerminalSessions();

  const rawUrl = typeof req.url === "string" ? req.url : "/";
  const url = new URL(rawUrl, "http://localhost");
  let accountId: string;
  try {
    accountId = extractAccountId(url.searchParams.get("accountId"));
  } catch (err) {
    res.status(400).json(setupError("bad_request", (err as Error).message));
    return;
  }

  const setupService = getSetupService(runtime);
  const workspaceDir = setupService?.getWorkspaceDir() ?? "";

  const session = signalPairingSessions.get(accountId);
  const previousSnapshot = signalPairingSnapshots.get(accountId);
  const authExists = signalAuthExists(workspaceDir, accountId);
  const serviceConnected = resolveServiceConnected(runtime);

  res
    .status(200)
    .json(
      buildSignalStatusResponse(accountId, session, previousSnapshot, authExists, serviceConnected)
    );
}

// ── POST /api/setup/signal/start ────────────────────────────────────────

async function handleStart(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  reapTerminalSessions();

  const body = (req.body ?? {}) as { accountId?: string };
  let accountId: string;
  try {
    accountId = extractAccountId(body.accountId);
  } catch (err) {
    res.status(400).json(setupError("bad_request", (err as Error).message));
    return;
  }

  const isReplacing = signalPairingSessions.has(accountId);
  if (!isReplacing && signalPairingSessions.size >= MAX_PAIRING_SESSIONS) {
    res
      .status(429)
      .json(
        setupError(
          "too_many_sessions",
          `Too many concurrent pairing sessions (max ${MAX_PAIRING_SESSIONS})`
        )
      );
    return;
  }

  const setupService = getSetupService(runtime);
  const workspaceDir = setupService?.getWorkspaceDir() ?? "";
  const config = setupService?.getConfig() ?? {};
  const connectors = (config.connectors ?? {}) as Record<string, unknown>;

  const authDir = path.join(workspaceDir, "signal-auth", accountId);
  signalPairingSessions.get(accountId)?.stop();
  signalPairingSnapshots.delete(accountId);

  const signalConfig = (connectors.signal as Record<string, unknown> | undefined) ?? {};
  const configuredCliPath =
    typeof signalConfig.cliPath === "string" && signalConfig.cliPath.trim()
      ? signalConfig.cliPath.trim()
      : undefined;

  let session: SignalPairingSessionLike;
  session = new SignalPairingSession({
    authDir,
    accountId,
    cliPath: configuredCliPath,
    onEvent: (event: SignalPairingEvent) => {
      setupService?.broadcastWs(event);
      signalPairingSnapshots.set(accountId, session.getSnapshot());

      if (event.status === "connected") {
        const phoneNumber = event.phoneNumber;

        if (setupService) {
          setupService.updateConfig((cfg) => {
            if (!cfg.connectors) cfg.connectors = {};
            const cfgConnectors = cfg.connectors as Record<string, unknown>;
            const previousConfig =
              (cfgConnectors.signal as Record<string, unknown> | undefined) ?? {};
            if (accountId !== "default") {
              const accounts =
                typeof previousConfig.accounts === "object" && previousConfig.accounts !== null
                  ? { ...(previousConfig.accounts as Record<string, Record<string, unknown>>) }
                  : {};
              accounts[accountId] = {
                ...(accounts[accountId] ?? {}),
                authDir,
                enabled: true,
                ...(phoneNumber && phoneNumber.trim().length > 0
                  ? { account: phoneNumber.trim() }
                  : {}),
              };
              cfgConnectors.signal = {
                ...previousConfig,
                accounts,
                enabled: true,
              };
              return;
            }
            cfgConnectors.signal = {
              ...previousConfig,
              authDir,
              enabled: true,
              ...(phoneNumber && phoneNumber.trim().length > 0
                ? { account: phoneNumber.trim() }
                : {}),
            };
          });

          // Auto-populate owner contact so LifeOps can deliver reminders
          setupService.setOwnerContact({
            source: "signal",
            channelId: phoneNumber ?? undefined,
          });
          // Add Signal to the escalation channel list
          setupService.registerEscalationChannel("signal");
        }
      }

      if (
        event.status &&
        TERMINAL_SIGNAL_PAIRING_STATUSES.has(event.status) &&
        signalPairingSessions.get(accountId) === session
      ) {
        signalPairingSessions.delete(accountId);
      }
    },
  });

  signalPairingSessions.set(accountId, session);
  signalPairingSnapshots.set(accountId, session.getSnapshot());

  void session.start().catch((err) => {
    console.error(`[signal] Pairing session failed for ${accountId}:`, String(err));
    signalPairingSnapshots.set(accountId, session.getSnapshot());
    signalPairingSessions.delete(accountId);
  });

  res
    .status(200)
    .json(
      buildSignalStatusResponse(
        accountId,
        session,
        signalPairingSnapshots.get(accountId),
        false,
        false
      )
    );
}

// ── POST /api/setup/signal/cancel ───────────────────────────────────────

async function handleCancel(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const body = (req.body ?? {}) as { accountId?: string };
  let accountId: string;
  try {
    accountId = extractAccountId(body.accountId);
  } catch (err) {
    res.status(400).json(setupError("bad_request", (err as Error).message));
    return;
  }

  const session = signalPairingSessions.get(accountId);
  if (session) {
    session.stop();
    signalPairingSessions.delete(accountId);
  }
  signalPairingSnapshots.delete(accountId);

  const setupService = getSetupService(runtime);
  const workspaceDir = setupService?.getWorkspaceDir() ?? "";

  try {
    signalLogout(workspaceDir, accountId);
  } catch (err) {
    res
      .status(500)
      .json(
        setupError(
          "internal_error",
          `Failed to disconnect Signal: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    return;
  }

  if (setupService) {
    try {
      setupService.updateConfig((cfg) => {
        const connectors = (cfg.connectors ?? {}) as Record<string, unknown>;
        if (accountId === "default") {
          delete connectors.signal;
          return;
        }
        const signalConfig = connectors.signal as Record<string, unknown> | undefined;
        const accounts = signalConfig?.accounts as Record<string, unknown> | undefined;
        if (accounts) {
          delete accounts[accountId];
        }
        connectors.signal = {
          ...(signalConfig ?? {}),
          ...(accounts ? { accounts } : {}),
        };
      });
    } catch (error) {
      res
        .status(500)
        .json(
          setupError(
            "internal_error",
            `Failed to persist Signal disconnect: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      return;
    }
  }

  res.status(200).json({
    connector: "signal",
    state: "idle",
    detail: { accountId },
  } satisfies SetupStatusResponse<{ accountId: string }>);
}

// ── Exported route definitions ──────────────────────────────────────────

/**
 * Plugin routes for Signal device-linking setup.
 * Registered with `rawPath: true` to mount at the canonical
 * `/api/setup/signal/*` paths without the plugin-name prefix.
 */
export const signalSetupRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/setup/signal/status",
    handler: handleStatus,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/setup/signal/start",
    handler: handleStart,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/setup/signal/cancel",
    handler: handleCancel,
    rawPath: true,
  },
];

/**
 * Override plugin-discovery status for Signal when QR-paired auth exists.
 * Exported so the agent can still use it during plugin discovery if needed.
 */
export function applySignalQrOverride(
  plugins: {
    id: string;
    validationErrors: unknown[];
    configured: boolean;
    qrConnected?: boolean;
  }[],
  workspaceDir: string
): void {
  if (signalAuthExists(workspaceDir, "default")) {
    const sigPlugin = plugins.find((plugin) => plugin.id === "signal");
    if (sigPlugin) {
      sigPlugin.validationErrors = [];
      sigPlugin.configured = true;
      sigPlugin.qrConnected = true;
    }
  }
}
