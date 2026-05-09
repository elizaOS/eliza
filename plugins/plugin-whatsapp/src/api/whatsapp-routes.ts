import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { readJsonBody as parseJsonBody, sendJson, setOwnerContact } from "@elizaos/agent";
import { logger } from "@elizaos/core";
import type { WhatsAppPairingEvent } from "../services/whatsapp-pairing.js";

export type WhatsAppPairingEventLike = WhatsAppPairingEvent;

export interface WhatsAppPairingSessionLike {
  start(): Promise<void>;
  stop(): void;
  getStatus(): string;
}

export interface WhatsAppRouteState {
  whatsappPairingSessions: Map<string, WhatsAppPairingSessionLike>;
  broadcastWs?: (data: object) => void;
  config: {
    connectors?: Record<string, unknown>;
  };
  runtime?: {
    getService(type: string): unknown | null;
  };
  saveConfig: () => void;
  workspaceDir: string;
}

export interface WhatsAppRouteDeps {
  sanitizeAccountId: (accountId: string) => string;
  whatsappAuthExists: (workspaceDir: string, accountId: string) => boolean;
  whatsappLogout: (workspaceDir: string, accountId: string) => Promise<void>;
  createWhatsAppPairingSession: (options: {
    authDir: string;
    accountId: string;
    onEvent: (event: WhatsAppPairingEventLike) => void;
  }) => WhatsAppPairingSessionLike;
}

interface WhatsAppAccountBody {
  accountId?: string;
  configurePlugin?: boolean;
  authScope?: WhatsAppAuthScope;
}

type WhatsAppAuthScope = "platform" | "lifeops";

const MAX_BODY_BYTES = 1_048_576;
export const MAX_PAIRING_SESSIONS = 10;

async function readJsonBody<T = Record<string, unknown>>(
  req: IncomingMessage,
  res: ServerResponse
): Promise<T | null> {
  return parseJsonBody(req, res, { maxBytes: MAX_BODY_BYTES });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  sendJson(res, data, status);
}

function shouldConfigurePlugin(body: WhatsAppAccountBody | null): boolean {
  return body?.configurePlugin !== false;
}

function resolveAuthScope(value: unknown): WhatsAppAuthScope {
  return value === "lifeops" ? "lifeops" : "platform";
}

function resolveSessionKey(authScope: WhatsAppAuthScope, accountId: string): string {
  return `${authScope}:${accountId}`;
}

function resolveAuthDir(
  workspaceDir: string,
  accountId: string,
  authScope: WhatsAppAuthScope
): string {
  return path.join(
    workspaceDir,
    authScope === "lifeops" ? "lifeops-whatsapp-auth" : "whatsapp-auth",
    accountId
  );
}

function authExistsForScope(
  state: WhatsAppRouteState,
  deps: WhatsAppRouteDeps,
  accountId: string,
  authScope: WhatsAppAuthScope
): boolean {
  if (authScope === "platform") {
    return deps.whatsappAuthExists(state.workspaceDir, accountId);
  }
  return fs.existsSync(
    path.join(resolveAuthDir(state.workspaceDir, accountId, authScope), "creds.json")
  );
}

