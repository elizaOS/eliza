import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { registerEscalationChannel } from "../services/escalation.js";
import type {
  SignalPairingEvent,
  SignalPairingSnapshot,
  SignalPairingStatus,
} from "../services/signal-pairing.js";
import { readJsonBody as parseJsonBody, sendJson } from "@elizaos/shared";
import { setOwnerContact } from "./owner-contact-helpers.js";

export type SignalPairingEventLike = SignalPairingEvent;

export interface SignalPairingSessionLike {
  start(): Promise<void>;
  stop(): void;
  getStatus(): SignalPairingStatus;
  getSnapshot(): SignalPairingSnapshot;
}

export interface SignalRouteState {
  signalPairingSessions: Map<string, SignalPairingSessionLike>;
  signalPairingSnapshots?: Map<string, SignalPairingSnapshot>;
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

export interface SignalRouteDeps {
  sanitizeAccountId: (accountId: string) => string;
  signalAuthExists: (workspaceDir: string, accountId: string) => boolean;
  signalLogout: (workspaceDir: string, accountId: string) => void;
  createSignalPairingSession: (options: {
    authDir: string;
    accountId: string;
    cliPath?: string;
    onEvent: (event: SignalPairingEventLike) => void;
  }) => SignalPairingSessionLike;
}

const MAX_BODY_BYTES = 1_048_576;
export const MAX_PAIRING_SESSIONS = 10;
const TERMINAL_SIGNAL_PAIRING_STATUSES = new Set<SignalPairingStatus>([
  "connected",
  "disconnected",
  "timeout",
  "error",
]);

async function readJsonBody<T = Record<string, unknown>>(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<T | null> {
  return parseJsonBody(req, res, { maxBytes: MAX_BODY_BYTES });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  sendJson(res, data, status);
}

function resolveSignalStatusResponse(
  accountId: string,
  session: SignalPairingSessionLike | undefined,
  previousSnapshot: SignalPairingSnapshot | undefined,
  authExists: boolean,
  serviceConnected: boolean,
) {
  const snapshot = session?.getSnapshot() ?? previousSnapshot;
  const status =
    snapshot?.status ?? (authExists || serviceConnected ? "connected" : "idle");

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

export async function handleSignalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  state: SignalRouteState,
  deps: SignalRouteDeps,
): Promise<boolean> {
  let signalPairingSnapshots = state.signalPairingSnapshots;
  if (!signalPairingSnapshots) {
    signalPairingSnapshots = new Map();
    state.signalPairingSnapshots = signalPairingSnapshots;
  }

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
    signalPairingSnapshots.delete(accountId);
    const signalConfig =
      (state.config.connectors?.signal as
        | Record<string, unknown>
        | undefined) ?? {};
    const configuredCliPath =
      typeof signalConfig.cliPath === "string" && signalConfig.cliPath.trim()
        ? signalConfig.cliPath.trim()
        : undefined;

    let session: SignalPairingSessionLike;
    session = deps.createSignalPairingSession({
      authDir,
      accountId,
      cliPath: configuredCliPath,
      onEvent: (event) => {
        state.broadcastWs?.({ ...event });
        signalPairingSnapshots.set(accountId, session.getSnapshot());

        if (event.status === "connected") {
          if (!state.config.connectors) state.config.connectors = {};
          const previousConfig =
            (state.config.connectors.signal as
              | Record<string, unknown>
              | undefined) ?? {};
          const phoneNumber = event.phoneNumber;
          state.config.connectors.signal = {
            ...previousConfig,
            authDir,
            enabled: true,
            ...(phoneNumber && phoneNumber.trim().length > 0
              ? { account: phoneNumber.trim() }
              : {}),
          };
          // Auto-populate owner contact so LifeOps can deliver reminders
          setOwnerContact(
            state.config as Parameters<typeof setOwnerContact>[0],
            {
              source: "signal",
              channelId: phoneNumber ?? undefined,
            },
          );
          // Add Signal to the escalation channel list so it is reachable
          // without the user explicitly configuring escalation.
          registerEscalationChannel("signal");
          try {
            state.saveConfig();
          } catch (error) {
            console.error(
              `[signal] Failed to persist connector config for ${accountId}:`,
              String(error),
            );
          }
        }

        if (
          event.status &&
          TERMINAL_SIGNAL_PAIRING_STATUSES.has(event.status) &&
          state.signalPairingSessions.get(accountId) === session
        ) {
          state.signalPairingSessions.delete(accountId);
        }
      },
    });

    state.signalPairingSessions.set(accountId, session);
    signalPairingSnapshots.set(accountId, session.getSnapshot());

    void session.start().catch((err) => {
      console.error(
        `[signal] Pairing session failed for ${accountId}:`,
        String(err),
      );
      signalPairingSnapshots.set(accountId, session.getSnapshot());
      state.signalPairingSessions.delete(accountId);
    });

    json(res, {
      ok: true,
      ...resolveSignalStatusResponse(
        accountId,
        session,
        signalPairingSnapshots.get(accountId),
        false,
        false,
      ),
    });
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
    const previousSnapshot = signalPairingSnapshots.get(accountId);
    const authExists = deps.signalAuthExists(state.workspaceDir, accountId);
    let serviceConnected = false;
    if (state.runtime) {
      try {
        const sigService = state.runtime.getService("signal") as Record<
          string,
          unknown
        > | null;
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
    }

    json(
      res,
      resolveSignalStatusResponse(
        accountId,
        session,
        previousSnapshot,
        authExists,
        serviceConnected,
      ),
    );
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
    signalPairingSnapshots.delete(accountId);

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
    signalPairingSnapshots.delete(accountId);

    try {
      deps.signalLogout(state.workspaceDir, accountId);
    } catch (err) {
      json(
        res,
        {
          error: `Failed to disconnect Signal: ${String(err)}`,
        },
        500,
      );
      return true;
    }

    if (state.config.connectors) {
      const previousSignalConfig = state.config.connectors.signal;
      delete state.config.connectors.signal;
      try {
        state.saveConfig();
      } catch (error) {
        state.config.connectors.signal = previousSignalConfig;
        json(
          res,
          {
            error: `Failed to persist Signal disconnect: ${String(error)}`,
          },
          500,
        );
        return true;
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
  if (signalAuthExists(workspaceDir, "default")) {
    const sigPlugin = plugins.find((plugin) => plugin.id === "signal");
    if (sigPlugin) {
      sigPlugin.validationErrors = [];
      sigPlugin.configured = true;
      sigPlugin.qrConnected = true;
    }
  }
}
