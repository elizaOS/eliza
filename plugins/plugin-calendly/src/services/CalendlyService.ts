import type {
  BookingLinkQuery,
  CalendlyAvailability,
  CalendlyEventType,
  CalendlyScheduledEvent,
  CalendlySingleUseLink,
} from "../types.js";

export interface CalendlyService {
  isConnected(accountId?: string): boolean;
  listEventTypes(accountId?: string): Promise<CalendlyEventType[]>;
  listScheduledEvents(
    options?: Record<string, unknown>,
    accountId?: string,
  ): Promise<CalendlyScheduledEvent[]>;
  getAvailability(
    eventTypeUri: string,
    options: { startDate: string; endDate: string; timezone?: string },
    accountId?: string,
  ): Promise<CalendlyAvailability[]>;
  createSingleUseLink(
    eventTypeUri: string,
    accountId?: string,
  ): Promise<CalendlySingleUseLink>;
  getBookingUrl(
    query?: BookingLinkQuery,
    accountId?: string,
  ): Promise<string | null>;
  cancelBooking(
    uuid: string,
    reason?: string,
    accountId?: string,
  ): Promise<void>;
}
