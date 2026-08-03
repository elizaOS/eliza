/**
 * Planner-visible server capabilities for managed Cloud Notes and Calendar.
 * Each declaration maps one-to-one to `interact.ts`, which is the supported
 * server-side control plane for both views.
 */

import type { ViewCapability, ViewCapabilityParameter } from "@elizaos/core";

const TITLE_PARAM: ViewCapabilityParameter = {
  type: "string",
  description: "Title text.",
  minLength: 1,
  maxLength: 240,
  pattern: "\\S",
};

const BODY_PARAM: ViewCapabilityParameter = {
  type: "string",
  description: "Optional body or details text.",
  maxLength: 20_000,
};

const COLOR_PARAM: ViewCapabilityParameter = {
  type: "string",
  description: "Optional color: yellow, green, rose, or slate.",
  enum: ["yellow", "green", "rose", "slate"],
};

const DATE_PARAM: ViewCapabilityParameter = {
  type: "string",
  description: "Date in YYYY-MM-DD format.",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
};

const TIME_PARAM: ViewCapabilityParameter = {
  type: "string",
  description: "Time in HH:mm 24-hour format.",
  pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
};

const ID_PARAM = {
  id: {
    type: "string",
    description: "Stable entity id returned by a prior read or create.",
    required: true,
    minLength: 3,
    maxLength: 128,
    pattern: "^[a-z][a-z0-9-]{2,127}$",
  },
} satisfies NonNullable<ViewCapability["params"]>;

export const NOTES_CAPABILITIES: ViewCapability[] = [
  {
    id: "get-notes",
    description:
      "List sticky notes as structured data, optionally narrowed by exact title or unique query.",
    params: {
      title: { ...TITLE_PARAM, description: "Optional exact note title." },
      query: {
        type: "string",
        description: "Optional unique title/body search text.",
        minLength: 1,
        maxLength: 20_000,
        pattern: "\\S",
      },
    },
  },
  {
    id: "get-note",
    description: "Read one sticky note by id, exact title, or unique query.",
    params: {
      id: { ...ID_PARAM.id, required: false },
      title: { ...TITLE_PARAM, description: "Exact note title." },
      query: {
        type: "string",
        description: "Unique title/body search text.",
        minLength: 1,
        maxLength: 20_000,
        pattern: "\\S",
      },
    },
  },
  {
    id: "create-note",
    description: "Create a durable sticky note.",
    params: {
      title: {
        ...TITLE_PARAM,
        description: "Required note title.",
        required: true,
      },
      body: { ...BODY_PARAM, description: "Optional note body." },
      color: COLOR_PARAM,
    },
  },
  {
    id: "update-note",
    description:
      "Update one or more fields on a sticky note identified by id, exact title, or unique query.",
    params: {
      id: { ...ID_PARAM.id, description: "Stable note id.", required: false },
      oldTitle: {
        ...TITLE_PARAM,
        description:
          "Current exact title when title supplies the replacement title.",
      },
      title: {
        ...TITLE_PARAM,
        description:
          "Current exact title, or replacement title when oldTitle is supplied.",
      },
      query: {
        type: "string",
        description:
          "Current exact title or unique title/body text identifying the note to update.",
        minLength: 1,
        maxLength: 20_000,
        pattern: "\\S",
      },
      newTitle: { ...TITLE_PARAM, description: "Replacement note title." },
      body: { ...BODY_PARAM, description: "Replacement note body." },
      color: {
        ...COLOR_PARAM,
        description: "Replacement color: yellow, green, rose, or slate.",
      },
    },
  },
  {
    id: "delete-note",
    description: "Delete one sticky note by id, exact title, or unique query.",
    params: {
      id: { ...ID_PARAM.id, description: "Stable note id.", required: false },
      title: { ...TITLE_PARAM, description: "Exact note title." },
      query: {
        type: "string",
        description: "Unique title/body search text.",
        minLength: 1,
        maxLength: 20_000,
        pattern: "\\S",
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
    description:
      "Read selected date and calendar events, optionally narrowed by date, exact title, or unique query.",
    params: {
      date: {
        ...DATE_PARAM,
        description: "Optional YYYY-MM-DD filter.",
      },
      title: { ...TITLE_PARAM, description: "Optional exact event title." },
      query: {
        type: "string",
        description: "Optional unique title/date/time/notes search text.",
        minLength: 1,
        maxLength: 20_000,
        pattern: "\\S",
      },
    },
  },
  {
    id: "get-calendar-event",
    description:
      "Read one Simple Calendar event by id, exact title, or unique query.",
    params: {
      id: { ...ID_PARAM.id, required: false },
      title: { ...TITLE_PARAM, description: "Exact event title." },
      query: {
        type: "string",
        description: "Unique title/date/time/notes search text.",
        minLength: 1,
        maxLength: 20_000,
        pattern: "\\S",
      },
    },
  },
  {
    id: "select-calendar-date",
    description: "Persist the date selected in the Simple Calendar view.",
    params: {
      date: {
        ...DATE_PARAM,
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
        ...TITLE_PARAM,
        description: "Required event title.",
        required: true,
      },
      date: {
        ...DATE_PARAM,
        description: "Optional YYYY-MM-DD date; defaults to selected date.",
      },
      time: {
        ...TIME_PARAM,
        description: "Optional HH:mm 24-hour time; defaults to 09:00.",
      },
      details: { ...BODY_PARAM, description: "Optional event details." },
      notes: { ...BODY_PARAM, description: "Optional event notes." },
      color: COLOR_PARAM,
    },
  },
  {
    id: "update-calendar-event",
    description:
      "Update one or more fields on a Simple Calendar event identified by id, exact title, or unique query.",
    params: {
      id: {
        ...ID_PARAM.id,
        description: "Stable calendar event id.",
        required: false,
      },
      oldTitle: {
        ...TITLE_PARAM,
        description:
          "Current exact title when title supplies the replacement title.",
      },
      title: {
        ...TITLE_PARAM,
        description:
          "Current exact title, or replacement title when oldTitle is supplied.",
      },
      query: {
        type: "string",
        description:
          "Current exact title or unique title/date/time/notes text identifying the event to update.",
        minLength: 1,
        maxLength: 20_000,
        pattern: "\\S",
      },
      newTitle: { ...TITLE_PARAM, description: "Replacement event title." },
      date: { ...DATE_PARAM, description: "Replacement YYYY-MM-DD date." },
      time: { ...TIME_PARAM, description: "Replacement HH:mm time." },
      details: { ...BODY_PARAM, description: "Replacement event details." },
      notes: { ...BODY_PARAM, description: "Replacement event details." },
      color: {
        ...COLOR_PARAM,
        description: "Replacement color: yellow, green, rose, or slate.",
      },
    },
  },
  {
    id: "delete-calendar-event",
    description:
      "Delete one Simple Calendar event by id, exact title, or unique query.",
    params: {
      id: {
        ...ID_PARAM.id,
        description: "Stable calendar event id.",
        required: false,
      },
      title: { ...TITLE_PARAM, description: "Exact calendar event title." },
      query: {
        type: "string",
        description: "Unique title, date, time, or notes search text.",
        minLength: 1,
        maxLength: 20_000,
        pattern: "\\S",
      },
    },
  },
];
