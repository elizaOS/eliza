import { randomUUID } from "node:crypto";
import type { calendar_v3 } from "googleapis";
import type { GoogleApiClientFactory } from "./client-factory.js";
import type {
  GoogleAccountRef,
  GoogleCalendarEvent,
  GoogleCalendarEventInput,
  GoogleCalendarEventPatchInput,
  GoogleCalendarListEntry,
  GoogleEmailAddress,
} from "./types.js";

export class GoogleCalendarClient {
  constructor(private readonly clientFactory: GoogleApiClientFactory) {}

  async listCalendars(params: GoogleAccountRef): Promise<GoogleCalendarListEntry[]> {
    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.read"],
      "calendar.listCalendars"
    );
    const response = await calendar.calendarList.list({
      minAccessRole: "reader",
      showDeleted: false,
      showHidden: false,
    });

    return (response.data.items ?? [])
      .filter((entry) => !entry.deleted && !entry.hidden)
      .map(mapCalendarListEntry)
      .filter((entry): entry is GoogleCalendarListEntry => entry !== null);
  }

  async listEvents(
    params: GoogleAccountRef & {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      limit?: number;
    }
  ): Promise<GoogleCalendarEvent[]> {
    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.read"],
      "calendar.listEvents"
    );
    const calendarId = params.calendarId ?? "primary";
    const response = await calendar.events.list({
      calendarId,
      timeMin: params.timeMin,
      timeMax: params.timeMax,
      maxResults: params.limit ?? 25,
      singleEvents: true,
      orderBy: "startTime",
    });

    return (response.data.items ?? []).map((event) => mapEvent(event, calendarId));
  }

  async createEvent(params: GoogleCalendarEventInput): Promise<GoogleCalendarEvent> {
    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.write"],
      "calendar.createEvent"
    );
    const calendarId = params.calendarId ?? "primary";
    const response = await calendar.events.insert({
      calendarId,
      conferenceDataVersion: params.createMeetLink ? 1 : undefined,
      requestBody: {
        summary: params.title,
        description: params.description,
        location: params.location,
        start: toEventDateTime(params.start, params.timeZone),
        end: toEventDateTime(params.end, params.timeZone),
        attendees: params.attendees?.map(toCalendarAttendee),
        conferenceData: params.createMeetLink
          ? {
              createRequest: {
                requestId: randomUUID(),
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            }
          : undefined,
      },
    });

    return mapEvent(response.data, calendarId);
  }

  async updateEvent(params: GoogleCalendarEventPatchInput): Promise<GoogleCalendarEvent> {
    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.write"],
      "calendar.updateEvent"
    );
    const calendarId = params.calendarId ?? "primary";
    const needsExistingEventContext =
      Boolean(params.start || params.end) && (!params.timeZone || !params.start || !params.end);
    const existing = needsExistingEventContext
      ? (
          await calendar.events.get({
            calendarId,
            eventId: params.eventId,
          })
        ).data
      : null;
    const effectiveTimeZone =
      params.timeZone ?? existing?.start?.timeZone ?? existing?.end?.timeZone ?? undefined;
    const { start, end } = normalizePatchBounds({
      start: params.start,
      end: params.end,
      existing,
    });
    const requestBody: calendar_v3.Schema$Event = {};

    if (params.title !== undefined) {
      requestBody.summary = params.title;
    }
    if (params.description !== undefined) {
      requestBody.description = params.description;
    }
    if (params.location !== undefined) {
      requestBody.location = params.location;
    }
    if (start !== undefined) {
      requestBody.start = toEventDateTime(start, effectiveTimeZone);
    }
    if (end !== undefined) {
      requestBody.end = toEventDateTime(end, effectiveTimeZone);
    }
    if (params.attendees !== undefined) {
      requestBody.attendees = params.attendees.map(toCalendarAttendee);
    }

    const response = await calendar.events.patch({
      calendarId,
      eventId: params.eventId,
      requestBody,
    });

    return mapEvent(response.data, calendarId);
  }

  async deleteEvent(
    params: GoogleAccountRef & { calendarId?: string; eventId: string }
  ): Promise<void> {
    const calendar = await this.clientFactory.calendar(
      params,
      ["calendar.write"],
      "calendar.deleteEvent"
    );
    try {
      await calendar.events.delete({
        calendarId: params.calendarId ?? "primary",
        eventId: params.eventId,
      });
    } catch (error) {
      if (googleErrorStatus(error) === 410) {
        return;
      }
      throw error;
    }
  }
}

