/**
 * AppIntent registry — per-app inventory of the intents we know about
 * statically. Every entry is something Apple has either shipped as a
 * documented system intent or a Shortcuts action with a stable identifier.
 *
 * The Swift bridge calls `appIntentList({ bundleIds })` to discover what is
 * actually donated on the device at runtime. This registry is the planner's
 * a-priori catalog: it lets the agent reason about Mail/Notes/etc. before
 * the user has ever opened those apps.
 *
 * Sources for each entry are linked in a comment block above the entry; do
 * not invent intents that Apple has not documented.
 */

import type { IntentParameterSpec, IntentSpec } from "./ios-bridge.js";

// ── Helper ───────────────────────────────────────────────────────────────────

function param(
  name: string,
  type: IntentParameterSpec["type"],
  required: boolean,
  description?: string,
  enumValues?: readonly string[],
): IntentParameterSpec {
  return enumValues
    ? { name, type, required, description, enumValues }
    : { name, type, required, description };
}

// ── Apple Mail ───────────────────────────────────────────────────────────────
// https://developer.apple.com/documentation/sirikit/inteapomailintent
// https://developer.apple.com/documentation/appintents — Send Email action.

const MAIL_INTENTS: readonly IntentSpec[] = [
  {
    bundleId: "com.apple.mobilemail",
    id: "com.apple.mobilemail.send-email",
    displayName: "Send Email",
    summary: "Compose and send a new email through Apple Mail.",
    parameters: [
      param("to", "string", true, "Comma-separated recipient emails."),
      param("subject", "string", false, "Email subject line."),
      param("body", "string", false, "Plain-text email body."),
      param("cc", "string", false, "Comma-separated CC recipients."),
      param("bcc", "string", false, "Comma-separated BCC recipients."),
    ],
    source: "system",
  },
];

// ── Messages ─────────────────────────────────────────────────────────────────
// https://developer.apple.com/documentation/sirikit/intsendmessageintent

const MESSAGES_INTENTS: readonly IntentSpec[] = [
  {
    bundleId: "com.apple.MobileSMS",
    id: "com.apple.MobileSMS.send-message",
    displayName: "Send Message",
    summary:
      "Send an iMessage or SMS to one or more recipients via the Messages app.",
    parameters: [
      param("recipients", "string", true, "Comma-separated phone numbers or Apple IDs."),
      param("body", "string", true, "Message text."),
    ],
    source: "system",
  },
];

// ── Notes ────────────────────────────────────────────────────────────────────
// https://developer.apple.com/documentation/sirikit/intcreatenoteintent
// https://support.apple.com/guide/shortcuts/notes-actions-apdb14d36829/ios

const NOTES_INTENTS: readonly IntentSpec[] = [
  {
    bundleId: "com.apple.mobilenotes",
    id: "com.apple.mobilenotes.create-note",
    displayName: "Create Note",
    summary: "Create a new note in the Notes app.",
    parameters: [
      param("title", "string", false, "Note title (first line)."),
      param("body", "string", true, "Note body text."),
      param("folder", "string", false, "Destination folder name."),
    ],
    source: "system",
  },
  {
    bundleId: "com.apple.mobilenotes",
    id: "com.apple.mobilenotes.append-to-note",
    displayName: "Append to Note",
    summary: "Append text to an existing note matched by title.",
    parameters: [
      param("titleMatch", "string", true, "Exact title of the target note."),
      param("body", "string", true, "Text to append."),
    ],
    source: "system",
  },
  {
    bundleId: "com.apple.mobilenotes",
    id: "com.apple.mobilenotes.search-notes",
    displayName: "Search Notes",
    summary: "Search Notes for a query string and return matching note titles.",
    parameters: [param("query", "string", true, "Search query.")],
    source: "system",
  },
];

// ── Reminders ────────────────────────────────────────────────────────────────
// https://developer.apple.com/documentation/sirikit/intaddtaskstoreminderintent

const REMINDERS_INTENTS: readonly IntentSpec[] = [
  {
    bundleId: "com.apple.reminders",
    id: "com.apple.reminders.add-reminder",
    displayName: "Add Reminder",
    summary: "Create a new reminder.",
    parameters: [
      param("title", "string", true, "Reminder title."),
      param("notes", "string", false, "Optional notes."),
      param("dueDate", "date", false, "Optional due date (ISO 8601)."),
      param("listName", "string", false, "Target reminder list."),
      param(
        "priority",
        "enum",
        false,
        "Reminder priority.",
        ["none", "low", "medium", "high"],
      ),
    ],
    source: "system",
  },
  {
    bundleId: "com.apple.reminders",
    id: "com.apple.reminders.list-reminders",
    displayName: "List Reminders",
    summary: "List reminders, optionally filtered by list name and completion.",
    parameters: [
      param("listName", "string", false, "Target reminder list."),
      param("includeCompleted", "boolean", false, "Default false."),
    ],
    source: "system",
  },
];

