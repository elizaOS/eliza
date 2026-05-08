/**
 * Signal connector setup HTTP routes.
 *
 * Provides QR-code pairing and disconnect flows for Signal:
 *
 *   POST /api/signal/pair          start a device-linking session
 *   GET  /api/signal/status        check current connection / pairing state
 *   POST /api/signal/pair/stop     stop an active pairing session
 *   POST /api/signal/disconnect    disconnect + wipe auth data
 *
 * These routes are registered with `rawPath: true` so they mount at their
 * legacy paths without the plugin-name prefix.
 */

import path from "node:path";
import type { IAgentRuntime, Route, RouteRequest, RouteResponse } from "@elizaos/core";
import {
  SignalPairingSession,
  type SignalPairingSnapshot,
  type SignalPairingStatus,
  sanitizeAccountId,
  signalAuthExists,
  signalLogout,
} from "./pairing-service";

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

function getSetupService(runtime: IAgentRuntime): ConnectorSetupService | null {
  return runtime.getService("connector-setup") as ConnectorSetupService | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function resolveSignalStatusResponse(
  accountId: string,
  session: SignalPairingSessionLike | undefined,
  previousSnapshot: SignalPairingSnapshot | undefined,
  authExists: boolean,
  serviceConnected: boolean
) {
  const snapshot = session?.getSnapshot() ?? previousSnapshot;
  const status = snapshot?.status ?? (authExists || serviceConnected ? "connected" : "idle");

  return {
    accountId,
    status,
    authExists,
    serviceConnected,
    qrDataUrl: snapshot?.qrDataUrl ?? null,
    phoneNumber: snapshot?.phoneNumber ?? null,
    error: snapshot?.error ?? null,
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

// ── POST /api/signal/pair ───────────────────────────────────────────────

async function handlePair(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  reapTerminalSessions();

  const body = (req.body ?? {}) as { accountId?: string };
  let accountId: string;
  try {
    accountId = sanitizeAccountId(
      typeof body.accountId === "string" && body.accountId.trim()
        ? body.accountId.trim()
        : "default"
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  const isReplacing = signalPairingSessions.has(accountId);
  if (!isReplacing && signalPairingSessions.size >= MAX_PAIRING_SESSIONS) {
    res.status(429).json({
      error: `Too many concurrent pairing sessions (max ${MAX_PAIRING_SESSIONS})`,
    });
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
    onEvent: (event) => {
      setupService?.broadcastWs(event);
      signalPairingSnapshots.set(accountId, session.getSnapshot());

      if (event.status === "connected") {
        const phoneNumber = (event as unknown as Record<string, unknown>).phoneNumber as
          | string
          | undefined;

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

  res.status(200).json({
    ok: true,
    ...resolveSignalStatusResponse(
      accountId,
      session,
      signalPairingSnapshots.get(accountId),
      false,
      false
    ),
  });
}

// ── GET /api/signal/status ──────────────────────────────────────────────

async function handleStatus(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  reapTerminalSessions();

  // Extract accountId from query string
  const rawUrl =
    typeof (req as unknown as { url?: string }).url === "string"
      ? (req as unknown as { url: string }).url
      : "/";
  const url = new URL(rawUrl, "http://localhost");
  let accountId: string;
  try {
    accountId = sanitizeAccountId(url.searchParams.get("accountId") || "default");
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  const setupService = getSetupService(runtime);
  const workspaceDir = setupService?.getWorkspaceDir() ?? "";

  const session = signalPairingSessions.get(accountId);
  const previousSnapshot = signalPairingSnapshots.get(accountId);
  const authExists = signalAuthExists(workspaceDir, accountId);

  let serviceConnected = false;
  try {
    const sigService = runtime.getService("signal") as Record<string, unknown> | null;
    if (sigService) {
      serviceConnected =
        Boolean(sigService.connected) ||
        Boolean(sigService.isConnected) ||
        (typeof sigService.isServiceConnected === "function" &&
          Boolean((sigService.isServiceConnected as () => boolean)()));
    }
  } catch {
    /* service not yet registered */
  }

  res
    .status(200)
    .json(
      resolveSignalStatusResponse(
        accountId,
        session,
        previousSnapshot,
        authExists,
        serviceConnected
      )
    );
}

// ── POST /api/signal/pair/stop ──────────────────────────────────────────

async function handlePairStop(
  req: RouteRequest,
  res: RouteResponse,
  _runtime: IAgentRuntime
): Promise<void> {
  const body = (req.body ?? {}) as { accountId?: string };
  let accountId: string;
  try {
    accountId = sanitizeAccountId(
      typeof body.accountId === "string" && body.accountId.trim()
        ? body.accountId.trim()
        : "default"
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  const session = signalPairingSessions.get(accountId);
  if (session) {
    session.stop();
    signalPairingSessions.delete(accountId);
  }
  signalPairingSnapshots.delete(accountId);

  res.status(200).json({ ok: true, accountId, status: "idle" });
}

// ── POST /api/signal/disconnect ─────────────────────────────────────────

async function handleDisconnect(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const body = (req.body ?? {}) as { accountId?: string };
  let accountId: string;
  try {
    accountId = sanitizeAccountId(
      typeof body.accountId === "string" && body.accountId.trim()
        ? body.accountId.trim()
        : "default"
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
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
    res.status(500).json({
      error: `Failed to disconnect Signal: ${String(err)}`,
    });
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
      res.status(500).json({
        error: `Failed to persist Signal disconnect: ${String(error)}`,
      });
      return;
    }
  }

  res.status(200).json({ ok: true, accountId });
}

// ── Exported route definitions ──────────────────────────────────────────

/**
 * Plugin routes for Signal device-linking setup.
 * Registered with `rawPath: true` to preserve legacy `/api/signal/*` paths.
 */
export const signalSetupRoutes: Route[] = [
  {
    type: "POST",
    path: "/api/signal/pair",
    handler: handlePair,
    rawPath: true,
  },
  {
    type: "GET",
    path: "/api/signal/status",
    handler: handleStatus,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/signal/pair/stop",
    handler: handlePairStop,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/signal/disconnect",
    handler: handleDisconnect,
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
