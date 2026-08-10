/**
 * Calendar subpath test double. Personal-assistant integration specs import
 * plugin-calendar source, which imports Google calendar error classes by
 * subpath so runtime code avoids the Google Workspace barrel. The test suite
 * stubs that subpath for the same reason: it needs stable error identities, not
 * live Google SDK wiring or a prebuilt workspace dist.
 */
import { ElizaError } from "@elizaos/core";

export type GoogleCalendarMutationOutcome =
  | "not_accepted"
  | "precondition_failed";

export class GoogleCalendarMutationError extends ElizaError {
  override readonly name = "GoogleCalendarMutationError";

  constructor(
    readonly outcome: GoogleCalendarMutationOutcome,
    code: string,
    message: string,
    context: Record<string, unknown>,
    cause: unknown,
  ) {
    super(message, {
      code,
      context,
      cause,
      severity: outcome === "not_accepted" ? "ephemeral" : "fatal",
    });
  }
}

export type GoogleCalendarSyncResource = "calendarList" | "events";

export class GoogleCalendarSyncTokenExpiredError extends ElizaError {
  override readonly name = "GoogleCalendarSyncTokenExpiredError";
  readonly resource: GoogleCalendarSyncResource;

  constructor(args: {
    resource: GoogleCalendarSyncResource;
    accountId: string;
    calendarId?: string;
    cause: unknown;
  }) {
    super(
      "Google Calendar incremental sync token has expired; a full resync is required.",
      {
        code: "GOOGLE_CALENDAR_SYNC_TOKEN_EXPIRED",
        context: {
          resource: args.resource,
          accountId: args.accountId,
          ...(args.calendarId ? { calendarId: args.calendarId } : {}),
        },
        cause: args.cause,
        severity: "ephemeral",
      },
    );
    this.resource = args.resource;
  }
}
