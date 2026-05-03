/**
 * iMessage connector HTTP routes.
 *
 * Exposes the @elizaos/plugin-imessage service state through the Plugin
 * routes API so the dashboard (and future CLIs / third-party integrations)
 * can read and write against macOS Messages.app without each client going
 * straight to chat.db or AppleScript.
 *
 * Routes served (all under `/api/imessage`):
 *
 *   GET    /api/imessage/status         service health + connection state
 *   GET    /api/imessage/messages       newest messages from chat.db
 *   POST   /api/imessage/messages       send a message via Messages.app
 *   GET    /api/imessage/chats          list of chats (DMs + groups)
 *   GET    /api/imessage/contacts       every contact with full detail
 *   POST   /api/imessage/contacts       create a new contact
 *   PATCH  /api/imessage/contacts/:id   update an existing contact
 *   DELETE /api/imessage/contacts/:id   delete a contact
 *
 * Each handler pulls the IMessageService instance off the runtime via
 * `runtime.getService("imessage")` and calls public methods. If the
 * service isn't registered we return 503 with a structured reason so
 * the UI can render an informative empty state.
 *
 * These routes are registered with `rawPath: true` so they mount at their
 * legacy paths without the plugin-name prefix.
 */

import type { IAgentRuntime, Route, RouteRequest, RouteResponse } from "@elizaos/core";

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

function resolveService(runtime: IAgentRuntime): IMessageServiceLike | null {
  const raw = runtime.getService(IMESSAGE_SERVICE_NAME);
  return (raw as unknown as IMessageServiceLike | null | undefined) ?? null;
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

// ── GET /api/imessage/status ────────────────────────────────────────
async function handleStatus(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const service = resolveService(runtime);
  if (!service) {
    res.status(200).json({
      available: false,
      reason: "imessage service not registered",
    });
    return;
  }
  res.status(200).json({
    available: true,
    connected: service.isConnected(),
    ...(service.getStatus?.() ?? {}),
  });
}

// ── GET /api/imessage/messages?limit=N ──────────────────────────────
async function handleMessages(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime
): Promise<void> {
  const service = resolveService(runtime);
  if (!service) {
    res.status(503).json({ error: "imessage service not registered" });
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
  } catch (error) {
    res.status(500).json({
      error: `failed to read messages: ${error instanceof Error ? error.message : String(error)}`,
    });
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
    res.status(503).json({ error: "imessage service not registered" });
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
    res.status(400).json({
      error: "either to or chatId is required",
    });
    return;
  }

  if (!text && !mediaUrl) {
    res.status(400).json({
      error: "either text or mediaUrl is required",
    });
    return;
  }

  try {
    const result = await service.sendMessage(chatId ? `chat_id:${chatId}` : to, text, {
      ...(mediaUrl ? { mediaUrl } : {}),
      ...(typeof body.maxBytes === "number" ? { maxBytes: body.maxBytes } : {}),
    });
    if (!result.success) {
      res.status(500).json({
        error: result.error ?? "failed to send iMessage",
      });
      return;
    }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({
      error: `sendMessage threw: ${error instanceof Error ? error.message : String(error)}`,
    });
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
    res.status(503).json({ error: "imessage service not registered" });
    return;
  }
  try {
    const chats = await service.getChats();
    res.status(200).json({ chats, count: chats.length });
  } catch (error) {
    res.status(500).json({
      error: `failed to read chats: ${error instanceof Error ? error.message : String(error)}`,
    });
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
    res.status(503).json({ error: "imessage service not registered" });
    return;
  }
  try {
    const contacts = await service.listAllContacts();
    res.status(200).json({ contacts, count: contacts.length });
  } catch (error) {
    res.status(500).json({
      error: `failed to read contacts: ${error instanceof Error ? error.message : String(error)}`,
    });
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
    res.status(503).json({ error: "imessage service not registered" });
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
    res.status(400).json({
      error: "at least one of firstName, lastName, phones, or emails is required",
    });
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
      res.status(500).json({
        error:
          "contact creation failed — see server logs. Common cause: Contacts write permission not granted yet.",
      });
      return;
    }
    res.status(201).json({ id, created: true });
  } catch (error) {
    res.status(500).json({
      error: `addContact threw: ${error instanceof Error ? error.message : String(error)}`,
    });
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
    res.status(400).json({ error: "contact id is required in the path" });
    return;
  }
  const service = resolveService(runtime);
  if (!service) {
    res.status(503).json({ error: "imessage service not registered" });
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
      res.status(500).json({
        error:
          "contact update failed — see server logs. Contact may not exist, or write permission may be denied.",
      });
      return;
    }
    res.status(200).json({ id, updated: true });
  } catch (error) {
    res.status(500).json({
      error: `updateContact threw: ${error instanceof Error ? error.message : String(error)}`,
    });
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
    res.status(400).json({ error: "contact id is required in the path" });
    return;
  }
  const service = resolveService(runtime);
  if (!service) {
    res.status(503).json({ error: "imessage service not registered" });
    return;
  }
  try {
    const ok = await service.deleteContact(id);
    if (!ok) {
      res.status(500).json({
        error:
          "contact delete failed — see server logs. Contact may not exist, or write permission may be denied.",
      });
      return;
    }
    res.status(200).json({ id, deleted: true });
  } catch (error) {
    res.status(500).json({
      error: `deleteContact threw: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Plugin routes for iMessage service.
 * Registered with `rawPath: true` to preserve legacy `/api/imessage/*` paths.
 *
 * Note: The PATCH and DELETE routes for `/api/imessage/contacts/:id` use
 * the base `/api/imessage/contacts/` path with `rawPath: true`. The
 * handler extracts the `:id` from req.url internally.
 */
export const imessageSetupRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/imessage/status",
    handler: handleStatus,
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
