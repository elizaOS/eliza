/**
 * Google MCP Tools - Gmail, Calendar, Contacts
 * Uses per-organization OAuth tokens via oauthService.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod3";
import { logger } from "@/lib/utils/logger";
import { oauthService } from "@/lib/services/oauth";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

async function getGoogleToken(): Promise<string> {
  const { user } = getAuthContext();
  try {
    const result = await oauthService.getValidTokenByPlatform({
      organizationId: user.organization_id,
      platform: "google",
    });
    return result.accessToken;
  } catch (error) {
    logger.warn("[GoogleMCP] Failed to get token", {
      organizationId: user.organization_id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Google account not connected. Connect in Settings > Connections.");
  }
}

async function googleFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getGoogleToken();
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
  });

  if (!response.ok && response.status !== 204) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Google API error: ${response.status}`);
  }
  return response;
}

function errMsg(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Sanitize email header values to prevent CRLF injection attacks. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

/** Recursively extract text body from Gmail payload (handles nested multipart). */
function extractBody(payload: any): string {
  if (payload?.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  if (payload?.parts && Array.isArray(payload.parts)) {
    // Prefer text/plain over text/html
    for (const mimeType of ["text/plain", "text/html"]) {
      for (const part of payload.parts) {
        if (part.mimeType === mimeType && part.body?.data) {
          return Buffer.from(part.body.data, "base64").toString("utf-8");
        }
        if (part.mimeType?.startsWith("multipart/")) {
          const nested = extractBody(part);
          if (nested) return nested;
        }
      }
    }
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return "";
}

export function registerGoogleTools(server: McpServer): void {
  server.registerTool(
    "google_status",
    {
      description: "Check Google OAuth connection status and permissions",
      inputSchema: {},
    },
    async () => {
      try {
        const { user } = getAuthContext();
        const connections = await oauthService.listConnections({
          organizationId: user.organization_id,
          platform: "google",
        });

        const active = connections.find((c) => c.status === "active");
        if (!active) {
          return jsonResponse({
            connected: false,
            message: "Google not connected. Connect in Settings > Connections.",
          });
        }

        return jsonResponse({
          connected: true,
          email: active.email,
          scopes: active.scopes,
          linkedAt: active.linkedAt,
        });
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to check status"));
      }
    },
  );

  server.registerTool(
    "gmail_send",
    {
      description: "Send email via Gmail",
      inputSchema: {
        to: z.string().describe("Recipient(s), comma-separated"),
        subject: z.string().describe("Subject line"),
        body: z.string().describe("Email body"),
        isHtml: z.boolean().optional().default(false).describe("HTML format"),
        cc: z.string().optional().describe("CC recipients"),
        bcc: z.string().optional().describe("BCC recipients"),
      },
    },
    async ({ to, subject, body, isHtml = false, cc, bcc }) => {
      try {
        const headers = [
          `To: ${sanitizeHeaderValue(to)}`,
          `Subject: ${sanitizeHeaderValue(subject)}`,
          `Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset=utf-8`,
          ...(cc ? [`Cc: ${sanitizeHeaderValue(cc)}`] : []),
          ...(bcc ? [`Bcc: ${sanitizeHeaderValue(bcc)}`] : []),
        ];

        const message = [...headers, "", body].join("\r\n");
        const raw = Buffer.from(message)
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");

        const response = await googleFetch(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ raw }),
          },
        );

        const result = await response.json();
        logger.info("[GoogleMCP] Email sent", { messageId: result.id, to });

        return jsonResponse({
          success: true,
          messageId: result.id,
          threadId: result.threadId,
        });
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to send email"));
      }
    },
  );

  server.registerTool(
    "gmail_list",
    {
      description: "List emails from Gmail",
      inputSchema: {
        query: z.string().optional().describe("Search query (e.g., 'is:unread', 'from:x@y.com')"),
        maxResults: z.number().int().min(1).max(50).optional().default(10).describe("Max emails (default: 10)"),
        labelIds: z.string().optional().describe("Label IDs, comma-separated"),
      },
    },
    async ({ query, maxResults = 10, labelIds }) => {
      try {
        const params = new URLSearchParams({ maxResults: String(maxResults) });
        if (query) params.set("q", query);
        if (labelIds) {
          // Gmail API expects repeated labelIds params, not comma-separated
          labelIds.split(",").forEach((id) => params.append("labelIds", id.trim()));
        }

        const listResponse = await googleFetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
        );
        const { messages = [] } = await listResponse.json();

        if (messages.length === 0) {
          return jsonResponse({ success: true, messages: [], count: 0 });
        }

        const messageIds = messages.slice(0, maxResults).map((m: { id: string }) => m.id);
        const results = await Promise.all(
          messageIds.map(async (id: string) => {
            try {
              const res = await googleFetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
              );
              return { ok: true, data: await res.json() };
            } catch {
              return { ok: false, id };
            }
          }),
        );

        const successes = results.filter((r) => r.ok).map((r) => r.data);
        const failCount = results.filter((r) => !r.ok).length;

        if (failCount > 0) {
          logger.warn("[GoogleMCP] Some messages failed to fetch", { failed: failCount, total: messageIds.length });
        }

        const formatted = successes.map((d: any) => ({
          id: d.id,
          threadId: d.threadId,
          snippet: d.snippet,
          labelIds: d.labelIds,
          headers: Object.fromEntries(
            d.payload?.headers?.map((h: { name: string; value: string }) => [h.name, h.value]) || [],
          ),
          internalDate: d.internalDate ? new Date(parseInt(d.internalDate)).toISOString() : undefined,
        }));

        return jsonResponse({
          success: true,
          messages: formatted,
          count: formatted.length,
          ...(failCount > 0 && { failedToFetch: failCount }),
        });
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list emails"));
      }
    },
  );

  server.registerTool(
    "gmail_read",
    {
      description: "Read email by ID",
      inputSchema: {
        messageId: z.string().describe("Gmail message ID"),
        format: z.enum(["full", "metadata", "minimal"]).optional().default("full"),
      },
    },
    async ({ messageId, format = "full" }) => {
      try {
        const response = await googleFetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=${format}`,
        );
        const msg = await response.json();

        const headers = Object.fromEntries(
          msg.payload?.headers?.map((h: { name: string; value: string }) => [h.name, h.value]) || [],
        );

        return jsonResponse({
          success: true,
          id: msg.id,
          threadId: msg.threadId,
          labelIds: msg.labelIds,
          snippet: msg.snippet,
          headers,
          body: extractBody(msg.payload),
          internalDate: msg.internalDate ? new Date(parseInt(msg.internalDate)).toISOString() : undefined,
        });
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to read email"));
      }
    },
  );

  server.registerTool(
    "calendar_list_events",
    {
      description: "List upcoming calendar events",
      inputSchema: {
        maxResults: z.number().int().min(1).max(50).optional().default(10),
        timeMin: z.string().optional().describe("Start filter (ISO 8601)"),
        timeMax: z.string().optional().describe("End filter (ISO 8601)"),
        calendarId: z.string().optional().default("primary"),
        query: z.string().optional().describe("Search query"),
      },
    },
    async ({ maxResults = 10, timeMin, timeMax, calendarId = "primary", query }) => {
      try {
        const params = new URLSearchParams({
          maxResults: String(maxResults),
          timeMin: timeMin || new Date().toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
        });
        if (timeMax) params.set("timeMax", timeMax);
        if (query) params.set("q", query);

        const response = await googleFetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
        );
        const { items = [] } = await response.json();

        const events = items.map((e: any) => ({
          id: e.id,
          summary: e.summary,
          description: e.description,
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
          location: e.location,
          status: e.status,
          htmlLink: e.htmlLink,
          attendees: e.attendees?.map((a: any) => ({
            email: a.email,
            displayName: a.displayName,
            responseStatus: a.responseStatus,
          })),
          organizer: e.organizer,
        }));

        return jsonResponse({ success: true, events, count: events.length });
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list events"));
      }
    },
  );

  server.registerTool(
    "calendar_create_event",
    {
      description: "Create calendar event",
      inputSchema: {
        summary: z.string().describe("Event title"),
        start: z.string().describe("Start time (ISO 8601)"),
        end: z.string().describe("End time (ISO 8601)"),
        description: z.string().optional(),
        location: z.string().optional(),
        attendees: z.array(z.string().email()).optional(),
        calendarId: z.string().optional().default("primary"),
        sendUpdates: z.enum(["all", "externalOnly", "none"]).optional().default("all"),
      },
    },
    async ({ summary, start, end, description, location, attendees, calendarId = "primary", sendUpdates = "all" }) => {
      try {
        const event: Record<string, unknown> = {
          summary,
          start: { dateTime: start },
          end: { dateTime: end },
          ...(description && { description }),
          ...(location && { location }),
          ...(attendees?.length && { attendees: attendees.map((email) => ({ email })) }),
        };

        const response = await googleFetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=${sendUpdates}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(event),
          },
        );

        const result = await response.json();
        logger.info("[GoogleMCP] Event created", { eventId: result.id, summary });

        return jsonResponse({
          success: true,
          eventId: result.id,
          htmlLink: result.htmlLink,
          status: result.status,
        });
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to create event"));
      }
    },
  );

  server.registerTool(
    "calendar_update_event",
    {
      description: "Update calendar event",
      inputSchema: {
        eventId: z.string().describe("Event ID"),
        summary: z.string().optional(),
        start: z.string().optional().describe("ISO 8601"),
        end: z.string().optional().describe("ISO 8601"),
        description: z.string().optional(),
        location: z.string().optional(),
        calendarId: z.string().optional().default("primary"),
        sendUpdates: z.enum(["all", "externalOnly", "none"]).optional().default("all"),
      },
    },
    async ({ eventId, summary, start, end, description, location, calendarId = "primary", sendUpdates = "all" }) => {
      try {
        const baseUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

        const existing = await (await googleFetch(baseUrl)).json();

        // When updating start/end, remove 'date' property if setting 'dateTime'
        // (Google Calendar uses 'date' for all-day events, 'dateTime' for timed events - can't have both)
        const updated = {
          ...existing,
          ...(summary && { summary }),
          ...(description !== undefined && { description }),
          ...(location !== undefined && { location }),
          ...(start && { start: { ...existing.start, dateTime: start, date: undefined } }),
          ...(end && { end: { ...existing.end, dateTime: end, date: undefined } }),
        };

        const response = await googleFetch(`${baseUrl}?sendUpdates=${sendUpdates}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updated),
        });

        const result = await response.json();
        return jsonResponse({
          success: true,
          eventId: result.id,
          htmlLink: result.htmlLink,
          updated: result.updated,
        });
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to update event"));
      }
    },
  );

  server.registerTool(
    "calendar_delete_event",
    {
      description: "Delete calendar event",
      inputSchema: {
        eventId: z.string().describe("Event ID"),
        calendarId: z.string().optional().default("primary"),
        sendUpdates: z.enum(["all", "externalOnly", "none"]).optional().default("all"),
      },
    },
    async ({ eventId, calendarId = "primary", sendUpdates = "all" }) => {
      try {
        await googleFetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`,
          { method: "DELETE" },
        );

        logger.info("[GoogleMCP] Event deleted", { eventId });
        return jsonResponse({ success: true });
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to delete event"));
      }
    },
  );

  server.registerTool(
    "contacts_list",
    {
      description: "List Google contacts",
      inputSchema: {
        pageSize: z.number().int().min(1).max(100).optional().default(20),
        query: z.string().optional().describe("Search query"),
      },
    },
    async ({ pageSize = 20, query }) => {
      try {
        const params = new URLSearchParams({
          pageSize: String(pageSize),
          personFields: "names,emailAddresses,phoneNumbers,organizations",
        });

        let url = "https://people.googleapis.com/v1/people/me/connections";
        if (query) {
          url = "https://people.googleapis.com/v1/people:searchContacts";
          params.set("query", query);
          params.set("readMask", "names,emailAddresses,phoneNumbers,organizations");
        }

        const response = await googleFetch(`${url}?${params}`);
        const data = await response.json();
        const items = data.connections || data.results || [];

        const contacts = items.map((person: any) => {
          const p = person.person || person;
          return {
            resourceName: p.resourceName,
            name: p.names?.[0]?.displayName,
            email: p.emailAddresses?.[0]?.value,
            phone: p.phoneNumbers?.[0]?.value,
            organization: p.organizations?.[0]?.name,
          };
        });

        return jsonResponse({ success: true, contacts, count: contacts.length });
      } catch (error) {
        return errorResponse(errMsg(error, "Failed to list contacts"));
      }
    },
  );
}
