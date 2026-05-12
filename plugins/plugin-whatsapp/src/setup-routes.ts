/**
 * WhatsApp setup HTTP routes.
 *
 * Provides QR-code pairing, status, disconnect, and webhook endpoints:
 *
 *   GET  /api/whatsapp/webhook       Meta webhook verification
 *   POST /api/whatsapp/webhook       Meta webhook event delivery
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
import type { IAgentRuntime, Route, RouteRequest, RouteResponse } from "@elizaos/core";
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
  stop(): void;
  getStatus(): string;
}

const whatsappPairingSessions: Map<string, PairingSessionLike> = new Map();

const MAX_PAIRING_SESSIONS = 10;

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
function cleanupStaleSessions(): void {
  for (const [id, session] of whatsappPairingSessions) {
    const status = session.getStatus();
    if (status === "disconnected" || status === "timeout" || status === "error") {
      session.stop();
      whatsappPairingSessions.delete(id);
    }
  }
}

// ── GET /api/whatsapp/webhook ──────────────────────────────────────────
async function handleWebhookVerify(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${routeHost(req)}`);
  const mode = url.searchParams.get("hub.mode") ?? "";
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  const accountId = url.searchParams.get("accountId") ?? undefined;

  const service = runtime.getService("whatsapp") as
    | {
        verifyWebhook?: (
          mode: string,
          token: string,
          challenge: string,
          accountId?: string
        ) => string | null;
      }
    | null
    | undefined;

  if (!service || typeof service.verifyWebhook !== "function") {
    res.status(503).json({ error: "WhatsApp service unavailable" });
    return;
  }

  const verifiedChallenge = service.verifyWebhook(mode, token, challenge, accountId);
  if (!verifiedChallenge) {
    res.status(403).json({ error: "Webhook verification failed" });
    return;
  }

  // Webhook verification must return the challenge as plain text
  res.status(200).json(verifiedChallenge);
}

// ── POST /api/whatsapp/webhook ─────────────────────────────────────────
async function handleWebhookEvent(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const service = runtime.getService("whatsapp") as
    | {
        handleWebhook?: (event: Record<string, unknown>) => Promise<void>;
      }
    | null
    | undefined;

  if (!service || typeof service.handleWebhook !== "function") {
    res.status(503).json({ error: "WhatsApp service unavailable" });
    return;
  }

  const body = req.body as Record<string, unknown> | null;
  if (!body) {
    res.status(400).json({ error: "Missing request body" });
    return;
  }

  await service.handleWebhook(body);

  // Meta expects a 200 with "EVENT_RECEIVED" text
  res.status(200).json("EVENT_RECEIVED");
}

// ── POST /api/whatsapp/pair ────────────────────────────────────────────
async function handlePair(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  cleanupStaleSessions();

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

  const isReplacing = whatsappPairingSessions.has(accountId);
  if (!isReplacing && whatsappPairingSessions.size >= MAX_PAIRING_SESSIONS) {
    res.status(429).json({
      error: `Too many concurrent pairing sessions (max ${MAX_PAIRING_SESSIONS})`,
    });
    return;
  }

  const workspaceDir = setupService?.getWorkspaceDir() ?? ".";
  const authDir = path.join(workspaceDir, "whatsapp-auth", accountId);
  whatsappPairingSessions.get(accountId)?.stop();

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
            const previousConfig = connectors.whatsapp ?? {};
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
}

// ── GET /api/whatsapp/status ───────────────────────────────────────────
async function handleStatus(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  cleanupStaleSessions();

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
  try {
    const waService = runtime.getService("whatsapp");
    if (waService && typeof waService === "object") {
      const waState = waService as { connected?: unknown; phoneNumber?: unknown };
      serviceConnected = Boolean(waState.connected);
      servicePhone = typeof waState.phoneNumber === "string" ? waState.phoneNumber : null;
    }
  } catch {
    /* service not yet registered */
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

  const session = whatsappPairingSessions.get(accountId);
  if (session) {
    session.stop();
    whatsappPairingSessions.delete(accountId);
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

  const session = whatsappPairingSessions.get(accountId);
  if (session) {
    session.stop();
    whatsappPairingSessions.delete(accountId);
  }

  const workspaceDir = setupService?.getWorkspaceDir() ?? ".";

  try {
    await whatsappLogout(workspaceDir, accountId);
  } catch (logoutErr) {
    console.warn(
      `[whatsapp] Logout failed for ${accountId}, deleting auth files directly:`,
      String(logoutErr)
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

  res.status(200).json({ ok: true, accountId });
}

/**
 * Plugin routes for WhatsApp setup and webhooks.
 * Registered with `rawPath: true` to preserve legacy `/api/whatsapp/*` paths.
 */
export const whatsappSetupRoutes: Route[] = [
  {
    name: "whatsapp-webhook-verify",
    type: "GET",
    path: "/api/whatsapp/webhook",
    handler: handleWebhookVerify,
    rawPath: true,
    public: true, // Meta webhook verification must bypass auth
  },
  {
    name: "whatsapp-webhook-event",
    type: "POST",
    path: "/api/whatsapp/webhook",
    handler: handleWebhookEvent,
    rawPath: true,
    public: true, // Meta webhook delivery must bypass auth
  },
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
export function stopAllPairingSessions(): void {
  for (const session of whatsappPairingSessions.values()) {
    try {
      session.stop();
    } catch {
      /* non-fatal */
    }
  }
  whatsappPairingSessions.clear();
}
