import { WebPlugin } from "@capacitor/core";
import type {
  AppleCalendarBaseResult,
  AppleCalendarEventInput,
  AppleCalendarEventResult,
  AppleCalendarEventsResult,
  AppleCalendarListEventsOptions,
  AppleCalendarListResult,
  AppleCalendarPermissionStatus,
  AppleCalendarPlugin,
  AppleCalendarUpdateEventInput,
} from "./definitions";

const unsupported = {
  ok: false,
  error: "not_supported",
  message: "Apple Calendar is only available through the native iOS app or macOS desktop runtime.",
} as const;

export class AppleCalendarWeb extends WebPlugin implements AppleCalendarPlugin {
  async checkPermissions(): Promise<AppleCalendarPermissionStatus> {
    return {
      calendar: "restricted",
      canRequest: false,
      reason: unsupported.message,
    };
  }

  async requestPermissions(): Promise<AppleCalendarPermissionStatus> {
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
  ): Promise<AppleCalendarEventResult> {
    return { ...unsupported };
  }

  async updateEvent(
    _input: AppleCalendarUpdateEventInput,
  ): Promise<AppleCalendarEventResult> {
    return { ...unsupported };
  }

  async deleteEvent(): Promise<AppleCalendarBaseResult> {
    return { ...unsupported };
  }
}
