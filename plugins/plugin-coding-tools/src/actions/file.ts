import type { Action, ActionResult } from "@elizaos/core";
import { CODING_TOOLS_CONTEXTS } from "../types.js";
import { editAction } from "./edit.js";
import { readAction } from "./read.js";
import { writeAction } from "./write.js";

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
  subActions: [readAction, writeAction, editAction],
  subPlanner: {
    name: "file_subplanner",
    description: "Select READ, WRITE, or EDIT based on the file operation the user is requesting.",
  },
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Read /tmp/notes.md.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Reading the file.",
          actions: ["FILE"],
          thought:
            "Read intent on an absolute path dispatches via FILE to the READ sub-action.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Write 'hello world' to /tmp/test.txt.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Wrote /tmp/test.txt.",
          actions: ["FILE"],
          thought:
            "Whole-file write dispatches via FILE to WRITE with content set.",
        },
      },
    ],
  ],
  validate: async () => true,
  handler: async (): Promise<ActionResult> => ({
    success: true,
    text: "File operation routed to the selected sub-action.",
    data: { actionName: "FILE", subActions: ["READ", "WRITE", "EDIT"] },
  }),
};
