/**
 * iMessage connector setup routes.
 *
 * Implements the shared setup contract defined in
 * `@elizaos/app-core/api/setup-contract.ts`:
 *
 *   GET  /api/setup/imessage/status   service health + connection state
 *   POST /api/setup/imessage/start    mark iMessage as enabled in connector config
 *   POST /api/setup/imessage/cancel   clear stored iMessage connector config
 *
 * iMessage on macOS does not have a credential/pairing flow — it reads chat.db
 * directly and sends through Messages.app via osascript. "Setup" is just the
 * permission gate (Full Disk Access) plus marking the connector enabled in
 * config so the service spins up. The status endpoint exposes the permission
 * state so the UI can guide the user.
 *
 * Post-setup data routes (messages, chats, contacts) live in
 * `./data-routes.ts` under `/api/imessage/` since they are CRUD against a
 * working service, not part of the pairing/setup state machine.
 *
 * These routes are registered with `rawPath: true` so they mount at their
 * canonical paths without the plugin-name prefix.
 */

import type { IAgentRuntime, Route, RouteRequest, RouteResponse } from "@elizaos/core";

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

const IMESSAGE_SERVICE_NAME = "imessage";

/**
 * Narrow structural type for the IMessageService methods we call from
 * this route file. Declared here rather than imported from the service
 * module so the route file stays loosely coupled.
 */
interface IMessageServiceLike {
  isConnected(): boolean;
  getStatus?(): {
    available: boolean;
    connected: boolean;
    chatDbAvailable: boolean;
    sendOnly: boolean;
    chatDbPath: string;
    reason: string | null;
    permissionAction: {
      type: "full_disk_access";
      label: string;
      url: string;
      instructions: string[];
    } | null;
  };
}

interface ConnectorSetupService {
  getConfig(): Record<string, unknown>;
  updateConfig(updater: (config: Record<string, unknown>) => void): void;
}

function isConnectorSetupService(service: unknown): service is ConnectorSetupService {
  if (!service || typeof service !== "object") return false;
  const candidate = service as Partial<ConnectorSetupService>;
  return typeof candidate.getConfig === "function" && typeof candidate.updateConfig === "function";
}

function getSetupService(runtime: IAgentRuntime): ConnectorSetupService | null {
  const service = runtime.getService("connector-setup");
  return isConnectorSetupService(service) ? service : null;
}

function resolveService(runtime: IAgentRuntime): IMessageServiceLike | null {
  const raw = runtime.getService(IMESSAGE_SERVICE_NAME);
  return (raw as unknown as IMessageServiceLike | null | undefined) ?? null;
}

interface IMessageSetupDetail {
  available: boolean;
  connected: boolean;
  chatDbAvailable?: boolean;
  sendOnly?: boolean;
  chatDbPath?: string;
  reason?: string | null;
  permissionAction?: {
    type: "full_disk_access";
    label: string;
    url: string;
    instructions: string[];
  } | null;
}

function buildStatusResponse(runtime: IAgentRuntime): SetupStatusResponse<IMessageSetupDetail> {
  const service = resolveService(runtime);
  if (!service) {
    return {
      connector: "imessage",
      state: "idle",
      detail: {
        available: false,
        connected: false,
        reason: "imessage service not registered",
      },
    };
  }
  const connected = service.isConnected();
  const status = service.getStatus?.();
  const state: SetupState = connected ? "paired" : status?.available ? "configuring" : "idle";
  return {
    connector: "imessage",
    state,
    detail: {
      available: status?.available ?? true,
      connected,
      ...(status
        ? {
            chatDbAvailable: status.chatDbAvailable,
            sendOnly: status.sendOnly,
            chatDbPath: status.chatDbPath,
            reason: status.reason,
            permissionAction: status.permissionAction,
          }
        : {}),
    },
  };
}

// ── GET /api/setup/imessage/status ──────────────────────────────────
async function handleSetupStatus(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  res.status(200).json(buildStatusResponse(runtime));
}

// ── POST /api/setup/imessage/start ──────────────────────────────────
async function handleSetupStart(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const setupService = getSetupService(runtime);
  if (!setupService) {
    res
      .status(503)
      .json(setupError("service_unavailable", "connector-setup service not registered"));
    return;
  }

  setupService.updateConfig((cfg) => {
    if (!cfg.connectors) cfg.connectors = {};
    const connectors = cfg.connectors as Record<string, unknown>;
    const previous = (connectors.imessage as Record<string, unknown> | undefined) ?? {};
    connectors.imessage = {
      ...previous,
      enabled: true,
    };
  });

  res.status(200).json(buildStatusResponse(runtime));
}

// ── POST /api/setup/imessage/cancel ─────────────────────────────────
async function handleSetupCancel(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const setupService = getSetupService(runtime);
  if (!setupService) {
    res
      .status(503)
      .json(setupError("service_unavailable", "connector-setup service not registered"));
    return;
  }

  setupService.updateConfig((cfg) => {
    const connectors = (cfg.connectors ?? {}) as Record<string, unknown>;
    delete connectors.imessage;
  });

  res.status(200).json({
    connector: "imessage",
    state: "idle",
  } satisfies SetupStatusResponse<undefined>);
}

export const imessageSetupRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/setup/imessage/status",
    handler: handleSetupStatus,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/setup/imessage/start",
    handler: handleSetupStart,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/setup/imessage/cancel",
    handler: handleSetupCancel,
    rawPath: true,
  },
];
