import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ComputerUseService } from "../services/computer-use-service.js";
import type { FileActionParams as ServiceFileActionParams } from "../types.js";
import {
  appendFile,
  deleteDirectory,
  deleteFile,
  fileDownload,
  fileExists,
  fileListDownloads,
  fileUpload,
  listDirectory,
  readFile,
  writeFile,
  editFile,
} from "../platform/files.js";

type FileActionType =
  | "file_read"
  | "file_write"
  | "file_edit"
  | "file_append"
  | "file_delete"
  | "file_exists"
  | "directory_list"
  | "directory_delete"
  | "file_upload"
  | "file_download"
  | "file_list_downloads";

interface FileActionParams {
  action: FileActionType;
  path?: string;
  filepath?: string;
  dirpath?: string;
  content?: string;
  old_text?: string;
  new_text?: string;
  find?: string;
  replace?: string;
  encoding?: string;
}

type FileActionResult = {
  success: boolean;
  content?: string;
  items?: unknown[];
  message?: string;
  error?: string;
  path?: string;
  exists?: boolean;
  [key: string]: unknown;
};

function normalizeFileParams(message: Memory, options?: HandlerOptions): FileActionParams {
  const params = ((options as Record<string, unknown>)?.parameters ?? {}) as Partial<FileActionParams>;

  if (!params.action && message.content && typeof message.content === "object") {
    Object.assign(params, message.content as Record<string, unknown>);
  }

  if (params.filepath !== undefined && params.path === undefined) {
    params.path = params.filepath;
  }
  if (params.dirpath !== undefined && params.path === undefined) {
    params.path = params.dirpath;
  }
  if (params.find !== undefined && params.old_text === undefined) {
    params.old_text = params.find;
  }
  if (params.replace !== undefined && params.new_text === undefined) {
    params.new_text = params.replace;
  }

  params.action = params.action ?? "file_read";
  return params as FileActionParams;
}

export const fileAction: Action = {
  name: "FILE_ACTION",

  similes: [
    "FILE_READ",
    "FILE_WRITE",
    "FILE_EDIT",
    "FILE_APPEND",
    "FILE_DELETE",
    "FILE_EXISTS",
    "DIRECTORY_LIST",
    "DIRECTORY_DELETE",
    "MANAGE_FILES",
    "UPLOAD_FILE",
    "DOWNLOAD_FILE",
  ],

  description:
    "Perform local file operations for code changes, project inspection, generated artifacts, and local data management.\n\n" +
    "Available actions:\n" +
    "- file_read: Read a file as text.\n" +
    "- file_write: Write text to a file, creating parent directories if needed.\n" +
    "- file_edit: Replace the first occurrence of old_text with new_text.\n" +
    "- file_append: Append text to the end of a file.\n" +
    "- file_delete: Delete a file.\n" +
    "- file_exists: Check whether a file or directory exists.\n" +
    "- directory_list: List directory entries.\n" +
    "- directory_delete: Recursively delete a directory.\n" +
    "- file_upload: Alias for file_write.\n" +
    "- file_download: Alias for file_read.\n" +
    "- file_list_downloads: Alias for directory_list.\n\n" +
    "Use this for safe local filesystem work when the agent needs direct access to repository files.",

  parameters: [
    {
      name: "action",
      description: "The file action to perform",
      required: true,
      schema: {
        type: "string",
        enum: [
          "file_read",
          "file_write",
          "file_edit",
          "file_append",
          "file_delete",
          "file_exists",
          "directory_list",
          "directory_delete",
          "file_upload",
          "file_download",
          "file_list_downloads",
        ],
      },
    },
    {
      name: "path",
      description: "Path to the target file or directory.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "filepath",
      description: "Alias for path.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "dirpath",
      description: "Alias for path when acting on a directory.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "content",
      description: "Text content for file_write or file_append.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "old_text",
      description: "Text to replace in file_edit.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "new_text",
      description: "Replacement text for file_edit.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "find",
      description: "Alias for old_text.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "replace",
      description: "Alias for new_text.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "encoding",
      description: "Text encoding for file_read.",
      required: false,
      schema: { type: "string" },
    },
  ],

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Read the package.json file." },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll read the file.", action: "FILE_ACTION" },
      },
    ],
  ],

  validate: async (): Promise<boolean> => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ) => {
    const params = normalizeFileParams(message, options);
    const service = runtime.getService?.("computeruse") as unknown as ComputerUseService | undefined;

    if (service) {
      const result = await service.executeFileAction(params as unknown as ServiceFileActionParams);

      if (callback) {
        const content = typeof result.content === "string"
          ? result.content
          : Array.isArray(result.items)
            ? JSON.stringify(result.items, null, 2)
            : typeof result.message === "string"
              ? result.message
              : "";

        await callback({
          text: result.success
            ? content || "File action completed."
            : result.approvalRequired
              ? `File action is waiting for approval (${result.approvalId}).`
              : `File action failed: ${String(result.error ?? "unknown error")}`,
        });
      }

      return result;
    }

    let result: any;
    switch (params.action) {
      case "file_read":
        result = await readFile({ path: params.path ?? "", encoding: params.encoding });
        break;
      case "file_write":
        result = await writeFile({ path: params.path ?? "", content: params.content ?? "" });
        break;
      case "file_upload":
        result = await fileUpload({ path: params.path ?? "", content: params.content ?? "" });
        break;
      case "file_edit":
        result = await editFile({
          path: params.path ?? "",
          old_text: params.old_text ?? "",
          new_text: params.new_text ?? "",
        });
        break;
      case "file_append":
        result = await appendFile({ path: params.path ?? "", content: params.content ?? "" });
        break;
      case "file_delete":
        result = await deleteFile({ path: params.path ?? "" });
        break;
      case "file_exists":
        result = await fileExists({ path: params.path ?? "" });
        break;
      case "directory_list":
        result = await listDirectory({ path: params.path ?? "" });
        break;
      case "file_download":
        result = await fileDownload({ path: params.path ?? "", encoding: params.encoding });
        break;
      case "file_list_downloads":
        result = await fileListDownloads({ path: params.path ?? "" });
        break;
      case "directory_delete":
        result = await deleteDirectory({ path: params.path ?? "" });
        break;
      default:
        result = { success: false, error: `Unknown file action: ${params.action}` };
        break;
    }

    if (callback) {
      const content = typeof result.content === "string"
        ? result.content
        : Array.isArray(result.items)
          ? JSON.stringify(result.items, null, 2)
          : typeof result.message === "string"
            ? result.message
            : "";

      await callback({
        text: result.success
          ? content || "File action completed."
          : `File action failed: ${String(result.error ?? "unknown error")}`,
      });
    }

    return result as any;
  },
};

export { appendFile, deleteDirectory, deleteFile, fileDownload, fileExists, fileListDownloads, fileUpload, listDirectory, readFile, writeFile, editFile };
