/**
 * @module ical
 * @description ICS (iCalendar) file generation utilities
 *
 * Generates RFC 5545 compliant iCalendar files for calendar invites.
 */

import type { CalendarEvent, ParticipantRole } from "../types.ts";

/**
 * Escape special characters for ICS format
 */
const escapeIcs = (str: string): string => {
  return str.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
};

/**
 * Format a date for ICS (YYYYMMDDTHHMMSSZ)
 */
const formatIcsDate = (isoString: string): string => {
  return isoString.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
};

/**
 * Map participant role to ICS role
 */
const icsRole = (role: ParticipantRole): string => {
  switch (role) {
    case "organizer":
      return "REQ-PARTICIPANT";
    case "required":
      return "REQ-PARTICIPANT";
    case "optional":
      return "OPT-PARTICIPANT";
    default:
      return "REQ-PARTICIPANT";
  }
};

/**
 * Fold long lines per RFC 5545 (max 75 octets per line)
 */
const foldLine = (line: string): string => {
  const maxLength = 75;
  if (line.length <= maxLength) {
    return line;
  }

  const lines: string[] = [];
  let remaining = line;

  while (remaining.length > 0) {
    if (lines.length === 0) {
      lines.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
    } else {
      // Continuation lines start with a space
      lines.push(" " + remaining.slice(0, maxLength - 1));
      remaining = remaining.slice(maxLength - 1);
    }
  }

  return lines.join("\r\n");
};

/**
 * Generate ICS content for a calendar event
 */
export const generateIcs = (event: CalendarEvent): string => {
  const lines: string[] = [];

  // Begin calendar
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//ElizaOS//SchedulingPlugin//EN");
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:REQUEST");

  // Begin event
  lines.push("BEGIN:VEVENT");

  // Required properties
  lines.push(`UID:${event.uid}`);
  lines.push(`DTSTAMP:${formatIcsDate(new Date().toISOString())}`);
  lines.push(`DTSTART:${formatIcsDate(event.start)}`);
  lines.push(`DTEND:${formatIcsDate(event.end)}`);
  lines.push(`SUMMARY:${escapeIcs(event.title)}`);

  // Optional properties
  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcs(event.description)}`);
  }

  if (event.location) {
    lines.push(`LOCATION:${escapeIcs(event.location)}`);
  }

  if (event.url) {
    lines.push(`URL:${event.url}`);
  }

  // Organizer
  if (event.organizer) {
    lines.push(`ORGANIZER;CN=${escapeIcs(event.organizer.name)}:mailto:${event.organizer.email}`);
  }

  // Attendees
  if (event.attendees) {
    for (const attendee of event.attendees) {
      const role = icsRole(attendee.role);
      lines.push(
        `ATTENDEE;ROLE=${role};PARTSTAT=NEEDS-ACTION;CN=${escapeIcs(attendee.name)}:mailto:${attendee.email}`
      );
    }
  }

  // Reminders/Alarms
  if (event.reminderMinutes) {
    for (const minutes of event.reminderMinutes) {
      lines.push("BEGIN:VALARM");
      lines.push("ACTION:DISPLAY");
      lines.push(`DESCRIPTION:${escapeIcs(event.title)}`);
      lines.push(`TRIGGER:-PT${minutes}M`);
      lines.push("END:VALARM");
    }
  }

  // Status
  lines.push("STATUS:CONFIRMED");
  lines.push("SEQUENCE:0");

  // End event
  lines.push("END:VEVENT");

  // End calendar
  lines.push("END:VCALENDAR");

  // Fold long lines and join with CRLF
  return lines.map(foldLine).join("\r\n");
};

/**
 * Parse an ICS file and extract events (basic parser)
 */
export const parseIcs = (ics: string): CalendarEvent[] => {
  const events: CalendarEvent[] = [];
  const lines = ics.split(/\r?\n/);

  let currentEvent: Partial<CalendarEvent> | null = null;
  let currentLine = "";

  for (const line of lines) {
    // Handle line folding (continuation lines start with space or tab)
    if (line.startsWith(" ") || line.startsWith("\t")) {
      currentLine += line.slice(1);
      continue;
    }

    // Process the previous line
    if (currentLine && currentEvent) {
      processLine(currentLine, currentEvent);
    }

    currentLine = line;

    // Check for event boundaries
    if (line === "BEGIN:VEVENT") {
      currentEvent = {};
    } else if (line === "END:VEVENT" && currentEvent) {
      if (currentEvent.uid && currentEvent.start && currentEvent.end && currentEvent.title) {
        events.push(currentEvent as CalendarEvent);
      }
      currentEvent = null;
    }
  }

  return events;
};

/**
 * Process a single ICS property line
 */
const processLine = (line: string, event: Partial<CalendarEvent>): void => {
  const colonIndex = line.indexOf(":");
  if (colonIndex === -1) return;

  const keyPart = line.slice(0, colonIndex);
  const value = line.slice(colonIndex + 1);

  // Handle properties with parameters (e.g., DTSTART;TZID=America/New_York)
  const semiIndex = keyPart.indexOf(";");
  const key = semiIndex === -1 ? keyPart : keyPart.slice(0, semiIndex);

  switch (key) {
    case "UID":
      event.uid = value;
      break;
    case "SUMMARY":
      event.title = unescapeIcs(value);
      break;
    case "DESCRIPTION":
      event.description = unescapeIcs(value);
      break;
    case "DTSTART":
      event.start = parseIcsDate(value);
      break;
    case "DTEND":
      event.end = parseIcsDate(value);
      break;
    case "LOCATION":
      event.location = unescapeIcs(value);
      break;
    case "URL":
      event.url = value;
      break;
  }
};

/**
 * Unescape ICS special characters
 */
const unescapeIcs = (str: string): string => {
  return str.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
};

/**
 * Parse ICS date format to ISO string
 */
const parseIcsDate = (icsDate: string): string => {
  // Handle YYYYMMDDTHHMMSSZ format
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(icsDate);
  if (match) {
    const [, year, month, day, hour, minute, second] = match;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  }

  // Return as-is if format not recognized
  return icsDate;
};
