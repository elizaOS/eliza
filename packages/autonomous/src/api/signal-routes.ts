import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { readJsonBody as parseJsonBody, sendJson } from "./http-helpers";

export interface SignalPairingEventLike {
  status?: string;
  [key: string]: unknown;
}

export interface SignalPairingSessionLike {
  start(): Promise<void>;
  stop(): void;
  getStatus(): string;
}

export interface SignalRouteState {
  signalPairingSessions: Map<string, SignalPairingSessionLike>;
  broadcastWs?: (data: Record<string, unknown>) => void;
  config: {
    connectors?: Record<string, unknown>;
  };
  runtime?: {
    getService(type: string): unknown | null;
  };
  saveConfig: () => void;
  workspaceDir: string;
}

export interface SignalRouteDeps {
  sanitizeAccountId: (accountId: string) => string;
  signalAuthExists: (workspaceDir: string, accountId: string) => boolean;
  signalLogout: (workspaceDir: string, accountId: string) => void;
  createSignalPairingSession: (options: {
    authDir: string;
    accountId: string;
    onEvent: (event: SignalPairingEventLike) => void;
  }) => SignalPairingSessionLike;
}

const MAX_BODY_BYTES = 1_048_576;
export const MAX_PAIRING_SESSIONS = 10;

async function readJsonBody<T = Record<string, unknown>>(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<T | null> {
  return parseJsonBody(req, res, { maxBytes: MAX_BODY_BYTES });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  sendJson(res, data, status);
}

export async function handleSignalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  state: SignalRouteState,
  deps: SignalRouteDeps,
): Promise<boolean> {
  if (!pathname.startsWith("/api/signal")) return false;

  if (method === "POST" && pathname === "/api/signal/pair") {
    const body = await readJsonBody<{ accountId?: string }>(req, res);
    let accountId: string;
    try {
      accountId = deps.sanitizeAccountId(
        body && typeof body.accountId === "string" && body.accountId.trim()
          ? body.accountId.trim()
          : "default",
      );
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
      return true;
    }

    const isReplacing = state.signalPairingSessions.has(accountId);
    if (
      !isReplacing &&
      state.signalPairingSessions.size >= MAX_PAIRING_SESSIONS
    ) {
      json(
        res,
        {
          error: `Too many concurrent pairing sessions (max ${MAX_PAIRING_SESSIONS})`,
        },
        429,
      );
      return true;
    }

    const authDir = path.join(state.workspaceDir, "signal-auth", accountId);
    state.signalPairingSessions.get(accountId)?.stop();

    const session = deps.createSignalPairingSession({
      authDir,
      accountId,
      onEvent: (event) => {
        state.broadcastWs?.(event as Record<string, unknown>);

        if (event.status === "connected") {
          if (!state.config.connectors) state.config.connectors = {};
          state.config.connectors.signal = {
            ...((state.config.connectors.signal as
              | Record<string, unknown>
              | undefined) ?? {}),
            authDir,
            enabled: true,
          };
          try {
            state.saveConfig();
          } catch {
            /* test envs */
          }
        }
      },
    });

    state.signalPairingSessions.set(accountId, session);

    void session.start().catch((err) => {
      console.error(
        `[signal] Pairing session failed for ${accountId}:`,
        err instanceof Error ? err.message : String(err),
      );
      state.signalPairingSessions.delete(accountId);
    });

    json(res, { ok: true, accountId, status: session.getStatus() });
    return true;
  }

  if (method === "GET" && pathname === "/api/signal/status") {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    let accountId: string;
    try {
      accountId = deps.sanitizeAccountId(
        url.searchParams.get("accountId") || "default",
      );
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
      return true;
    }

    const session = state.signalPairingSessions.get(accountId);
    let serviceConnected = false;
    if (state.runtime) {
      try {
        const sigService = state.runtime.getService("signal") as Record<
          string,
          unknown
        > | null;
        if (sigService) {
          serviceConnected = Boolean(sigService.connected);
        }
      } catch {
        /* service not yet registered */
      }
    }

    json(res, {
      accountId,
      status: session?.getStatus() ?? "idle",
      authExists: deps.signalAuthExists(state.workspaceDir, accountId),
      serviceConnected,
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/signal/pair/stop") {
    const body = await readJsonBody<{ accountId?: string }>(req, res);
    let accountId: string;
    try {
      accountId = deps.sanitizeAccountId(
        body && typeof body.accountId === "string" && body.accountId.trim()
          ? body.accountId.trim()
          : "default",
      );
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
      return true;
    }

    const session = state.signalPairingSessions.get(accountId);
    if (session) {
      session.stop();
      state.signalPairingSessions.delete(accountId);
    }

    json(res, { ok: true, accountId, status: "idle" });
    return true;
  }

  if (method === "POST" && pathname === "/api/signal/disconnect") {
    const body = await readJsonBody<{ accountId?: string }>(req, res);
    let accountId: string;
    try {
      accountId = deps.sanitizeAccountId(
        body && typeof body.accountId === "string" && body.accountId.trim()
          ? body.accountId.trim()
          : "default",
      );
    } catch (err) {
      json(res, { error: (err as Error).message }, 400);
      return true;
    }

    const session = state.signalPairingSessions.get(accountId);
    if (session) {
      session.stop();
      state.signalPairingSessions.delete(accountId);
    }

    try {
      deps.signalLogout(state.workspaceDir, accountId);
    } catch (err) {
      console.warn(
        `[signal] Logout failed for ${accountId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    if (state.config.connectors) {
      delete state.config.connectors.signal;
      try {
        state.saveConfig();
      } catch {
        /* test envs */
      }
    }

    json(res, { ok: true, accountId });
    return true;
  }

  return false;
}

export function applySignalQrOverride(
  plugins: {
    id: string;
    validationErrors: unknown[];
    configured: boolean;
    qrConnected?: boolean;
  }[],
  workspaceDir: string,
  signalAuthExists: (workspaceDir: string, accountId: string) => boolean,
): void {
  try {
    if (signalAuthExists(workspaceDir, "default")) {
      const sigPlugin = plugins.find((plugin) => plugin.id === "signal");
      if (sigPlugin) {
        sigPlugin.validationErrors = [];
        sigPlugin.configured = true;
        sigPlugin.qrConnected = true;
      }
    }
  } catch {
    /* workspace dir may not exist */
  }
}
