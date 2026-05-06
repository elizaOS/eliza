/**
 * `ignore` tool — signals the loop to stop without producing a user-visible reply.
 *
 * The loop short-circuits on this tool name *before* invoking the handler,
 * so the handler is mostly here for completeness / direct testing.
 */

import type { NativeTool, NativeToolHandler } from "../tool-schema.js";

export const tool: NativeTool = {
  type: "custom",
  name: "ignore",
  description:
    "Stop and do not reply. Use when the message doesn't warrant a response " +
    "(e.g., not addressed to you, ambient chatter, low signal).",
  input_schema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

export const handler: NativeToolHandler = async () => {
  return { content: "ignored" };
};