function mapCalendarListEntry(
  entry: calendar_v3.Schema$CalendarListEntry
): GoogleCalendarListEntry | null {
  const calendarId = entry.id?.trim();
  if (!calendarId) {
    return null;
  }
  return {
    calendarId,
    summary: entry.summaryOverride?.trim() || entry.summary?.trim() || calendarId,
    description: entry.description?.trim() || null,
    primary: Boolean(entry.primary),
    accessRole: entry.accessRole?.trim() || "reader",
    backgroundColor: entry.backgroundColor?.trim() || null,
    foregroundColor: entry.foregroundColor?.trim() || null,
    timeZone: entry.timeZone?.trim() || null,
    selected: entry.selected !== false,
  };
}

function mapEvent(event: calendar_v3.Schema$Event, calendarId: string): GoogleCalendarEvent {
  return {
    id: event.id ?? "",
    calendarId,
    title: event.summary ?? undefined,
    start: event.start?.dateTime ?? event.start?.date ?? undefined,
    end: event.end?.dateTime ?? event.end?.date ?? undefined,
    htmlLink: event.htmlLink ?? undefined,
    meetLink: event.hangoutLink ?? event.conferenceData?.entryPoints?.[0]?.uri ?? undefined,
    attendees: event.attendees?.map((attendee) => ({
      email: attendee.email ?? "",
      name: attendee.displayName ?? undefined,
    })),
    location: event.location ?? undefined,
    description: event.description ?? undefined,
  };
}

function eventDateValue(value: calendar_v3.Schema$EventDateTime | undefined): string | undefined {
  return value?.dateTime ?? value?.date ?? undefined;
}

function normalizePatchBounds(params: {
  start?: string;
  end?: string;
  existing: calendar_v3.Schema$Event | null;
}): { start?: string; end?: string } {
  let start = params.start;
  let end = params.end;
  if (!params.existing || Boolean(start) === Boolean(end)) {
    return { start, end };
  }

  const existingStart = eventDateValue(params.existing.start);
  const existingEnd = eventDateValue(params.existing.end);
  const existingDurationMs =
    existingStart && existingEnd ? Date.parse(existingEnd) - Date.parse(existingStart) : Number.NaN;
  const fallbackDurationMs =
    Number.isFinite(existingDurationMs) && existingDurationMs > 0
      ? existingDurationMs
      : 60 * 60 * 1000;

  if (start && !end) {
    end = new Date(new Date(start).getTime() + fallbackDurationMs).toISOString();
  } else if (end && !start) {
    start = new Date(new Date(end).getTime() - fallbackDurationMs).toISOString();
  }

  return { start, end };
}

function toEventDateTime(
  value: string,
  timeZone: string | undefined
): calendar_v3.Schema$EventDateTime {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { date: value, timeZone };
  }
  return { dateTime: value, timeZone };
}

function toCalendarAttendee(address: GoogleEmailAddress): calendar_v3.Schema$EventAttendee {
  return {
    email: address.email,
    displayName: address.name,
  };
}

function googleErrorStatus(error: unknown): number | undefined {
  const candidate = error as {
    code?: number;
    status?: number;
    response?: { status?: number };
  };
  return candidate.response?.status ?? candidate.status ?? candidate.code;
}
