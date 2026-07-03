import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  IFileStorageService,
  StoredFileListItem,
} from "@elizaos/core";
import { logger, ServiceType } from "@elizaos/core";

const FILES_OPS = ["list", "get", "delete"] as const;
type FilesOp = (typeof FILES_OPS)[number];

interface FilesParams {
  action?: string;
  op?: string;
  subaction?: string;
  fileName?: string;
  query?: string;
  limit?: number;
  confirm?: boolean;
}

function fail(text: string, error: string): ActionResult {
  return { success: false, text, data: { error } };
}

function getStorage(runtime: IAgentRuntime): IFileStorageService | null {
  return (
    runtime.getService<IFileStorageService>(ServiceType.REMOTE_FILES) ?? null
  );
}

function normalizeOp(params: FilesParams): FilesOp | undefined {
  const candidate = (params.action ?? params.subaction ?? params.op ?? "")
    .toString()
    .toLowerCase();
  return (FILES_OPS as readonly string[]).includes(candidate)
    ? (candidate as FilesOp)
    : undefined;
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function matchesQuery(file: StoredFileListItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    file.fileName.toLowerCase().includes(q) ||
    file.mimeType.toLowerCase().includes(q)
  );
}

async function doList(
  runtime: IAgentRuntime,
  params: FilesParams,
): Promise<ActionResult> {
  const storage = getStorage(runtime);
  if (!storage) {
    return fail("File storage is not available.", "FILES_NO_SERVICE");
  }
  const all = (await storage.list()).sort((a, b) => b.createdAt - a.createdAt);
  const filtered = params.query
    ? all.filter((file) => matchesQuery(file, params.query ?? ""))
    : all;
  const limit = clampLimit(params.limit, 20);
  const top = filtered.slice(0, limit);
  const text = top.length
    ? `Found ${filtered.length} file(s).${
        filtered.length > top.length ? ` Most recent ${top.length}:` : ""
      }\n${top
        .map(
          (file) =>
            `- ${file.fileName} (${file.mimeType}, ${humanSize(file.size)}) ${file.url}`,
        )
        .join("\n")}`
    : "No stored files match.";
  return {
    success: true,
    text,
    data: { files: top, total: filtered.length },
  };
}

async function doGet(
  runtime: IAgentRuntime,
  params: FilesParams,
): Promise<ActionResult> {
  const storage = getStorage(runtime);
  if (!storage) {
    return fail("File storage is not available.", "FILES_NO_SERVICE");
  }
  const name = params.fileName?.trim();
  if (!name) {
    return fail("fileName is required for op:get.", "FILES_INVALID");
  }
  const url = storage.getUrl(name);
  if (!url || !(await storage.exists(name))) {
    return fail(`No stored file named ${name}.`, "FILES_NOT_FOUND");
  }
  const item = (await storage.list()).find((file) => file.fileName === name);
  return {
    success: true,
    text: item
      ? `${name}: ${item.mimeType}, ${humanSize(item.size)} — ${url}`
      : `${name} — ${url}`,
    data: { file: item ?? { fileName: name, url } },
  };
}

async function doDelete(
  runtime: IAgentRuntime,
  params: FilesParams,
): Promise<ActionResult> {
  const storage = getStorage(runtime);
  if (!storage) {
    return fail("File storage is not available.", "FILES_NO_SERVICE");
  }
  const name = params.fileName?.trim();
  if (!name) {
    return fail("fileName is required for op:delete.", "FILES_INVALID");
  }
  if (params.confirm !== true) {
    return fail(
      "Deleting a file requires confirm:true.",
      "FILES_CONFIRM_REQUIRED",
    );
  }
  const deleted = await storage.delete(name);
  return {
    success: deleted,
    text: deleted
      ? `Deleted ${name}.`
      : `Could not delete ${name} (not found).`,
    data: { deleted, fileName: name },
  };
}

/**
 * FILES action: gives the agent read/CRUD access to the content-addressed file
 * store via {@link IFileStorageService}. op:list shows recent stored files
 * (optional query/limit); op:get returns a file's details + served URL by
 * fileName; op:delete removes a file (requires confirm:true).
 */
export const filesAction: Action = {
  name: "FILES",
  contexts: ["documents", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "LIST_FILES",
    "RECENT_FILES",
    "SHOW_FILES",
    "BROWSE_FILES",
    "GET_FILE",
    "FIND_FILE",
    "DELETE_FILE",
    "REMOVE_FILE",
  ],
  description:
    "Access stored files. op:list shows recent stored files (optional query/limit); op:get returns a file's details + served URL by fileName; op:delete removes a file (requires confirm:true).",
  descriptionCompressed:
    "list/get/delete stored files; delete requires confirm:true",
  routingHint:
    "list/get/delete the agent's stored files by filename (the content-addressed media store) -> FILES; to read an attachment or link already in THIS conversation -> ATTACHMENT (action=read), for owner document signature/approval/deadline/portal workflows -> OWNER_DOCUMENTS, or to query raw database tables/rows -> DATABASE",
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as FilesParams;
    const op = normalizeOp(params);
    if (!op) {
      return fail(
        `op is required and must be one of ${FILES_OPS.join(", ")}.`,
        "FILES_INVALID",
      );
    }
    try {
      switch (op) {
        case "list":
          return await doList(runtime, params);
        case "get":
          return await doGet(runtime, params);
        case "delete":
          return await doDelete(runtime, params);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[files:${op}] failed: ${msg}`);
      return {
        success: false,
        text: `Failed to ${op} file(s): ${msg}`,
        data: { error: `FILES_${op.toUpperCase()}_FAILED` },
      };
    }
  },
  parameters: [
    {
      name: "op",
      description: "Operation: list | get | delete",
      required: true,
      schema: { type: "string" as const, enum: [...FILES_OPS] },
    },
    {
      name: "fileName",
      description: "Stored filename (<sha256>.<ext>) — required for get/delete",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description:
        "Optional filter for op:list (matches filename or mime type substring)",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "Max results for op:list (default 20, max 100)",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "confirm",
      description: "Must be true to delete a file",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],
};
