import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";

import {
  type Action,
  type ActionResult,
  logger as coreLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

import {
  failureToActionResult,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import type { FileStateService } from "../services/file-state-service.js";
import type { SandboxService } from "../services/sandbox-service.js";
import {
  CODING_TOOLS_CONTEXTS,
  CODING_TOOLS_LOG_PREFIX,
  FILE_STATE_SERVICE,
  SANDBOX_SERVICE,
} from "../types.js";

type CellType = "code" | "markdown" | "raw";
type EditMode = "replace" | "insert" | "delete";

interface NotebookCell {
  cell_type: CellType;
  id?: string;
  metadata?: Record<string, unknown>;
  source: string[] | string;
  outputs?: unknown[];
  execution_count?: number | null;
  [key: string]: unknown;
}

interface Notebook {
  cells: NotebookCell[];
  [key: string]: unknown;
}

function isCellType(value: unknown): value is CellType {
  return value === "code" || value === "markdown" || value === "raw";
}

function isEditMode(value: unknown): value is EditMode {
  return value === "replace" || value === "insert" || value === "delete";
}

// Jupyter source-array convention: every line except the last gets a trailing
// "\n"; the trailing newline-terminator (if any) is captured implicitly.
function toJupyterSource(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split(/\n/);
  const result: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const isLast = i === parts.length - 1;
    if (isLast && parts[i] === "") continue;
    result.push(isLast ? parts[i] : `${parts[i]}\n`);
  }
  return result;
}

function newCellId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function buildCell(cellType: CellType, source: string): NotebookCell {
  const cell: NotebookCell = {
    cell_type: cellType,
    id: newCellId(),
    metadata: {},
    source: toJupyterSource(source),
  };
  if (cellType === "code") {
    cell.outputs = [];
    cell.execution_count = null;
  }
  return cell;
}

export const notebookEditAction: Action = {
  name: "NOTEBOOK_EDIT",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  similes: ["EDIT_NOTEBOOK"],
  description:
    "Replace, insert, or delete a cell in a Jupyter `.ipynb` notebook. Default `edit_mode` is `replace`. Insert places a new cell after `cell_id` (or at the start if omitted). Delete removes the matching cell. The notebook must have been READ in this session and must still match its recorded mtime.",
  descriptionCompressed:
    "Replace/insert/delete a cell in a Jupyter notebook by cell_id.",
  parameters: [
    {
      name: "notebook_path",
      description: "Absolute path to a .ipynb notebook.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "cell_id",
      description:
        "Target cell id. Required for replace and delete; optional for insert.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "new_source",
      description: "New cell source text. Required for replace and insert.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "cell_type",
      description: "Cell type: code | markdown | raw.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "edit_mode",
      description: "replace | insert | delete (default replace).",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (runtime: IAgentRuntime) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const conversationId =
      message.roomId !== undefined && message.roomId !== null
        ? String(message.roomId)
        : undefined;
    if (!conversationId) {
      return failureToActionResult({
        reason: "missing_param",
        message: "no roomId",
      });
    }

    const notebookPath = readStringParam(options, "notebook_path");
    if (!notebookPath) {
      return failureToActionResult({
        reason: "missing_param",
        message: "notebook_path is required",
      });
    }
    if (!notebookPath.endsWith(".ipynb")) {
      return failureToActionResult({
        reason: "invalid_param",
        message: `notebook_path must end with .ipynb: ${notebookPath}`,
      });
    }

    const cellId = readStringParam(options, "cell_id");
    const newSource = readStringParam(options, "new_source");
    const cellTypeRaw = readStringParam(options, "cell_type");
    const cellType: CellType | undefined = isCellType(cellTypeRaw)
      ? cellTypeRaw
      : undefined;
    if (cellTypeRaw !== undefined && cellType === undefined) {
      return failureToActionResult({
        reason: "invalid_param",
        message: `cell_type must be code | markdown | raw, got ${cellTypeRaw}`,
      });
    }

    const editModeRaw = readStringParam(options, "edit_mode") ?? "replace";
    if (!isEditMode(editModeRaw)) {
      return failureToActionResult({
        reason: "invalid_param",
        message: `edit_mode must be replace | insert | delete, got ${editModeRaw}`,
      });
    }
    const editMode: EditMode = editModeRaw;

    const sandbox = runtime.getService(SANDBOX_SERVICE) as InstanceType<
      typeof SandboxService
    > | null;
    const fileState = runtime.getService(FILE_STATE_SERVICE) as InstanceType<
      typeof FileStateService
    > | null;
    if (!sandbox || !fileState) {
      return failureToActionResult({
        reason: "internal",
        message: "coding-tools services unavailable",
      });
    }

    const validated = await sandbox.validatePath(conversationId, notebookPath);
    if (!validated.ok) {
      const reason =
        validated.reason === "blocked" ? "path_blocked" : "invalid_param";
      return failureToActionResult({ reason, message: validated.message });
    }

    const resolved = validated.resolved;

    const gate = await fileState.assertWritable(conversationId, resolved);
    if (!gate.ok) {
      const reason =
        gate.reason === "stale_read" ? "stale_read" : "invalid_param";
      return failureToActionResult({ reason, message: gate.message });
    }

    let raw: string;
    try {
      raw = await fs.readFile(resolved, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return failureToActionResult({
        reason: "io_error",
        message: `read failed: ${msg}`,
      });
    }

    let notebook: Notebook;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray((parsed as Record<string, unknown>).cells)
      ) {
        throw new Error("notebook missing cells array");
      }
      notebook = parsed as Notebook;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return failureToActionResult({
        reason: "io_error",
        message: `parse failed: ${msg}`,
      });
    }

    if (editMode === "replace") {
      if (!cellId) {
        return failureToActionResult({
          reason: "missing_param",
          message: "cell_id is required for edit_mode=replace",
        });
      }
      if (newSource === undefined) {
        return failureToActionResult({
          reason: "missing_param",
          message: "new_source is required for edit_mode=replace",
        });
      }
      const idx = notebook.cells.findIndex((cell) => cell.id === cellId);
      if (idx === -1) {
        return failureToActionResult({
          reason: "no_match",
          message: `no cell with id=${cellId} in ${resolved}`,
        });
      }
      const target = notebook.cells[idx];
      target.source = toJupyterSource(newSource);
      if (cellType) target.cell_type = cellType;
    } else if (editMode === "insert") {
      if (newSource === undefined) {
        return failureToActionResult({
          reason: "missing_param",
          message: "new_source is required for edit_mode=insert",
        });
      }
      const insertCellType: CellType = cellType ?? "code";
      const newCell = buildCell(insertCellType, newSource);
      if (cellId) {
        const idx = notebook.cells.findIndex((cell) => cell.id === cellId);
        if (idx === -1) {
          return failureToActionResult({
            reason: "no_match",
            message: `no cell with id=${cellId} in ${resolved}`,
          });
        }
        notebook.cells.splice(idx + 1, 0, newCell);
      } else {
        notebook.cells.unshift(newCell);
      }
    } else {
      // delete
      if (!cellId) {
        return failureToActionResult({
          reason: "missing_param",
          message: "cell_id is required for edit_mode=delete",
        });
      }
      const idx = notebook.cells.findIndex((cell) => cell.id === cellId);
      if (idx === -1) {
        return failureToActionResult({
          reason: "no_match",
          message: `no cell with id=${cellId} in ${resolved}`,
        });
      }
      notebook.cells.splice(idx, 1);
    }

    const serialized = JSON.stringify(notebook, null, 1);
    try {
      await fs.writeFile(resolved, serialized, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return failureToActionResult({
        reason: "io_error",
        message: `write failed: ${msg}`,
      });
    }

    await fileState.recordWrite(conversationId, resolved);
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} NOTEBOOK_EDIT ${resolved} mode=${editMode} cells=${notebook.cells.length}`,
    );

    const maxNotebookCells = 5000;
    const text =
      `Notebook ${editMode} on ${resolved} (cells now ${notebook.cells.length})`.slice(
        0,
        2000,
      );
    if (callback) await callback({ text, source: "coding-tools" });

    return successActionResult(text, {
      path: resolved,
      mode: editMode,
      cells: Math.min(notebook.cells.length, maxNotebookCells),
    });
  },
};
