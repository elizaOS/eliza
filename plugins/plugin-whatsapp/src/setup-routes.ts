/**
 * WhatsApp setup HTTP routes.
 *
 * Provides direct Baileys QR-code pairing, status, and disconnect endpoints:
 *   POST /api/whatsapp/pair          Start QR pairing session
 *   GET  /api/whatsapp/status        Check connection / pairing status
 *   POST /api/whatsapp/pair/stop     Stop active pairing session
 *   POST /api/whatsapp/disconnect    Logout + remove auth state
 *
 * These routes are registered with `rawPath: true` so they mount at their
 * legacy paths without the plugin-name prefix.
 */

import fs from "node:fs";
import path from "node:path";
import {
  logger as coreLogger,
  type IAgentRuntime,
  type Route,
  type RouteRequest,
  type RouteResponse,
} from "@elizaos/core";
import type { WhatsAppPairingEvent } from "./pairing-service.js";
import {
  sanitizeAccountId,
  WhatsAppPairingSession,
  whatsappAuthExists,
  whatsappLogout,
} from "./pairing-service.js";

// ── Module-level state ─────────────────────────────────────────────────
// Replaces WhatsAppRouteState.whatsappPairingSessions — shared across
// all route handler invocations within this plugin.

interface PairingSessionLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): string;
}

const whatsappPairingSessions: Map<string, PairingSessionLike> = new Map();
let pairingTransition: Promise<void> = Promise.resolve();

const MAX_PAIRING_SESSIONS = 10;

async function acquirePairingTransition(): Promise<() => void> {
  const previous = pairingTransition;
  let releaseTransition: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseTransition = resolve;
  });
  pairingTransition = current;
  await previous;
  return () => {
    releaseTransition?.();
    if (pairingTransition === current) pairingTransition = Promise.resolve();
  };
}

async function stopPairingSession(accountId: string): Promise<void> {
  for (;;) {
    const session = whatsappPairingSessions.get(accountId);
    if (!session) return;
    await session.stop();
    if (whatsappPairingSessions.get(accountId) === session) {
      whatsappPairingSessions.delete(accountId);
      return;
    }
  }
}

function routeHost(req: RouteRequest): string {
  const host = req.headers?.host;
  return (Array.isArray(host) ? host[0] : host) ?? "localhost";
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
  getWorkspaceDir(): string;
  broadcastWs(data: object): void;
}

function isConnectorSetupService(service: unknown): service is ConnectorSetupService {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as ConnectorSetupService).getConfig === "function" &&
    typeof (service as ConnectorSetupService).persistConfig === "function" &&
    typeof (service as ConnectorSetupService).updateConfig === "function" &&
    typeof (service as ConnectorSetupService).registerEscalationChannel === "function" &&
    typeof (service as ConnectorSetupService).setOwnerContact === "function" &&
    typeof (service as ConnectorSetupService).getWorkspaceDir === "function" &&
    typeof (service as ConnectorSetupService).broadcastWs === "function"
  );
}

function getSetupService(runtime: IAgentRuntime): ConnectorSetupService | null {
  const service = runtime.getService("connector-setup");
  return isConnectorSetupService(service) ? service : null;
}

/** Clean up disconnected / timed-out / errored sessions. */
async function cleanupStaleSessions(): Promise<void> {
  for (const id of whatsappPairingSessions.keys()) {
    const releaseTransition = await acquirePairingTransition();
    try {
      const status = whatsappPairingSessions.get(id)?.getStatus();
      if (status === "disconnected" || status === "timeout" || status === "error") {
        await stopPairingSession(id);
      }
    } finally {
      releaseTransition();
    }
  }
}

