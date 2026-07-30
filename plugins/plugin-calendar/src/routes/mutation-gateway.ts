/**
 * Host-owned owner-editor mutation boundary for calendar HTTP routes. Calendar
 * owns provider CRUD, while the host must bind an authenticated Save/Delete
 * gesture to its approval queue and durable mutation ledger before invoking
 * those provider methods.
 */
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  CreateLifeOpsCalendarEventResponse,
  LifeOpsCalendarCancellationMode,
  LifeOpsCalendarEvent,
  LifeOpsCalendarEventCancellationResult,
  LifeOpsCalendarRecurrenceScope,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
} from "@elizaos/shared";

export const CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE =
  "calendar_owner_mutation_gateway";

export interface CalendarOwnerMutationGateway {
  create(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
  ): Promise<CreateLifeOpsCalendarEventResponse>;
  update(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      title?: string;
      description?: string;
      location?: string;
      startAt?: string;
      endAt?: string;
      timeZone?: string;
      attendees?: CreateLifeOpsCalendarEventAttendee[] | null;
      recurrence?: string[] | null;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees?: boolean;
      expectedProviderVersion: string;
      idempotencyKey: string;
    },
  ): Promise<LifeOpsCalendarEvent>;
  cancel(
    requestUrl: URL,
    request: {
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees: boolean;
      expectedProviderVersion: string;
      cancellationMode: LifeOpsCalendarCancellationMode;
      idempotencyKey: string;
    },
  ): Promise<LifeOpsCalendarEventCancellationResult>;
}
