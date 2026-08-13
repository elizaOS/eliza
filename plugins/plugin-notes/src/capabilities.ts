/**
 * Planner-visible server capabilities for the managed Cloud Notes view. Each
 * declaration maps one-to-one to `interact.ts`, which is the supported
 * server-side control plane for the view.
 */

import type { ViewCapability, ViewCapabilityParameter } from "@elizaos/core";

const CONTENT_PARAM: ViewCapabilityParameter = {
  type: "string",
  description:
    "The complete note exactly as the user wants it written. Put an optional short label on the first line and details on later lines; never invent a separate title or summary.",
  minLength: 1,
  maxLength: 20_000,
  pattern: "\\S",
};

const QUERY_PARAM: ViewCapabilityParameter = {
  type: "string",
  description: "Unique text contained anywhere in the note.",
  minLength: 1,
  maxLength: 20_000,
  pattern: "\\S",
};

const COLOR_PARAM: ViewCapabilityParameter = {
  type: "string",
  description: "Optional color: yellow, green, rose, or slate.",
  enum: ["yellow", "green", "rose", "slate"],
};

const CONFIRM_PARAM: ViewCapabilityParameter = {
  type: "boolean",
  description:
    "Must be true after the user explicitly confirms deleting every note.",
  required: true,
  enum: [true],
};

const EXPECTED_REVISION_PARAM: ViewCapabilityParameter = {
  type: "integer",
  description:
    "Current notes revision from the latest snapshot; must match at execution time.",
  required: true,
  minimum: 0,
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

const TITLE_PARAM: ViewCapabilityParameter = {
  type: "string",
  description:
    "Exact first-line label of a note to identify it. Must match a known note label exactly.",
  minLength: 1,
  maxLength: 240,
  pattern: "\\S",
};

export const NOTES_CAPABILITIES: ViewCapability[] = [
  {
    id: "get-notes",
    description:
      "List notes as structured data, optionally narrowed by unique text they contain.",
    params: {
      query: { ...QUERY_PARAM, description: "Optional unique note text." },
    },
  },
  {
    id: "get-note",
    description:
      "Read one note by id, exact first-line label, or unique text it contains.",
    params: {
      id: { ...ID_PARAM.id, required: false },
      title: TITLE_PARAM,
      query: QUERY_PARAM,
    },
  },
  {
    id: "create-note",
    description:
      "Create a durable note from one user-authored content field. Preserve the user's wording; never invent a separate title or description. Dates and times remain note content unless the user also asks to schedule them.",
    params: {
      content: { ...CONTENT_PARAM, required: true },
      color: COLOR_PARAM,
    },
  },
  {
    id: "update-note",
    description:
      "Replace a note's complete user-authored content, change its color, or both. Identify it by id, exact first-line label, or unique existing text; never synthesize a separate title.",
    params: {
      id: { ...ID_PARAM.id, description: "Stable note id.", required: false },
      title: {
        ...TITLE_PARAM,
        description: "Exact first-line label identifying the note to update.",
      },
      query: {
        ...QUERY_PARAM,
        description: "Unique existing text identifying the note to update.",
      },
      content: {
        ...CONTENT_PARAM,
        description: "Replacement complete note content.",
      },
      color: {
        ...COLOR_PARAM,
        description: "Replacement color: yellow, green, rose, or slate.",
      },
    },
  },
  {
    id: "delete-note",
    description:
      "Delete one note by stable id, exact first-line label, or unique contained text.",
    params: {
      id: { ...ID_PARAM.id, description: "Stable note id.", required: false },
      query: QUERY_PARAM,
      title: TITLE_PARAM,
    },
  },
  {
    id: "clear-notes",
    description:
      "Delete every sticky note. Requires explicit confirmation and the current notes revision from the latest snapshot.",
    params: {
      confirm: CONFIRM_PARAM,
      expectedRevision: EXPECTED_REVISION_PARAM,
    },
  },
];
