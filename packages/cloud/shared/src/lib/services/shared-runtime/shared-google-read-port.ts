/**
 * Server-owned, read-only Google seam. Not registered in Shared until the
 * hosting boundary supplies owner scope and explicit private-context consent.
 */
import { ElizaError } from "@elizaos/core";
import {
  fetchManagedGoogleCalendarFeed,
  fetchManagedGoogleGmailSearch,
  getManagedGoogleConnectorStatus,
  initiateManagedGoogleConnection,
  readManagedGoogleGmailMessage,
} from "../agent-google-connector";

const google = {
  fetchManagedGoogleCalendarFeed,
  fetchManagedGoogleGmailSearch,
  getManagedGoogleConnectorStatus,
  initiateManagedGoogleConnection,
  readManagedGoogleGmailMessage,
};

export type SharedGoogleReadRequest =
  | { kind: "gmail_search"; query: string }
  | { kind: "gmail_message"; messageId: string }
  | { kind: "calendar"; timeMin: string; timeMax: string; timeZone: string };

function bounded(value: string, maximum: number): string {
  const result = value.trim();
  if (!result || result.length > maximum || /[\p{C}]/u.test(result)) {
    throw new ElizaError("SHARED_GOOGLE_INVALID_INPUT", {
      code: "SHARED_GOOGLE_INVALID_INPUT",
    });
  }
  return result;
}

function requireCompleteText(value: string, maximum: number, field: string): void {
  if (value.length > maximum) {
    throw new ElizaError(
      `Selected Google ${field} exceeds ${maximum} characters. No partial content was returned. Narrow the selection or choose a smaller item.`,
      { code: "SHARED_GOOGLE_CONTENT_LIMIT_EXCEEDED" },
    );
  }
}

function requirePageLimit(count: number, maximum: number): void {
  if (count > maximum) {
    throw new ElizaError(
      "Google returned more records than the requested page limit. No partial result was returned. Narrow the selection.",
      { code: "SHARED_GOOGLE_CONTENT_LIMIT_EXCEEDED" },
    );
  }
}

function validateReadRequest(value: unknown): SharedGoogleReadRequest {
  if (!value || typeof value !== "object")
    throw new ElizaError("SHARED_GOOGLE_INVALID_INPUT", {
      code: "SHARED_GOOGLE_INVALID_INPUT",
    });
  const request = value as Record<string, unknown>;
  if (request.kind === "gmail_search" && typeof request.query === "string") {
    return { kind: "gmail_search", query: bounded(request.query, 256) };
  }
  if (request.kind === "gmail_message" && typeof request.messageId === "string") {
    return {
      kind: "gmail_message",
      messageId: bounded(request.messageId, 256),
    };
  }
  if (
    request.kind === "calendar" &&
    typeof request.timeMin === "string" &&
    typeof request.timeMax === "string" &&
    typeof request.timeZone === "string"
  ) {
    const start = Date.parse(request.timeMin),
      end = Date.parse(request.timeMax);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new ElizaError("SHARED_GOOGLE_CALENDAR_WINDOW_REQUIRED", {
        code: "SHARED_GOOGLE_CALENDAR_WINDOW_REQUIRED",
      });
    }
    return {
      kind: "calendar",
      timeMin: new Date(start).toISOString(),
      timeMax: new Date(end).toISOString(),
      timeZone: bounded(request.timeZone, 100),
    };
  }
  throw new ElizaError("SHARED_GOOGLE_INVALID_INPUT", {
    code: "SHARED_GOOGLE_INVALID_INPUT",
  });
}

