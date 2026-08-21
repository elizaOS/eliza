/**
 * Legacy iMessage HTTP routes expose service health, message history, chats,
 * and Contacts CRUD to hosts that still use raw Node request handlers. Service
 * access stays structural so the connector remains dynamically loadable.
 */

import type http from "node:http";
import type { RouteHelpers, RouteRequestMeta } from "@elizaos/core";
import { z } from "zod";
import { parseIMessageContactId } from "../contact-path.js";

/**
 * Route helper options accepted by the host. This plugin depends on core, not
 * the agent package, so the route file stays usable without importing agent
 * internals.
 */
export interface ReadJsonBodyOptions {
  maxBytes?: number;
  requireObject?: boolean;
  readErrorStatus?: number;
  nonObjectStatus?: number;
  parseErrorStatus?: number;
  readErrorMessage?: string;
  nonObjectMessage?: string;
  parseErrorMessage?: string;
}

/**
 * Narrow structural type for the IMessageService methods we call from
 * this route file. Declared here rather than imported from the plugin
 * package so Eliza doesn't take a direct build-time dependency on
 * @elizaos/plugin-imessage — the plugin is loaded dynamically at
 * runtime via NODE_PATH and this file stays compile-safe even when the
 * plugin is absent.
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
    }>
  >;
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

export interface IMessageRouteState {
  /**
   * The running AgentRuntime (or a test runtime). Typed loosely as
   * `unknown` so this route file doesn't re-declare core's stricter
   * generic getService signature — we narrow the result inside
   * resolveService via an unknown cast. Optional so route files
   * tolerate the boot window where the runtime hasn't finished
   * registering services yet.
   */
  runtime?: {
    getService(type: string): unknown;
  };
}

const IMESSAGE_SERVICE_NAME = "imessage";
const MAX_BODY_BYTES = 256 * 1024; // Contacts payloads are tiny; cap aggressively.
const DEFAULT_MESSAGES_LIMIT = 50;
const MAX_MESSAGES_LIMIT = 500;
const IMessageMessagesLimitSchema = z
  .string()
  .trim()
  .regex(/^[+-]?\d+$/)
  .transform(Number)
  .refine(Number.isSafeInteger)
  .transform((value) => Math.min(Math.max(1, value), MAX_MESSAGES_LIMIT));

function parseMessagesLimit(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") {
    return DEFAULT_MESSAGES_LIMIT;
  }
  const parsed = IMessageMessagesLimitSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function resolveService(state: IMessageRouteState): IMessageServiceLike | null {
  if (!state.runtime) return null;
  const raw = state.runtime.getService(IMESSAGE_SERVICE_NAME);
  return (raw as IMessageServiceLike | null | undefined) ?? null;
}

/**
 * Route handler entry point. Returns `true` when a route matched and
 * the response has been written; returns `false` so the caller can
 * continue to other route handlers (mirrors the handleWhatsAppRoute /
 * handleWalletRoute pattern used elsewhere in this codebase).
 */
