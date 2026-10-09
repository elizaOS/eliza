/**
 * Server-owned, read-only Google seam. Not registered in Shared until the
 * hosting boundary supplies owner scope and explicit private-context consent.
 */
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
    throw new Error("SHARED_GOOGLE_INVALID_INPUT");
  }
  return result;
}

function validateReadRequest(value: unknown): SharedGoogleReadRequest {
  if (!value || typeof value !== "object") throw new Error("SHARED_GOOGLE_INVALID_INPUT");
  const request = value as Record<string, unknown>;
  if (request.kind === "gmail_search" && typeof request.query === "string") {
    return { kind: "gmail_search", query: bounded(request.query, 256) };
  }
  if (request.kind === "gmail_message" && typeof request.messageId === "string") {
    return { kind: "gmail_message", messageId: bounded(request.messageId, 256) };
  }
  if (request.kind === "calendar" && typeof request.timeMin === "string" &&
      typeof request.timeMax === "string" && typeof request.timeZone === "string") {
    const start = Date.parse(request.timeMin), end = Date.parse(request.timeMax);
    if (!Number.isFinite(start) || !Number.isFinite(end) ||
        end <= start || end - start > 7 * 24 * 60 * 60 * 1_000) {
      throw new Error("SHARED_GOOGLE_CALENDAR_WINDOW_REQUIRED");
    }
    return { kind: "calendar", timeMin: new Date(start).toISOString(),
      timeMax: new Date(end).toISOString(), timeZone: bounded(request.timeZone, 100) };
  }
  throw new Error("SHARED_GOOGLE_INVALID_INPUT");
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
    connect: () => deps.initiateManagedGoogleConnection({
      ...scope,
      capabilities: ["google.basic_identity", "google.gmail.triage", "google.calendar.read"],
      redirectUrl: "/cloud/connectors",
    }),
    async read(input: unknown) {
      const request = validateReadRequest(input);
      if (!grantId) throw new Error("SHARED_GOOGLE_EXPLICIT_GRANT_REQUIRED");
      await owner.authorizePrivateRead(request);
      const selected = { ...scope, grantId };
      const status = await deps.getManagedGoogleConnectorStatus(selected);
      const capability = request.kind === "calendar" ? "google.calendar.read" : "google.gmail.triage";
      if (!status.connected || status.connectionId !== grantId ||
          !status.grantedCapabilities.includes(capability)) {
        throw new Error("SHARED_GOOGLE_READ_NOT_GRANTED");
      }
      if (request.kind === "gmail_search") {
        const result = await deps.fetchManagedGoogleGmailSearch({
          ...selected, query: bounded(request.query, 256), maxResults: 5,
        });
        return {
          kind: "private_google_gmail_search" as const,
          untrustedContent: true as const,
          observedAt: result.syncedAt,
          messages: result.messages.slice(0, 5).map((message) => ({
            id: message.externalId, subject: message.subject.slice(0, 256),
            from: message.from.slice(0, 256), snippet: message.snippet.slice(0, 512),
            receivedAt: message.receivedAt,
          })),
        };
      }
      if (request.kind === "gmail_message") {
        const result = await deps.readManagedGoogleGmailMessage({
          ...selected, messageId: bounded(request.messageId, 256),
        });
        return {
          kind: "private_google_gmail_message" as const,
          untrustedContent: true as const,
          id: result.message.externalId,
          subject: result.message.subject.slice(0, 256),
          bodyText: result.bodyText.slice(0, 8_000),
          truncated: result.bodyText.length > 8_000,
        };
      }
      const result = await deps.fetchManagedGoogleCalendarFeed({
        ...selected, calendarId: "primary", timeMin: request.timeMin,
        timeMax: request.timeMax, timeZone: request.timeZone,
      });
      return {
        kind: "private_google_calendar" as const,
        untrustedContent: true as const,
        observedAt: result.syncedAt,
        truncated: result.events.length > 20,
        events: result.events.slice(0, 20).map((event) => ({
          id: event.externalId, title: event.title.slice(0, 256),
          startAt: event.startAt, endAt: event.endAt, isAllDay: event.isAllDay,
          location: event.location.slice(0, 256),
        })),
      };
    },
  };
}
