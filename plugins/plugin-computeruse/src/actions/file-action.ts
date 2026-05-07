import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ComputerUseService } from "../services/computer-use-service.js";
import type { FileActionParams, FileActionResult } from "../types.js";
import { resolveActionParams, toComputerUseActionResult } from "./helpers.js";

function formatFileResultText(result: FileActionResult): string {
  if (!result.success) {
    return `File action failed: ${result.error}`;
  }
  return (
    result.content ??
    result.message ??
    (result.items
      ? `Listed ${result.count ?? result.items.length} filesystem entries.`
      : "File action completed.")
  );
}

export const fileAction: Action = {
  name: "FILE_ACTION",
  contexts: ["files", "automation"],
  contextGate: { anyOf: ["files", "automation"] },
  roleGate: { minRole: "USER" },
  similes: [
    "READ_FILE",
    "WRITE_FILE",
    "EDIT_FILE",
    "DELETE_FILE",
    "LIST_DIRECTORY",
    "FILE_OPERATION",
  ],
  description:
    "Perform local filesystem operations through the computer-use service. This includes read, write, edit, append, delete, exists, list, delete_directory, upload, download, and list_downloads actions.\n\n" +
    "Why this exists: it gives the agent controlled local file access with the same approval, safety, and history path as the rest of computer use.",
  descriptionCompressed:
    "File ops: read, write, edit, append, delete, list, copy, move, rename, exists, stat.",
  parameters: [
    {
      name: "action",
      description: "File action to perform.",
      required: true,
      schema: {
        type: "string",
        enum: [
          "read",
          "write",
          "edit",
          "append",
          "delete",
          "exists",
          "list",
          "delete_directory",
          "upload",
          "download",
          "list_downloads",
        ],
      },
    },
    {
      name: "path",
      description: "Primary file or directory path.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "filepath",
      description: "Upstream alias for path.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "dirpath",
      description: "Upstream alias for directory path.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "content",
      description: "Content for write, append, or upload.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "encoding",
      description: "Encoding for read/download.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "oldText",
      description: "Replacement source text alias for edit.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "newText",
      description: "Replacement destination text alias for edit.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "old_text",
      description: "Upstream edit source text.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "new_text",
      description: "Upstream edit destination text.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "find",
      description: "Upstream alias for old_text.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "replace",
      description: "Upstream alias for new_text.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service =
      (runtime.getService("computeruse") as unknown as ComputerUseService) ??
      null;
    return !!service && service.getCapabilities().fileSystem.available;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service =
      (runtime.getService("computeruse") as unknown as ComputerUseService) ??
      null;
    if (!service) {
      return { success: false, error: "ComputerUseService not available" };
    }

    const params = resolveActionParams<FileActionParams>(message, options);
    if (!params.action) {
      if (callback) {
        await callback({ text: "File action requires an action." });
      }
      return { success: false, error: "Missing action" };
    }

    const result = await service.executeFileAction(params);
    const text = formatFileResultText(result);

    if (callback) {
      await callback({ text });
    }

    return toComputerUseActionResult({
      action: params.action,
      result,
      text,
    });
  },
};