// ── POST /api/whatsapp/pair ────────────────────────────────────────────
async function handlePair(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  await cleanupStaleSessions();

  const setupService = getSetupService(runtime);
  const body = req.body as { accountId?: string } | null;

  let accountId: string;
  try {
    accountId = sanitizeAccountId(
      body && typeof body.accountId === "string" && body.accountId.trim()
        ? body.accountId.trim()
        : "default"
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const releaseTransition = await acquirePairingTransition();

  try {
    const isReplacing = whatsappPairingSessions.has(accountId);
    if (!isReplacing && whatsappPairingSessions.size >= MAX_PAIRING_SESSIONS) {
      res.status(429).json({
        error: `Too many concurrent pairing sessions (max ${MAX_PAIRING_SESSIONS})`,
      });
      return;
    }

    const workspaceDir = setupService?.getWorkspaceDir() ?? ".";
    const authDir = path.join(workspaceDir, "whatsapp-auth", accountId);
    await stopPairingSession(accountId);

    const session = new WhatsAppPairingSession({
      authDir,
      accountId,
      onEvent: (event: WhatsAppPairingEvent) => {
        setupService?.broadcastWs(event);

        if (event.status === "connected") {
          if (setupService) {
            setupService.updateConfig((config) => {
              if (!config.connectors) config.connectors = {};
              const connectors = config.connectors as Record<string, Record<string, unknown>>;
              const previousConfig = connectors.whatsapp;
              if (accountId === "default") {
                connectors.whatsapp = {
                  ...previousConfig,
                  authDir,
                  transport: "baileys",
                  enabled: true,
                };
                return;
              }
              const accounts =
                typeof previousConfig.accounts === "object" && previousConfig.accounts !== null
                  ? { ...(previousConfig.accounts as Record<string, Record<string, unknown>>) }
                  : {};
              accounts[accountId] = {
                ...(accounts[accountId] ?? {}),
                authDir,
                transport: "baileys",
                enabled: true,
              };
              connectors.whatsapp = {
                ...previousConfig,
                accounts,
                enabled: true,
              };
            });

            // Auto-populate owner contact so LifeOps can deliver reminders
            const phoneNumber = event.phoneNumber;
            setupService.setOwnerContact({
              source: "whatsapp",
              channelId: phoneNumber ?? undefined,
            });
          }
        }
      },
    });

    whatsappPairingSessions.set(accountId, session);

    try {
      await session.start();
      res.status(200).json({ ok: true, accountId, status: session.getStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  } finally {
    releaseTransition();
  }
}

// ── GET /api/whatsapp/status ───────────────────────────────────────────
async function handleStatus(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  await cleanupStaleSessions();

  const setupService = getSetupService(runtime);
  const url = new URL(req.url ?? "/", `http://${routeHost(req)}`);

  let accountId: string;
  try {
    accountId = sanitizeAccountId(url.searchParams.get("accountId") || "default");
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  const session = whatsappPairingSessions.get(accountId);
  const workspaceDir = setupService?.getWorkspaceDir() ?? ".";

  let serviceConnected = false;
  let servicePhone: string | null = null;
  const waService = runtime.getService("whatsapp");
  if (waService && typeof waService === "object") {
    const waState = waService as { connected?: unknown; phoneNumber?: unknown };
    serviceConnected = Boolean(waState.connected);
    servicePhone = typeof waState.phoneNumber === "string" ? waState.phoneNumber : null;
  }

  res.status(200).json({
    accountId,
    status: session?.getStatus() ?? "idle",
    authExists: whatsappAuthExists(workspaceDir, accountId),
    serviceConnected,
    servicePhone,
  });
}

// ── POST /api/whatsapp/pair/stop ───────────────────────────────────────
async function handlePairStop(
  req: RouteRequest,
  res: RouteResponse,
  _runtime: IAgentRuntime
): Promise<void> {
  const body = req.body as { accountId?: string } | null;

  let accountId: string;
  try {
    accountId = sanitizeAccountId(
      body && typeof body.accountId === "string" && body.accountId.trim()
        ? body.accountId.trim()
        : "default"
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  const releaseTransition = await acquirePairingTransition();
  try {
    await stopPairingSession(accountId);
  } finally {
    releaseTransition();
  }

  res.status(200).json({ ok: true, accountId, status: "idle" });
}

// ── POST /api/whatsapp/disconnect ──────────────────────────────────────
async function handleDisconnect(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const setupService = getSetupService(runtime);
  const body = req.body as { accountId?: string } | null;

  let accountId: string;
  try {
    accountId = sanitizeAccountId(
      body && typeof body.accountId === "string" && body.accountId.trim()
        ? body.accountId.trim()
        : "default"
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  const releaseTransition = await acquirePairingTransition();
  try {
    await stopPairingSession(accountId);

    const workspaceDir = setupService?.getWorkspaceDir() ?? ".";

    try {
      await whatsappLogout(workspaceDir, accountId);
    } catch (logoutErr) {
      runtime.logger.warn(
        { src: "plugin:whatsapp", accountId, error: String(logoutErr) },
        "WhatsApp remote logout failed; deleting local auth state"
      );
      const authDir = path.join(workspaceDir, "whatsapp-auth", accountId);
      try {
        fs.rmSync(authDir, { recursive: true, force: true });
      } catch {
        /* may not exist */
      }
    }

    if (setupService) {
      setupService.updateConfig((config) => {
        const connectors = config.connectors as Record<string, unknown> | undefined;
        if (connectors) {
          if (accountId === "default") {
            delete connectors.whatsapp;
            return;
          }
          const whatsappConfig = connectors.whatsapp as Record<string, unknown> | undefined;
          const accounts = whatsappConfig?.accounts as Record<string, unknown> | undefined;
          if (accounts) {
            delete accounts[accountId];
          }
          connectors.whatsapp = {
            ...(whatsappConfig ?? {}),
            ...(accounts ? { accounts } : {}),
          };
        }
      });
    }
  } finally {
    releaseTransition();
  }

  res.status(200).json({ ok: true, accountId });
}

/**
 * Authenticated plugin routes for direct WhatsApp setup.
 * Registered with `rawPath: true` to preserve legacy `/api/whatsapp/*` paths.
 */
export const whatsappSetupRoutes: Route[] = [
  {
    type: "POST",
    path: "/api/whatsapp/pair",
    handler: handlePair,
    rawPath: true,
  },
  {
    type: "GET",
    path: "/api/whatsapp/status",
    handler: handleStatus,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/whatsapp/pair/stop",
    handler: handlePairStop,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/whatsapp/disconnect",
    handler: handleDisconnect,
    rawPath: true,
  },
];

/**
 * Stop all active pairing sessions. Called during shutdown cleanup.
 */
export async function stopAllPairingSessions(): Promise<void> {
  for (const accountId of whatsappPairingSessions.keys()) {
    const releaseTransition = await acquirePairingTransition();
    try {
      await stopPairingSession(accountId);
    } catch (error) {
      // error-policy:J6 Shutdown continues after a best-effort pairing teardown failure.
      coreLogger.warn(`[whatsapp] Pairing teardown failed for ${accountId}: ${String(error)}`);
    } finally {
      releaseTransition();
    }
  }
  whatsappPairingSessions.clear();
}