// ── Music ────────────────────────────────────────────────────────────────────
// https://developer.apple.com/documentation/sirikit/intplaymediaintent

const MUSIC_INTENTS: readonly IntentSpec[] = [
  {
    bundleId: "com.apple.Music",
    id: "com.apple.Music.play",
    displayName: "Play Music",
    summary: "Play a song, album, artist, or playlist in Apple Music.",
    parameters: [
      param("query", "string", true, "Search query (song / album / artist)."),
      param(
        "kind",
        "enum",
        false,
        "Restrict the type of media to play.",
        ["song", "album", "artist", "playlist"],
      ),
      param("shuffle", "boolean", false, "Shuffle the queue. Default false."),
    ],
    source: "system",
  },
  {
    bundleId: "com.apple.Music",
    id: "com.apple.Music.pause",
    displayName: "Pause Music",
    summary: "Pause Apple Music playback.",
    parameters: [],
    source: "system",
  },
  {
    bundleId: "com.apple.Music",
    id: "com.apple.Music.next-track",
    displayName: "Next Track",
    summary: "Skip to the next track in Apple Music.",
    parameters: [],
    source: "system",
  },
];

// ── Maps ─────────────────────────────────────────────────────────────────────
// https://developer.apple.com/documentation/sirikit/intgetdirectionsintent

const MAPS_INTENTS: readonly IntentSpec[] = [
  {
    bundleId: "com.apple.Maps",
    id: "com.apple.Maps.directions",
    displayName: "Get Directions",
    summary: "Open Apple Maps with directions to a destination.",
    parameters: [
      param("destination", "string", true, "Address or place name."),
      param("origin", "string", false, "Starting address. Defaults to current location."),
      param(
        "transport",
        "enum",
        false,
        "Transport mode.",
        ["driving", "walking", "transit", "cycling"],
      ),
    ],
    source: "system",
  },
  {
    bundleId: "com.apple.Maps",
    id: "com.apple.Maps.search",
    displayName: "Search Maps",
    summary: "Search Apple Maps for a place.",
    parameters: [
      param("query", "string", true, "Search query."),
      param("nearLatitude", "number", false, "Optional latitude bias."),
      param("nearLongitude", "number", false, "Optional longitude bias."),
    ],
    source: "system",
  },
];

// ── Safari ───────────────────────────────────────────────────────────────────
// https://support.apple.com/guide/shortcuts/safari-actions-apd07c25323d/ios

const SAFARI_INTENTS: readonly IntentSpec[] = [
  {
    bundleId: "com.apple.mobilesafari",
    id: "com.apple.mobilesafari.open-url",
    displayName: "Open URL in Safari",
    summary: "Open a URL in Mobile Safari.",
    parameters: [
      param("url", "url", true, "Absolute URL to open."),
      param("inPrivateMode", "boolean", false, "Use private browsing. Default false."),
    ],
    source: "system",
  },
  {
    bundleId: "com.apple.mobilesafari",
    id: "com.apple.mobilesafari.add-bookmark",
    displayName: "Add Bookmark",
    summary: "Add a bookmark to Safari.",
    parameters: [
      param("url", "url", true, "Absolute URL to bookmark."),
      param("title", "string", false, "Bookmark title."),
    ],
    source: "system",
  },
];

// ── Registry ─────────────────────────────────────────────────────────────────

export const IOS_APP_INTENT_REGISTRY: Readonly<Record<string, readonly IntentSpec[]>> =
  Object.freeze({
    "com.apple.mobilemail": MAIL_INTENTS,
    "com.apple.MobileSMS": MESSAGES_INTENTS,
    "com.apple.mobilenotes": NOTES_INTENTS,
    "com.apple.reminders": REMINDERS_INTENTS,
    "com.apple.Music": MUSIC_INTENTS,
    "com.apple.Maps": MAPS_INTENTS,
    "com.apple.mobilesafari": SAFARI_INTENTS,
  });

export const IOS_APP_INTENT_BUNDLE_IDS: readonly string[] = Object.freeze(
  Object.keys(IOS_APP_INTENT_REGISTRY),
);

export function listIosAppIntents(): readonly IntentSpec[] {
  return Object.values(IOS_APP_INTENT_REGISTRY).flat();
}

export function findIosAppIntent(intentId: string): IntentSpec | undefined {
  return listIosAppIntents().find((intent) => intent.id === intentId);
}

export function findIosAppIntentsForBundle(
  bundleId: string,
): readonly IntentSpec[] {
  return IOS_APP_INTENT_REGISTRY[bundleId] ?? [];
}
