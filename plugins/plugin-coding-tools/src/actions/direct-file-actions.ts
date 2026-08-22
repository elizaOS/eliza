/**
 * Pi-shaped READ, WRITE, and EDIT actions for focused coding loops. They share
 * the FILE umbrella's handlers and safety services while presenting small,
 * operation-specific schemas that models can call without fabricating every
 * unrelated optional FILE field.
 */
import type { Action } from "@elizaos/core";
import { CODING_TOOLS_CONTEXTS } from "../types.js";
import { editFileHandler } from "./edit.js";
import { readFileHandler } from "./read.js";
import { writeFileHandler } from "./write.js";

const DIRECT_FILE_GATE = {
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" as const },
};

export const readAction: Action = {
  name: "READ",
  ...DIRECT_FILE_GATE,
  description:
    "Read a UTF-8 text file with numbered lines. Use offset and limit for a bounded window.",
  parameters: [
    {
      name: "file_path",
      description: "Absolute file path.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "offset",
      description: "Zero-based starting line; omit for the beginning.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "limit",
      description: "Maximum lines to return; omit for the configured cap.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "expectedRevision",
      description:
        "Revision returned by the prior READ; required when continuing with a nonzero offset.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async () => true,
  handler: readFileHandler,
};

export const writeAction: Action = {
  name: "WRITE",
  ...DIRECT_FILE_GATE,
  description:
    "Create a file with complete text. Prefer EDIT for existing files; replacing one requires overwrite=true and complete replacement content.",
  parameters: [
    {
      name: "file_path",
      description: "Absolute file path.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "content",
      description: "Complete replacement file content.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "overwrite",
      description:
        "Set true only to intentionally replace an existing file after reading it completely; defaults to false.",
      required: false,
      schema: { type: "boolean" },
    },
  ],
  validate: async () => true,
  handler: writeFileHandler,
};

export const editAction: Action = {
  name: "EDIT",
  ...DIRECT_FILE_GATE,
  description:
    "Replace an exact string in a previously read file; fails on stale or ambiguous edits.",
  parameters: [
    {
      name: "file_path",
      description: "Absolute file path.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "old_string",
      description: "Exact text currently present in the file.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "new_string",
      description: "Exact replacement text.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "replace_all",
      description: "Replace every exact match; defaults to false.",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "allow_literal_escapes",
      description:
        "Set true only when literal backslash-n or backslash-r text is intentionally part of the source; defaults to false.",
      required: false,
      schema: { type: "boolean" },
    },
  ],
  validate: async () => true,
  handler: editFileHandler,
};
