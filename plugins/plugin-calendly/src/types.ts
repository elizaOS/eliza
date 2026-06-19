/**
 * @module types
 * @description Shared types for the Calendly plugin destination.
 */

export const CALENDLY_SERVICE_TYPE = "calendly";

export const CalendlyActions = {
  CALENDLY_OP: "CALENDLY",
} as const;

export interface CalendlyEventType {
  uri: string;
  name: string;
  active: boolean;
  slug: string;
  scheduling_url: string;
  duration: number;
  kind: string;
  type: string;
  description_plain?: string | null;
}

export interface CalendlyScheduledEvent {
  uri: string;
  name: string;
  startTime: string;
  endTime: string;
  status: "active" | "canceled";
  invitees: Array<{ name?: string; email?: string; status: string }>;
}

export interface CalendlyAvailability {
  date: string;
  slots: Array<{ startTime: string; endTime: string }>;
}

export interface CalendlySingleUseLink {
  bookingUrl: string;
  expiresAt: string | null;
}

export interface BookingLinkQuery {
  durationMinutes?: number;
  slug?: string;
}

export type CalendlyActionResult<T = unknown> =
  | { success: true; data: T }
  | {
      success: false;
      requiresConfirmation: true;
      preview: string;
      text: string;
      data: T & { requiresConfirmation: true; preview: string };
    }
  | { success: false; error: string };
