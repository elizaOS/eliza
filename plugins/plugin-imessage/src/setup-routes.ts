/**
 * iMessage connector HTTP routes.
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
 * Post-setup data routes (messages, chats, contacts) remain under
 * `/api/imessage/` since they are CRUD against a working service, not part
 * of the pairing/setup state machine.
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
  getRecentMessages(limit?: number): Promise<
    Array<{
      id: string;
      text: string;
      handle: string;
      chatId: string;
      timestamp: number;
      isFromMe: boolean;
      hasAttachments: boolean;
      attachmentPaths?: string[];
    }>
  >;
  getMessages?(options?: { chatId?: string; limit?: number }): Promise<
    Array<{
      id: string;
      text: string;
      handle: string;
      chatId: string;
      timestamp: number;
      isFromMe: boolean;
      hasAttachments: boolean;
      attachmentPaths?: string[];
    }>
  >;
  sendMessage(
    to: string,
    text: string,
    options?: {
      mediaUrl?: string;
      maxBytes?: number;
    }
  ): Promise<{
    success: boolean;
    messageId?: string;
    chatId?: string;
    error?: string;
  }>;
  getChats(): Promise<
    Array<{
      chatId: string;
      chatType: string;
      displayName?: string;
      participants: Array<{ handle: string; isPhoneNumber: boolean }>;
    }>
  >;
  listAllContacts(): Promise<
    Array<{
      id: string;
      name: string;
      firstName: string | null;
      lastName: string | null;
      phones: Array<{ label: string | null; value: string }>;
      emails: Array<{ label: string | null; value: string }>;
    }>
  >;
  addContact(input: {
    firstName?: string;
    lastName?: string;
    phones?: Array<{ label?: string; value: string }>;
    emails?: Array<{ label?: string; value: string }>;
  }): Promise<string | null>;
  updateContact(
    personId: string,
    patch: {
      firstName?: string;
      lastName?: string;
      addPhones?: Array<{ label?: string; value: string }>;
      removePhones?: string[];
      addEmails?: Array<{ label?: string; value: string }>;
      removeEmails?: string[];
    }
  ): Promise<boolean>;
  deleteContact(personId: string): Promise<boolean>;
}

interface ConnectorSetupService {
  getConfig(): Record<string, unknown>;
  updateConfig(updater: (config: Record<string, unknown>) => void): void;
}

function isConnectorSetupService(service: unknown): service is ConnectorSetupService {
  if (!service || typeof service !== "object") return false;
  const candidate = service as Partial<ConnectorSetupService>;
  return (
    typeof candidate.getConfig === "function" &&
    typeof candidate.updateConfig === "function"
  );
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
  const state: SetupState = connected
    ? "paired"
    : status?.available
      ? "configuring"
      : "idle";
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

/**
 * Extract the `:id` segment from a contact path like
 * `/api/imessage/contacts/ABCD-EFGH-...`. Returns null if the path
 * doesn't match.
 */
