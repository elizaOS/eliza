/**
 * Google MCP Server - Gmail, Calendar, Contacts
 *
 * Standalone MCP endpoint for Google tools with per-org OAuth.
 * Config: { "type": "streamable-http", "url": "/api/mcps/google/streamable-http" }
 */

import type { NextRequest } from "next/server";
import { logger } from "@/lib/utils/logger";
import { oauthService } from "@/lib/services/oauth";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { authContextStorage } from "@/app/api/mcp/lib/context";

export const maxDuration = 60;

interface McpHandlerResponse {
  status: number;
  headers?: Headers;
  text?: () => Promise<string>;
}

function isMcpHandlerResponse(resp: unknown): resp is McpHandlerResponse {
  return typeof resp === "object" && resp !== null && typeof (resp as McpHandlerResponse).status === "number";
}

// Lazy-loaded handler
let mcpHandler: ((req: Request) => Promise<Response>) | null = null;

async function getGoogleMcpHandler() {
  if (mcpHandler) return mcpHandler;

  const { createMcpHandler } = await import("mcp-handler");
  const { z } = await import("zod3");

  async function getGoogleToken(organizationId: string): Promise<string> {
    const result = await oauthService.getValidTokenByPlatform({ organizationId, platform: "google" });
    return result.accessToken;
  }

  async function googleFetch(orgId: string, url: string, options: RequestInit = {}): Promise<Response> {
    const token = await getGoogleToken(orgId);
    const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
    if (!response.ok && response.status !== 204) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || `Google API error: ${response.status}`);
    }
    return response;
  }

  function extractBody(payload: any): string {
    if (payload?.body?.data) return Buffer.from(payload.body.data, "base64").toString("utf-8");
    if (payload?.parts && Array.isArray(payload.parts)) {
      // Prefer text/plain over text/html
      for (const mime of ["text/plain", "text/html"]) {
        for (const part of payload.parts) {
          if (part.mimeType === mime && part.body?.data) return Buffer.from(part.body.data, "base64").toString("utf-8");
          if (part.mimeType?.startsWith("multipart/")) { const n = extractBody(part); if (n) return n; }
        }
      }
      // Fallback: try any part that has body content
      for (const part of payload.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
    return "";
  }

  function getOrgId(): string {
    const ctx = authContextStorage.getStore();
    if (!ctx) throw new Error("Not authenticated");
    return ctx.user.organization_id;
  }

  function jsonResult(data: object) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  }

  /** Sanitize email header values to prevent CRLF injection attacks. */
  function sanitizeHeaderValue(value: string): string {
    return value.replace(/[\r\n]/g, "");
  }

  function errorResult(msg: string) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true };
  }

  mcpHandler = createMcpHandler(
    (server) => {
      server.tool("google_status", "Check Google OAuth connection status", {}, async () => {
        try {
          const orgId = getOrgId();
          const connections = await oauthService.listConnections({ organizationId: orgId, platform: "google" });
          const active = connections.find((c) => c.status === "active");
          return jsonResult(active ? { connected: true, email: active.email, scopes: active.scopes } : { connected: false });
        } catch (e) { return errorResult(e instanceof Error ? e.message : "Failed"); }
      });

      server.tool("gmail_send", "Send email via Gmail", {
        to: z.string().describe("Recipient(s)"),
        subject: z.string().describe("Subject"),
        body: z.string().describe("Body"),
        isHtml: z.boolean().optional().default(false),
        cc: z.string().optional(),
        bcc: z.string().optional(),
      }, async ({ to, subject, body, isHtml = false, cc, bcc }) => {
        try {
          const orgId = getOrgId();
          const headers = [`To: ${sanitizeHeaderValue(to)}`, `Subject: ${sanitizeHeaderValue(subject)}`, `Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset=utf-8`, ...(cc ? [`Cc: ${sanitizeHeaderValue(cc)}`] : []), ...(bcc ? [`Bcc: ${sanitizeHeaderValue(bcc)}`] : [])];
          const raw = Buffer.from([...headers, "", body].join("\r\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          const res = await googleFetch(orgId, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw }) });
          const result = await res.json();
          logger.info("[GoogleMCP] Email sent", { messageId: result.id, to });
          return jsonResult({ success: true, messageId: result.id, threadId: result.threadId });
        } catch (e) { return errorResult(e instanceof Error ? e.message : "Failed"); }
      });

      server.tool("gmail_list", "List emails from Gmail", {
        query: z.string().optional().describe("Search query"),
        maxResults: z.number().int().min(1).max(50).optional().default(10),
      }, async ({ query, maxResults = 10 }) => {
        try {
          const orgId = getOrgId();
          const params = new URLSearchParams({ maxResults: String(maxResults) });
          if (query) params.set("q", query);
          const listRes = await googleFetch(orgId, `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`);
          const { messages = [] } = await listRes.json();
          if (messages.length === 0) return jsonResult({ success: true, messages: [], count: 0 });
          const details = await Promise.all(messages.slice(0, maxResults).map(async (m: { id: string }) => {
            try { return await (await googleFetch(orgId, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)).json(); }
            catch { return null; }
          }));
          const formatted = details.filter(Boolean).map((d: any) => ({ id: d.id, snippet: d.snippet, headers: Object.fromEntries(d.payload?.headers?.map((h: any) => [h.name, h.value]) || []) }));
          return jsonResult({ success: true, messages: formatted, count: formatted.length });
        } catch (e) { return errorResult(e instanceof Error ? e.message : "Failed"); }
      });

      server.tool("gmail_read", "Read email by ID", { messageId: z.string().describe("Message ID") }, async ({ messageId }) => {
        try {
          const orgId = getOrgId();
          const res = await googleFetch(orgId, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`);
          const msg = await res.json();
          return jsonResult({ success: true, id: msg.id, snippet: msg.snippet, headers: Object.fromEntries(msg.payload?.headers?.map((h: any) => [h.name, h.value]) || []), body: extractBody(msg.payload) });
        } catch (e) { return errorResult(e instanceof Error ? e.message : "Failed"); }
      });

      server.tool("calendar_list_events", "List upcoming calendar events", {
        maxResults: z.number().int().min(1).max(50).optional().default(10),
        timeMin: z.string().optional(),
        timeMax: z.string().optional(),
      }, async ({ maxResults = 10, timeMin, timeMax }) => {
        try {
          const orgId = getOrgId();
          const params = new URLSearchParams({ maxResults: String(maxResults), timeMin: timeMin || new Date().toISOString(), singleEvents: "true", orderBy: "startTime" });
          if (timeMax) params.set("timeMax", timeMax);
          const res = await googleFetch(orgId, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
          const { items = [] } = await res.json();
          const events = items.map((e: any) => ({ id: e.id, summary: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: e.location }));
          return jsonResult({ success: true, events, count: events.length });
        } catch (e) { return errorResult(e instanceof Error ? e.message : "Failed"); }
      });

      server.tool("calendar_create_event", "Create calendar event", {
        summary: z.string().describe("Event title"),
        start: z.string().describe("Start (ISO 8601)"),
        end: z.string().describe("End (ISO 8601)"),
        description: z.string().optional(),
        location: z.string().optional(),
      }, async ({ summary, start, end, description, location }) => {
        try {
          const orgId = getOrgId();
          const event = { summary, start: { dateTime: start }, end: { dateTime: end }, ...(description && { description }), ...(location && { location }) };
          const res = await googleFetch(orgId, "https://www.googleapis.com/calendar/v3/calendars/primary/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) });
          const result = await res.json();
          logger.info("[GoogleMCP] Event created", { eventId: result.id });
          return jsonResult({ success: true, eventId: result.id, htmlLink: result.htmlLink });
        } catch (e) { return errorResult(e instanceof Error ? e.message : "Failed"); }
      });

      server.tool("contacts_list", "List Google contacts", {
        pageSize: z.number().int().min(1).max(100).optional().default(20),
        query: z.string().optional(),
      }, async ({ pageSize = 20, query }) => {
        try {
          const orgId = getOrgId();
          const params = new URLSearchParams({ pageSize: String(pageSize), personFields: "names,emailAddresses,phoneNumbers" });
          let url = "https://people.googleapis.com/v1/people/me/connections";
          if (query) { url = "https://people.googleapis.com/v1/people:searchContacts"; params.set("query", query); params.set("readMask", "names,emailAddresses,phoneNumbers"); }
          const res = await googleFetch(orgId, `${url}?${params}`);
          const data = await res.json();
          const contacts = (data.connections || data.results || []).map((p: any) => { const person = p.person || p; return { name: person.names?.[0]?.displayName, email: person.emailAddresses?.[0]?.value, phone: person.phoneNumbers?.[0]?.value }; });
          return jsonResult({ success: true, contacts, count: contacts.length });
        } catch (e) { return errorResult(e instanceof Error ? e.message : "Failed"); }
      });
    },
    { capabilities: { tools: {} } },
    { basePath: "/api/mcps/google", maxDuration: 60 },
  );

  return mcpHandler;
}

async function handleRequest(req: NextRequest): Promise<Response> {
  try {
    const authResult = await requireAuthOrApiKeyWithOrg(req);
    const handler = await getGoogleMcpHandler();
    const mcpResponse = await authContextStorage.run(authResult, () => handler(req as Request));

    if (!mcpResponse || !isMcpHandlerResponse(mcpResponse)) {
      return new Response(JSON.stringify({ error: "invalid_response" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }

    const bodyText = mcpResponse.text ? await mcpResponse.text() : "";
    const headers: Record<string, string> = {};
    mcpResponse.headers?.forEach((v: string, k: string) => { headers[k] = v; });

    return new Response(bodyText, { status: mcpResponse.status, headers });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`[GoogleMCP] ${msg}`);
    const isAuth = msg.includes("API key") || msg.includes("auth") || msg.includes("Unauthorized");
    return new Response(JSON.stringify({ error: isAuth ? "authentication_required" : "internal_error", message: msg }), { status: isAuth ? 401 : 500, headers: { "Content-Type": "application/json" } });
  }
}

export const GET = handleRequest;
export const POST = handleRequest;
export const DELETE = handleRequest;
