import type { Action, ActionResult } from "@elizaos/core";
import { CODING_TOOLS_CONTEXTS } from "../types.js";

export const fileAction: Action = {
  name: "FILE",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  description:
    "File operations: read, write, or edit a file at an absolute path. " +
    "Sub-actions: READ (read file contents), WRITE (write full file contents), EDIT (replace a string within a file).",
  descriptionCompressed: "File read/write/edit at absolute path.",
  similes: ["READ_FILE", "WRITE_FILE", "EDIT_FILE", "FILE_OPERATION", "FILE_IO"],
  subActions: ["READ", "WRITE", "EDIT"],
  subPlanner: {
    name: "file_subplanner",
    description: "Select READ, WRITE, or EDIT based on the file operation the user is requesting.",
  },
  parameters: [],
  examples: [],
  validate: async () => true,
  handler: async (): Promise<ActionResult> => ({
    success: true,
    text: "File operation routed to the selected sub-action.",
    data: { actionName: "FILE", subActions: ["READ", "WRITE", "EDIT"] },
  }),
};