function parseContactId(pathname: string): string | null {
  const prefix = "/api/imessage/contacts/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!rest) return null;
  return decodeURIComponent(rest);
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
      .json(
        setupError("service_unavailable", "connector-setup service not registered")
      );
    return;
  }

  setupService.updateConfig((cfg) => {
    if (!cfg.connectors) cfg.connectors = {};
    const connectors = cfg.connectors as Record<string, unknown>;
    const previous =
      (connectors.imessage as Record<string, unknown> | undefined) ?? {};
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
      .json(
        setupError("service_unavailable", "connector-setup service not registered")
      );
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

// ── GET /api/imessage/messages?limit=N ──────────────────────────────
async function handleMessages(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const service = resolveService(runtime);
  if (!service) {
    res
      .status(503)
      .json(
        setupError("service_unavailable", "imessage service not registered")
      );
    return;
  }
  const url = new URL(req.url ?? "/api/imessage/messages", "http://localhost");
  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(Math.max(1, Number.parseInt(limitParam ?? "50", 10) || 50), 500);
  const chatId = url.searchParams.get("chatId")?.trim() || undefined;
  try {
    const messages =
      typeof service.getMessages === "function"
        ? await service.getMessages({ chatId, limit })
        : await service.getRecentMessages(limit);
    res.status(200).json({ messages, count: messages.length });
  } catch (err) {
    res
      .status(500)
      .json(
        setupError(
          "internal_error",
          `failed to read messages: ${err instanceof Error ? err.message : String(err)}`
        )
      );
  }
}

// ── POST /api/imessage/messages ────────────────────────────────────
async function handleSendMessage(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const service = resolveService(runtime);
  if (!service) {
    res
      .status(503)
      .json(
        setupError("service_unavailable", "imessage service not registered")
      );
    return;
  }

  const body =
    (req.body as {
      to?: string;
      chatId?: string;
      text?: string;
      mediaUrl?: string;
      maxBytes?: number;
    }) ?? {};

  const to = body.to?.trim() || "";
  const chatId = body.chatId?.trim() || "";
  const text = body.text?.trim() || "";
  const mediaUrl = body.mediaUrl?.trim() || undefined;

  if (!to && !chatId) {
    res
      .status(400)
      .json(setupError("bad_request", "either to or chatId is required"));
    return;
  }

  if (!text && !mediaUrl) {
    res
      .status(400)
      .json(setupError("bad_request", "either text or mediaUrl is required"));
    return;
  }

  try {
    const result = await service.sendMessage(chatId ? `chat_id:${chatId}` : to, text, {
      ...(mediaUrl ? { mediaUrl } : {}),
      ...(typeof body.maxBytes === "number" ? { maxBytes: body.maxBytes } : {}),
    });
    if (!result.success) {
      res
        .status(500)
        .json(
          setupError(
            "internal_error",
            result.error ?? "failed to send iMessage"
          )
        );
      return;
    }
    res.status(200).json(result);
  } catch (err) {
    res
      .status(500)
      .json(
        setupError(
          "internal_error",
          `sendMessage threw: ${err instanceof Error ? err.message : String(err)}`
        )
      );
  }
}

// ── GET /api/imessage/chats ─────────────────────────────────────────
async function handleChats(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const service = resolveService(runtime);
  if (!service) {
    res
      .status(503)
      .json(
        setupError("service_unavailable", "imessage service not registered")
      );
    return;
  }
  try {
    const chats = await service.getChats();
    res.status(200).json({ chats, count: chats.length });
  } catch (err) {
    res
      .status(500)
      .json(
        setupError(
          "internal_error",
          `failed to read chats: ${err instanceof Error ? err.message : String(err)}`
        )
      );
  }
}

// ── GET /api/imessage/contacts ──────────────────────────────────────
async function handleListContacts(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const service = resolveService(runtime);
  if (!service) {
    res
      .status(503)
      .json(
        setupError("service_unavailable", "imessage service not registered")
      );
    return;
  }
  try {
    const contacts = await service.listAllContacts();
    res.status(200).json({ contacts, count: contacts.length });
  } catch (err) {
    res
      .status(500)
      .json(
        setupError(
          "internal_error",
          `failed to read contacts: ${err instanceof Error ? err.message : String(err)}`
        )
      );
  }
}

// ── POST /api/imessage/contacts ─────────────────────────────────────
async function handleCreateContact(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const service = resolveService(runtime);
  if (!service) {
    res
      .status(503)
      .json(
        setupError("service_unavailable", "imessage service not registered")
      );
    return;
  }
  const body =
    (req.body as {
      firstName?: string;
      lastName?: string;
      phones?: Array<{ label?: string; value: string }>;
      emails?: Array<{ label?: string; value: string }>;
    }) ?? {};

  if (!body.firstName && !body.lastName && !body.phones?.length && !body.emails?.length) {
    res
      .status(400)
      .json(
        setupError(
          "bad_request",
          "at least one of firstName, lastName, phones, or emails is required"
        )
      );
    return;
  }

  try {
    const id = await service.addContact({
      firstName: body.firstName,
      lastName: body.lastName,
      phones: body.phones,
      emails: body.emails,
    });
    if (!id) {
      res
        .status(500)
        .json(
          setupError(
            "internal_error",
            "contact creation failed — see server logs. Common cause: Contacts write permission not granted yet."
          )
        );
      return;
    }
    res.status(201).json({ id, created: true });
  } catch (err) {
    res
      .status(500)
      .json(
        setupError(
          "internal_error",
          `addContact threw: ${err instanceof Error ? err.message : String(err)}`
        )
      );
  }
}

// ── PATCH /api/imessage/contacts/:id ────────────────────────────────
async function handleUpdateContact(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const pathname = req.url ?? "";
  const id = parseContactId(pathname.split("?")[0]);
  if (!id) {
    res
      .status(400)
      .json(setupError("bad_request", "contact id is required in the path"));
    return;
  }
  const service = resolveService(runtime);
  if (!service) {
    res
      .status(503)
      .json(
        setupError("service_unavailable", "imessage service not registered")
      );
    return;
  }
  const body =
    (req.body as {
      firstName?: string;
      lastName?: string;
      addPhones?: Array<{ label?: string; value: string }>;
      removePhones?: string[];
      addEmails?: Array<{ label?: string; value: string }>;
      removeEmails?: string[];
    }) ?? {};

  try {
    const ok = await service.updateContact(id, {
      firstName: body.firstName,
      lastName: body.lastName,
      addPhones: body.addPhones,
      removePhones: body.removePhones,
      addEmails: body.addEmails,
      removeEmails: body.removeEmails,
    });
    if (!ok) {
      res
        .status(500)
        .json(
          setupError(
            "internal_error",
            "contact update failed — see server logs. Contact may not exist, or write permission may be denied."
          )
        );
      return;
    }
    res.status(200).json({ id, updated: true });
  } catch (err) {
    res
      .status(500)
      .json(
        setupError(
          "internal_error",
          `updateContact threw: ${err instanceof Error ? err.message : String(err)}`
        )
      );
  }
}

// ── DELETE /api/imessage/contacts/:id ───────────────────────────────
async function handleDeleteContact(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const pathname = req.url ?? "";
  const id = parseContactId(pathname.split("?")[0]);
  if (!id) {
    res
      .status(400)
      .json(setupError("bad_request", "contact id is required in the path"));
    return;
  }
  const service = resolveService(runtime);
  if (!service) {
    res
      .status(503)
      .json(
        setupError("service_unavailable", "imessage service not registered")
      );
    return;
  }
  try {
    const ok = await service.deleteContact(id);
    if (!ok) {
      res
        .status(500)
        .json(
          setupError(
            "internal_error",
            "contact delete failed — see server logs. Contact may not exist, or write permission may be denied."
          )
        );
      return;
    }
    res.status(200).json({ id, deleted: true });
  } catch (err) {
    res
      .status(500)
      .json(
        setupError(
          "internal_error",
          `deleteContact threw: ${err instanceof Error ? err.message : String(err)}`
        )
      );
  }
}

/**
 * Plugin routes for iMessage.
 * Registered with `rawPath: true` to mount at canonical paths.
 *
 * The setup-shaped routes live under `/api/setup/imessage/`. Post-setup
 * data routes (messages, chats, contacts CRUD) remain under `/api/imessage/`.
 */
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
  {
    type: "GET",
    path: "/api/imessage/messages",
    handler: handleMessages,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/imessage/messages",
    handler: handleSendMessage,
    rawPath: true,
  },
  {
    type: "GET",
    path: "/api/imessage/chats",
    handler: handleChats,
    rawPath: true,
  },
  {
    type: "GET",
    path: "/api/imessage/contacts",
    handler: handleListContacts,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/imessage/contacts",
    handler: handleCreateContact,
    rawPath: true,
  },
  {
    type: "PATCH",
    path: "/api/imessage/contacts/:id",
    handler: handleUpdateContact,
    rawPath: true,
  },
  {
    type: "DELETE",
    path: "/api/imessage/contacts/:id",
    handler: handleDeleteContact,
    rawPath: true,
  },
];