export function createSharedGoogleReadPort(
  owner: {
    organizationId: string;
    userId: string;
    /** Selected by the authenticated owner, never inferred from most-recent use. */
    grantId?: string;
    /** Hosting boundary must reject unapproved private-data/model-context access. */
    authorizePrivateRead: (request: SharedGoogleReadRequest) => Promise<void>;
  },
  deps: typeof google = google,
) {
  const grantId = owner.grantId;
  const scope = {
    organizationId: owner.organizationId,
    userId: owner.userId,
    side: "owner" as const,
  };
  return {
    /** Call only after an owned user asks to connect; this creates OAuth state. */
    connect: () =>
      deps.initiateManagedGoogleConnection({
        ...scope,
        capabilities: ["google.basic_identity", "google.gmail.triage", "google.calendar.read"],
        redirectUrl: "/cloud/connectors",
        personalContextPurpose: "personal_google_context_v1",
      }),
    async read(input: unknown) {
      const request = validateReadRequest(input);
      if (!grantId)
        throw new ElizaError("SHARED_GOOGLE_EXPLICIT_GRANT_REQUIRED", {
          code: "SHARED_GOOGLE_EXPLICIT_GRANT_REQUIRED",
        });
      await owner.authorizePrivateRead(request);
      const selected = {
        ...scope,
        grantId,
        personalContextRead: true as const,
      };
      const status = await deps.getManagedGoogleConnectorStatus(selected);
      const capability =
        request.kind === "calendar" ? "google.calendar.read" : "google.gmail.triage";
      if (
        !status.connected ||
        status.connectionId !== grantId ||
        !status.grantedCapabilities.includes(capability)
      ) {
        throw new ElizaError("SHARED_GOOGLE_READ_NOT_GRANTED", {
          code: "SHARED_GOOGLE_READ_NOT_GRANTED",
        });
      }
      if (request.kind === "gmail_search") {
        // Cost: one list page and at most five metadata reads; no inbox drain.
        const result = await deps.fetchManagedGoogleGmailSearch({
          ...selected,
          query: request.query,
          maxResults: 5,
        });
        requirePageLimit(result.messages.length, 5);
        for (const message of result.messages) {
          requireCompleteText(message.subject, 256, "message subject");
          requireCompleteText(message.from, 256, "message sender");
          requireCompleteText(message.snippet, 512, "message snippet");
        }
        const hasMore = Boolean(result.nextPageToken);
        return {
          kind: "private_google_gmail_search" as const,
          untrustedContent: true as const,
          observedAt: result.syncedAt,
          hasMore,
          truncated: hasMore,
          messages: result.messages.map((message) => ({
            id: message.externalId,
            subject: message.subject,
            from: message.from,
            snippet: message.snippet,
            receivedAt: message.receivedAt,
          })),
        };
      }
      if (request.kind === "gmail_message") {
        const result = await deps.readManagedGoogleGmailMessage({
          ...selected,
          messageId: bounded(request.messageId, 256),
        });
        requireCompleteText(result.message.subject, 256, "message subject");
        requireCompleteText(result.bodyText, 8_000, "message body");
        return {
          kind: "private_google_gmail_message" as const,
          untrustedContent: true as const,
          id: result.message.externalId,
          subject: result.message.subject,
          bodyText: result.bodyText,
          truncated: false,
        };
      }
      const result = await deps.fetchManagedGoogleCalendarFeed({
        ...selected,
        calendarId: "primary",
        // Cost: one page, at most twenty events, independent of window length.
        limits: { maxEvents: 20, maxPages: 1 },
        timeMin: request.timeMin,
        timeMax: request.timeMax,
        timeZone: request.timeZone,
      });
      requirePageLimit(result.events.length, 20);
      for (const event of result.events) {
        requireCompleteText(event.title, 256, "event title");
        requireCompleteText(event.location, 256, "event location");
      }
      return {
        kind: "private_google_calendar" as const,
        untrustedContent: true as const,
        observedAt: result.syncedAt,
        hasMore: result.truncated === true,
        truncated: result.truncated === true,
        events: result.events.map((event) => ({
          id: event.externalId,
          title: event.title,
          startAt: event.startAt,
          endAt: event.endAt,
          isAllDay: event.isAllDay,
          location: event.location,
        })),
      };
    },
  };
}
