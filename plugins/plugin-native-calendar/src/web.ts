/**
 * Browser/web implementation of `AppleCalendarPlugin`, loaded by the
 * Capacitor web fallback when no native bridge is registered. EventKit is
 * unavailable outside iOS/macOS, so every method returns a fixed
 * `not_supported` result rather than fabricating calendar data.
 */
import { WebPlugin } from "@capacitor/core";
import type {
  AppleCalendarBaseResult,
  AppleCalendarCreateResult,
  AppleCalendarEventInput,
  AppleCalendarEventResult,
  AppleCalendarEventsResult,
  AppleCalendarListEventsOptions,
  AppleCalendarListResult,
  AppleCalendarPermissionRequest,
  AppleCalendarPermissionStatus,
  AppleCalendarPlugin,
  AppleCalendarUpdateEventInput,
} from "./definitions";

const unsupported = {
  ok: false,
  error: "not_supported",
  message:
    "Apple Calendar is only available through the native iOS app or macOS desktop runtime.",
} as const;

export class AppleCalendarWeb extends WebPlugin implements AppleCalendarPlugin {
  async addListener(
    _eventName: "calendarStoreChanged",
    _listener: (event: { observedAt: string }) => void,
  ): Promise<{ remove: () => Promise<void> }> {
    return { remove: async () => undefined };
  }

  async checkPermissions(): Promise<AppleCalendarPermissionStatus> {
    return {
      calendar: "restricted",
      canRequest: false,
      reason: unsupported.message,
    };
  }

  async requestPermissions(
    _options?: AppleCalendarPermissionRequest,
  ): Promise<AppleCalendarPermissionStatus> {
    return this.checkPermissions();
  }

  async listCalendars(): Promise<AppleCalendarListResult> {
    return { ...unsupported };
  }

  async listEvents(
    _options: AppleCalendarListEventsOptions,
  ): Promise<AppleCalendarEventsResult> {
    return { ...unsupported };
  }

  async createEvent(
    _input: AppleCalendarEventInput,
  ): Promise<AppleCalendarCreateResult> {
    return { ...unsupported };
  }

  async updateEvent(
    _input: AppleCalendarUpdateEventInput,
  ): Promise<AppleCalendarEventResult> {
    return { ...unsupported };
  }

  async deleteEvent(
    _input: Parameters<AppleCalendarPlugin["deleteEvent"]>[0],
  ): Promise<AppleCalendarBaseResult> {
    return { ...unsupported };
  }
}