export async function handleIMessageRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: IMessageRouteState,
  helpers: RouteHelpers
): Promise<boolean> {
  if (!pathname.startsWith("/api/imessage")) return false;

  const meta: RouteRequestMeta = { req, res, method, pathname };

  // ── GET /api/imessage/status ──────────────────────────────────────
  if (method === "GET" && pathname === "/api/imessage/status") {
    const service = resolveService(state);
    if (!service) {
      helpers.json(res, {
        available: false,
        reason: "imessage service not registered",
      });
      return true;
    }
    helpers.json(res, {
      available: true,
      connected: service.isConnected(),
      ...(service.getStatus?.() ?? {}),
    });
    return true;
  }

  // ── GET /api/imessage/messages?limit=N ────────────────────────────
  if (method === "GET" && pathname === "/api/imessage/messages") {
    const service = resolveService(state);
    if (!service) {
      helpers.error(res, "imessage service not registered", 503);
      return true;
    }
    const url = new URL(req.url ?? pathname, "http://localhost");
    const limit = parseMessagesLimit(url.searchParams.get("limit"));
    if (limit === null) {
      helpers.error(res, "limit must be an integer", 400);
      return true;
    }
    try {
      const messages = await service.getRecentMessages(limit);
      helpers.json(res, { messages, count: messages.length });
    } catch (error) {
      helpers.error(
        res,
        `failed to read messages: ${error instanceof Error ? error.message : String(error)}`,
        500
      );
    }
    return true;
  }

  // ── GET /api/imessage/chats ───────────────────────────────────────
  if (method === "GET" && pathname === "/api/imessage/chats") {
    const service = resolveService(state);
    if (!service) {
      helpers.error(res, "imessage service not registered", 503);
      return true;
    }
    try {
      const chats = await service.getChats();
      helpers.json(res, { chats, count: chats.length });
    } catch (error) {
      helpers.error(
        res,
        `failed to read chats: ${error instanceof Error ? error.message : String(error)}`,
        500
      );
    }
    return true;
  }

  // ── GET /api/imessage/contacts ────────────────────────────────────
  if (method === "GET" && pathname === "/api/imessage/contacts") {
    const service = resolveService(state);
    if (!service) {
      helpers.error(res, "imessage service not registered", 503);
      return true;
    }
    try {
      const contacts = await service.listAllContacts();
      helpers.json(res, { contacts, count: contacts.length });
    } catch (error) {
      helpers.error(
        res,
        `failed to read contacts: ${error instanceof Error ? error.message : String(error)}`,
        500
      );
    }
    return true;
  }

  // ── POST /api/imessage/contacts ───────────────────────────────────
  if (method === "POST" && pathname === "/api/imessage/contacts") {
    const service = resolveService(state);
    if (!service) {
      helpers.error(res, "imessage service not registered", 503);
      return true;
    }
    const body = await helpers.readJsonBody<{
      firstName?: string;
      lastName?: string;
      phones?: Array<{ label?: string; value: string }>;
      emails?: Array<{ label?: string; value: string }>;
    }>(req, res, { maxBytes: MAX_BODY_BYTES });
    if (!body) return true; // helpers.readJsonBody has already sent the error.

    if (!body.firstName && !body.lastName && !body.phones?.length && !body.emails?.length) {
      helpers.error(res, "at least one of firstName, lastName, phones, or emails is required", 400);
      return true;
    }

    try {
      const id = await service.addContact({
        firstName: body.firstName,
        lastName: body.lastName,
        phones: body.phones,
        emails: body.emails,
      });
      if (!id) {
        helpers.error(
          res,
          "contact creation failed — see server logs. Common cause: Contacts write permission not granted yet.",
          500
        );
        return true;
      }
      helpers.json(res, { id, created: true }, 201);
    } catch (error) {
      helpers.error(
        res,
        `addContact threw: ${error instanceof Error ? error.message : String(error)}`,
        500
      );
    }
    return true;
  }

  // ── PATCH /api/imessage/contacts/:id ──────────────────────────────
  if (method === "PATCH" && pathname.startsWith("/api/imessage/contacts/")) {
    const parsedId = parseIMessageContactId(pathname);
    if (!parsedId.ok) {
      helpers.error(
        res,
        parsedId.reason === "malformed"
          ? "Invalid contact id: malformed URL encoding"
          : "contact id is required in the path",
        400
      );
      return true;
    }
    const id = parsedId.id;
    const service = resolveService(state);
    if (!service) {
      helpers.error(res, "imessage service not registered", 503);
      return true;
    }
    const body = await helpers.readJsonBody<{
      firstName?: string;
      lastName?: string;
      addPhones?: Array<{ label?: string; value: string }>;
      removePhones?: string[];
      addEmails?: Array<{ label?: string; value: string }>;
      removeEmails?: string[];
    }>(req, res, { maxBytes: MAX_BODY_BYTES });
    if (!body) return true;

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
        helpers.error(
          res,
          "contact update failed — see server logs. Contact may not exist, or write permission may be denied.",
          500
        );
        return true;
      }
      helpers.json(res, { id, updated: true });
    } catch (error) {
      helpers.error(
        res,
        `updateContact threw: ${error instanceof Error ? error.message : String(error)}`,
        500
      );
    }
    return true;
  }

  // ── DELETE /api/imessage/contacts/:id ─────────────────────────────
  if (method === "DELETE" && pathname.startsWith("/api/imessage/contacts/")) {
    const parsedId = parseIMessageContactId(pathname);
    if (!parsedId.ok) {
      helpers.error(
        res,
        parsedId.reason === "malformed"
          ? "Invalid contact id: malformed URL encoding"
          : "contact id is required in the path",
        400
      );
      return true;
    }
    const id = parsedId.id;
    const service = resolveService(state);
    if (!service) {
      helpers.error(res, "imessage service not registered", 503);
      return true;
    }
    try {
      const ok = await service.deleteContact(id);
      if (!ok) {
        helpers.error(
          res,
          "contact delete failed — see server logs. Contact may not exist, or write permission may be denied.",
          500
        );
        return true;
      }
      helpers.json(res, { id, deleted: true });
    } catch (error) {
      helpers.error(
        res,
        `deleteContact threw: ${error instanceof Error ? error.message : String(error)}`,
        500
      );
    }
    return true;
  }

  // Path starts with /api/imessage but none of the above matched.
  void meta; // reserved for future telemetry spans
  return false;
}
