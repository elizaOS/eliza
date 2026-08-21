/**
 * FILE `write` handler: writes full file contents after a SandboxService path
 * check and a FileStateService writability check (rejects if the file changed
 * since the last read). Flags secrets in the payload via lib/secrets before
 * writing. Supports the `device_filesystem` bridge for device targets.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  type ActionResult,
  CapabilityError,
  logger as coreLogger,
  getCapabilityRouter,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

import {
  failureToActionResult,
  readStringParam,
  userFacingSuccessResult,
} from "../lib/format.js";
import { resolveInputPath } from "../lib/path-utils.js";
import { detectSecrets } from "../lib/secrets.js";
import type { FileStateService } from "../services/file-state-service.js";
import type { SandboxService } from "../services/sandbox-service.js";
import {
  CODING_TOOLS_LOG_PREFIX,
  FILE_STATE_SERVICE,
  SANDBOX_SERVICE,
} from "../types.js";

async function writeWithCapabilityRouter(params: {
  runtime: IAgentRuntime;
  resolved: string;
  content: string;
}): Promise<
  | { ok: true; bytesWritten: number }
  | { ok: false; reason: "unavailable" | "failed"; message: string }
> {
  const router = getCapabilityRouter(params.runtime);
  if (!router) return { ok: false, reason: "unavailable", message: "" };
  try {
    const result = await router.fs.writeText({
      path: params.resolved,
      text: params.content,
      createDirectories: true,
      overwrite: true,
    });
    return { ok: true, bytesWritten: result.bytesWritten };
  } catch (error) {
    // error-policy:J1 capability-router boundary; the routed write is translated
    // into a typed failure DTO — CAPABILITY_UNAVAILABLE degrades to
    // "unavailable", any other error to "failed" — never a fabricated success.
    if (
      error instanceof CapabilityError &&
      error.code === "CAPABILITY_UNAVAILABLE"
    ) {
      return { ok: false, reason: "unavailable", message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "failed", message };
  }
}

export async function writeFileHandler(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  options: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
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
  const inputPath = resolveInputPath(runtime, conversationId, filePath);
  if (!inputPath.ok) return failureToActionResult(inputPath.failure);

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

  const validated = await sandbox.validatePath(conversationId, inputPath.value);
  if (validated.ok === false) {
    const reason =
      validated.reason === "blocked" ? "path_blocked" : "invalid_param";
    return failureToActionResult({ reason, message: validated.message });
  }

  const resolved = validated.resolved;

  const secrets = detectSecrets(content);
  if (secrets.length > 0) {
    const names = secrets.map((s) => s.name).join(", ");
    return failureToActionResult({
      reason: "invalid_param",
      message: `refusing to write content containing detected secret patterns: ${names}`,
    });
  }

  const gate = await fileState.assertWritable(conversationId, resolved);
  if (gate.ok === false) {
    // Repeated natural-language requests commonly generate the same file name
    // and complete contents. Preserve the read-before-overwrite guard for real
    // changes, but accept a byte-identical write as a verified no-op: it cannot
    // clobber a human edit and should not poison an otherwise successful run.
    if (gate.reason === "must_read_first") {
      try {
        const existing = await fs.readFile(resolved, "utf8");
        if (existing === content) {
          await fileState.recordRead(conversationId, resolved);
          const bytes = Buffer.byteLength(content, "utf8");
          const text = `No changes needed; ${resolved} already has the requested contents.`;
          if (callback) await callback({ text, source: "coding-tools" });
          return {
            ...userFacingSuccessResult(text, {
              path: resolved,
              bytes,
              unchanged: true,
            }),
            verifiedUserFacing: true,
            turnComplete: true,
          };
        }
      } catch {
        // Keep the original guard failure. A transient read error must not turn
        // into overwrite permission or hide the actionable read-first message.
      }
    }
    const reason =
      gate.reason === "stale_read" ? "stale_read" : "invalid_param";
    return failureToActionResult({ reason, message: gate.message });
  }

  const routed = await writeWithCapabilityRouter({
    runtime,
    resolved,
    content,
  });
  if (routed.ok === false && routed.reason === "failed") {
    return failureToActionResult({
      reason: "io_error",
      message: `write failed: ${routed.message}`,
    });
  }

  if (routed.ok === false) {
    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, "utf8");
    } catch (err) {
      // error-policy:J1 action boundary; the direct-write failure becomes a
      // success:false ActionResult carrying the real message for the model.
      const msg = err instanceof Error ? err.message : String(err);
      return failureToActionResult({
        reason: "io_error",
        message: `write failed: ${msg}`,
      });
    }
  }

  await fileState.recordWrite(conversationId, resolved);
  const bytes =
    routed.ok === true
      ? routed.bytesWritten
      : Buffer.byteLength(content, "utf8");
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

  // The write confirmation is the complete answer to a single-operation turn:
  // verified + turnComplete make the callback the sole delivery (the live bug
  // was "Wrote N bytes to <path>" followed by an evaluator "done. <path>").
  // Multi-step coding turns keep their evaluator — the gate requires a sole
  // completed tool with a drained queue.
  return {
    ...userFacingSuccessResult(text, {
      path: resolved,
      bytes,
    }),
    verifiedUserFacing: true,
    turnComplete: true,
  };
}
