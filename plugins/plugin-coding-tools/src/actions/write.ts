import * as fs from "node:fs/promises";
import * as path from "node:path";

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
import { detectSecrets } from "../lib/secrets.js";
import type { FileStateService } from "../services/file-state-service.js";
import type { SandboxService } from "../services/sandbox-service.js";
import {
  CODING_TOOLS_CONTEXTS,
  CODING_TOOLS_LOG_PREFIX,
  FILE_STATE_SERVICE,
  SANDBOX_SERVICE,
} from "../types.js";

export const writeAction: Action = {
  name: "WRITE",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  similes: ["WRITE_FILE", "CREATE_FILE"],
  description:
    "Write a file at an absolute path, replacing any existing contents. The file's parent directory is created if missing. Existing files must have been READ in this session first; otherwise the write is rejected to avoid clobbering external edits.",
  descriptionCompressed:
    "Write a file at an absolute path (creates parents; rejects if existing file was not READ first).",
  parameters: [
    {
      name: "file_path",
      description: "Absolute path to the file to write.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "content",
      description: "Full new file contents.",
      required: true,
      schema: { type: "string" },
    },
  ],
  validate: async (runtime: IAgentRuntime) => {
    const d = runtime.getSetting?.("CODING_TOOLS_DISABLE");
    if (d === true || d === "true" || d === "1") return false;
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

    const filePath = readStringParam(options, "file_path");
    const content = readStringParam(options, "content");
    if (!filePath) {
      return failureToActionResult({
        reason: "missing_param",
        message: "file_path is required",
      });
    }
    if (content === undefined) {
      return failureToActionResult({
        reason: "missing_param",
        message: "content is required",
      });
    }

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

    const validated = await sandbox.validatePath(conversationId, filePath);
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

    const secrets = detectSecrets(content);
    if (secrets.length > 0) {
      const names = secrets.map((s) => s.name).join(", ");
      return failureToActionResult({
        reason: "invalid_param",
        message: `refusing to write content containing detected secret patterns: ${names}`,
      });
    }

    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return failureToActionResult({
        reason: "io_error",
        message: `write failed: ${msg}`,
      });
    }

    await fileState.recordWrite(conversationId, resolved);
    const bytes = Buffer.byteLength(content, "utf8");
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} WRITE ${resolved} bytes=${bytes}`,
    );

    const maxActionResultBytes = 2000;
    const text =
      `Wrote ${bytes} byte${bytes === 1 ? "" : "s"} to ${resolved}`.slice(
        0,
        maxActionResultBytes,
      );
    if (callback) await callback({ text, source: "coding-tools" });

    return successActionResult(text, {
      path: resolved,
      bytes,
    });
  },
};
