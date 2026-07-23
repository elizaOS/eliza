/**
 * Planner-visible server capabilities for managed Cloud Notes and Calendar.
 * Each declaration maps one-to-one to `interact.ts`, which is the supported
 * server-side control plane for both views.
 */

import type { ViewCapability } from "@elizaos/core";

const ID_PARAM = {
  id: {
    type: "string",
    description: "Stable entity id returned by a prior read or create.",
    required: true,
  },
};

export const NOTES_CAPABILITIES: ViewCapability[] = [
  {
    id: "get-notes",
    description: "List every sticky note as structured data.",
  },
  {
    id: "get-note",
    description: "Read one sticky note by id.",
    params: ID_PARAM,
  },
  {
    id: "create-note",
    description: "Create a durable sticky note.",
    params: {
      title: {
        type: "string",
        description: "Required note title.",
        required: true,
      },
      body: { type: "string", description: "Optional note body." },
      color: {
        type: "string",
        description: "Optional color: yellow, green, rose, or slate.",
      },
    },
  },
  {
    id: "update-note",
    description: "Update one or more fields on a sticky note.",
    params: {
      ...ID_PARAM,
      title: { type: "string", description: "Replacement note title." },
      body: { type: "string", description: "Replacement note body." },
      color: {
        type: "string",
        description: "Replacement color: yellow, green, rose, or slate.",
      },
    },
  },
  {
    id: "delete-note",
    description: "Delete one sticky note by id, exact title, or unique query.",
    params: {
      id: { type: "string", description: "Stable note id." },
      title: { type: "string", description: "Exact note title." },
      query: {
        type: "string",
        description: "Unique title/body search text.",
      },
    },
  },
  {
    id: "clear-notes",
    description: "Delete every sticky note.",
  },
];

export const CALENDAR_CAPABILITIES: ViewCapability[] = [
  {
    id: "get-calendar-state",
    description: "Read selected date and calendar events as structured data.",
    params: {
      date: {
        type: "string",
        description: "Optional YYYY-MM-DD filter.",
      },
    },
  },
  {
    id: "get-calendar-event",
    description: "Read one Simple Calendar event by id.",
    params: ID_PARAM,
  },
  {
    id: "select-calendar-date",
    description: "Persist the date selected in the Simple Calendar view.",
    params: {
      date: {
        type: "string",
        description: "Date in YYYY-MM-DD format.",
        required: true,
      },
    },
  },
  {
    id: "create-calendar-event",
    description: "Create a durable Simple Calendar event.",
    params: {
      title: {
        type: "string",
        description: "Required event title.",
        required: true,
      },
      date: {
        type: "string",
        description: "Optional YYYY-MM-DD date; defaults to selected date.",
      },
      time: {
        type: "string",
        description: "Optional HH:mm 24-hour time; defaults to 09:00.",
      },
      notes: { type: "string", description: "Optional event notes." },
      color: {
        type: "string",
        description: "Optional color: yellow, green, rose, or slate.",
      },
    },
  },
  {
    id: "update-calendar-event",
    description: "Update one or more fields on a Simple Calendar event.",
    params: {
      ...ID_PARAM,
      title: { type: "string", description: "Replacement event title." },
      date: { type: "string", description: "Replacement YYYY-MM-DD date." },
      time: { type: "string", description: "Replacement HH:mm time." },
      notes: { type: "string", description: "Replacement event notes." },
      color: {
        type: "string",
        description: "Replacement color: yellow, green, rose, or slate.",
      },
    },
  },
  {
    id: "delete-calendar-event",
    description: "Delete one Simple Calendar event by id.",
    params: ID_PARAM,
  },
];
