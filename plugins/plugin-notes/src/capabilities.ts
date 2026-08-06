/**
 * Planner-visible server capabilities for the managed Cloud Notes view. Each
 * declaration maps one-to-one to `interact.ts`, which is the supported
 * server-side control plane for the view.
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
    description:
      "Create a durable sticky note. Use this whenever the user explicitly asks to make, create, write, or save a note; dates and times inside the requested note remain note content unless the user also asks to schedule a calendar event or reminder.",
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