export async function handleWhatsAppRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  state: WhatsAppRouteState,
  deps: WhatsAppRouteDeps
): Promise<boolean> {
  if (!pathname.startsWith("/api/whatsapp")) return false;

  if (pathname === "/api/whatsapp/webhook" && method === "GET") {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const mode = url.searchParams.get("hub.mode") ?? "";
    const token = url.searchParams.get("hub.verify_token") ?? "";
    const challenge = url.searchParams.get("hub.challenge") ?? "";

    const service = state.runtime?.getService("whatsapp") as
      | {
          verifyWebhook?: (mode: string, token: string, challenge: string) => string | null;
        }
      | null
      | undefined;

    if (!service || typeof service.verifyWebhook !== "function") {
      json(res, { error: "WhatsApp service unavailable" }, 503);
      return true;
    }

    const verifiedChallenge = service.verifyWebhook(mode, token, challenge);
    if (!verifiedChallenge) {
      json(res, { error: "Webhook verification failed" }, 403);
      return true;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end(verifiedChallenge);
    return true;
  }

  if (pathname === "/api/whatsapp/webhook" && method === "POST") {
    const service = state.runtime?.getService("whatsapp") as
      | {
          handleWebhook?: (event: Record<string, unknown>) => Promise<void>;
        }
      | null
      | undefined;

    if (!service || typeof service.handleWebhook !== "function") {
      json(res, { error: "WhatsApp service unavailable" }, 503);
      return true;
    }

    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) {
      return true;
    }

    await service.handleWebhook(body);

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end("EVENT_RECEIVED");
    return true;
  }

  if (method === "POST" && pathname === "/api/whatsapp/pair") {
    const body = await readJsonBody<WhatsAppAccountBody>(req, res);
    const authScope = resolveAuthScope(body?.authScope);
    const configurePlugin = authScope === "platform" && shouldConfigurePlugin(body);
    let accountId: string;
    try {
      accountId = deps.sanitizeAccountId(
        body && typeof body.accountId === "string" && body.accountId.trim()
          ? body.accountId.trim()
          : "default"
      );
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
      return true;
    }
    const sessionKey = resolveSessionKey(authScope, accountId);

    const isReplacing = state.whatsappPairingSessions.has(sessionKey);
    if (!isReplacing && state.whatsappPairingSessions.size >= MAX_PAIRING_SESSIONS) {
      json(
        res,
        {
          error: `Too many concurrent pairing sessions (max ${MAX_PAIRING_SESSIONS})`,
        },
        429
      );
      return true;
    }

    const authDir = resolveAuthDir(state.workspaceDir, accountId, authScope);
    state.whatsappPairingSessions.get(sessionKey)?.stop();

    const session = deps.createWhatsAppPairingSession({
      authDir,
      accountId,
      onEvent: (event) => {
        state.broadcastWs?.({ ...event, authScope });

        if (event.status === "connected") {
          let configChanged = false;
          if (configurePlugin) {
            if (!state.config.connectors) state.config.connectors = {};
            state.config.connectors.whatsapp = {
              ...((state.config.connectors.whatsapp as Record<string, unknown> | undefined) ?? {}),
              authDir,
              enabled: true,
            };
            configChanged = true;
          }

          const phoneNumber = event.phoneNumber;
          configChanged =
            setOwnerContact(state.config as Parameters<typeof setOwnerContact>[0], {
              source: "whatsapp",
              channelId: phoneNumber ?? undefined,
            }) || configChanged;

          if (!configChanged) {
            return;
          }

          try {
            state.saveConfig();
          } catch {
            /* test envs */
          }
        }
      },
    });

    state.whatsappPairingSessions.set(sessionKey, session);

    try {
      await session.start();
      json(res, {
        ok: true,
        accountId,
        authScope,
        status: session.getStatus(),
      });
    } catch (err) {
      json(res, { ok: false, error: String(err) }, 500);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/whatsapp/status") {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    let accountId: string;
    try {
      accountId = deps.sanitizeAccountId(url.searchParams.get("accountId") || "default");
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
      return true;
    }
    const authScope = resolveAuthScope(url.searchParams.get("authScope"));
    const sessionKey = resolveSessionKey(authScope, accountId);

    const session = state.whatsappPairingSessions.get(sessionKey);

    let serviceConnected = false;
    let servicePhone: string | null = null;
    if (state.runtime) {
      try {
        const waService = state.runtime.getService("whatsapp") as Record<string, unknown> | null;
        if (waService) {
          serviceConnected = Boolean(waService.connected);
          servicePhone = (waService.phoneNumber as string) ?? null;
        }
      } catch {
        /* service not yet registered */
      }
    }

    json(res, {
      accountId,
      authScope,
      status: session?.getStatus() ?? "idle",
      authExists: authExistsForScope(state, deps, accountId, authScope),
      serviceConnected,
      servicePhone,
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/whatsapp/pair/stop") {
    const body = await readJsonBody<WhatsAppAccountBody>(req, res);
    const authScope = resolveAuthScope(body?.authScope);
    let accountId: string;
    try {
      accountId = deps.sanitizeAccountId(
        body && typeof body.accountId === "string" && body.accountId.trim()
          ? body.accountId.trim()
          : "default"
      );
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
      return true;
    }
    const sessionKey = resolveSessionKey(authScope, accountId);

    const session = state.whatsappPairingSessions.get(sessionKey);
    if (session) {
      session.stop();
      state.whatsappPairingSessions.delete(sessionKey);
    }

    json(res, { ok: true, accountId, authScope, status: "idle" });
    return true;
  }

  if (method === "POST" && pathname === "/api/whatsapp/disconnect") {
    const body = await readJsonBody<WhatsAppAccountBody>(req, res);
    const authScope = resolveAuthScope(body?.authScope);
    const configurePlugin = authScope === "platform" && shouldConfigurePlugin(body);
    let accountId: string;
    try {
      accountId = deps.sanitizeAccountId(
        body && typeof body.accountId === "string" && body.accountId.trim()
          ? body.accountId.trim()
          : "default"
      );
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
      return true;
    }
    const sessionKey = resolveSessionKey(authScope, accountId);

    const session = state.whatsappPairingSessions.get(sessionKey);
    if (session) {
      session.stop();
      state.whatsappPairingSessions.delete(sessionKey);
    }

    const authDir = resolveAuthDir(state.workspaceDir, accountId, authScope);
    try {
      if (authScope === "platform") {
        await deps.whatsappLogout(state.workspaceDir, accountId);
      } else {
        fs.rmSync(authDir, { recursive: true, force: true });
      }
    } catch (logoutErr) {
      logger.warn(
        {
          accountId,
          error: logoutErr instanceof Error ? logoutErr.message : String(logoutErr),
        },
        "[whatsapp] Logout failed, deleting auth files directly"
      );
      try {
        fs.rmSync(authDir, { recursive: true, force: true });
      } catch {
        /* may not exist */
      }
    }

    if (configurePlugin && state.config.connectors) {
      delete state.config.connectors.whatsapp;
      try {
        state.saveConfig();
      } catch {
        /* test envs */
      }
    }

    json(res, { ok: true, accountId, authScope });
    return true;
  }

  return false;
}

export function applyWhatsAppQrOverride(
  plugins: {
    id: string;
    validationErrors: unknown[];
    configured: boolean;
    qrConnected?: boolean;
  }[],
  workspaceDir: string
): void {
  try {
    const waCredsPath = path.join(workspaceDir, "whatsapp-auth", "default", "creds.json");
    if (fs.existsSync(waCredsPath)) {
      const waPlugin = plugins.find((plugin) => plugin.id === "whatsapp");
      if (waPlugin) {
        waPlugin.validationErrors = [];
        waPlugin.configured = true;
        waPlugin.qrConnected = true;
      }
    }
  } catch {
    /* workspace dir may not exist */
  }
}
