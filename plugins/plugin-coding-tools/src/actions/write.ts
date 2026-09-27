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
  fileEffectReceipt,
  fileMutationResult,
} from "../lib/file-effect-receipt.js";
import {
  failureToActionResult,
  readBoolParam,
  readStringParam,
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
  | {
      ok: false;
      reason: "unavailable" | "failed" | "unverified";
      message: string;
    }
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
    // A path-translating provider acknowledges its own mapped path and echoes
    // the requested one; either must identify the file this call asked for.
    if (
      result.path !== params.resolved &&
      result.requestedPath !== params.resolved
    ) {
      return {
        ok: false,
        reason: "unverified",
        message:
          "filesystem provider acknowledged a different path; the requested write outcome is unknown",
      };
    }
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
  if (!sandbox) {
    return failureToActionResult({
      reason: "internal",
      message: "coding-tools sandbox service unavailable",
    });
  }

  const validated = await sandbox.validatePath(conversationId, inputPath.value);
  if (validated.ok === false) {
    const reason =
      validated.reason === "blocked" ? "path_blocked" : "invalid_param";
    return failureToActionResult({ reason, message: validated.message });
  }

  const resolved = validated.resolved;
  const failAtPath = (
    failure: Parameters<typeof failureToActionResult>[0],
  ): ActionResult => failureToActionResult(failure, { path: resolved });
  const fileState = runtime.getService(FILE_STATE_SERVICE) as InstanceType<
    typeof FileStateService
  > | null;
  if (!fileState) {
    return failAtPath({
      reason: "internal",
      message: "coding-tools file-state service unavailable",
    });
  }

  const gate = await fileState.assertWritable(conversationId, resolved);
  if (gate.ok === false) {
    const reason =
      gate.reason === "stale_read" ? "stale_read" : "invalid_param";
    return failAtPath({ reason, message: gate.message });
  }
  if (gate.exists && readBoolParam(options, "overwrite") !== true) {
    return failAtPath({
      reason: "invalid_param",
      message:
        "WRITE would replace the entire existing file. Use EDIT for a localized change, or set overwrite=true only after reading the complete file and intentionally supplying its complete replacement.",
    });
  }

  const secrets = detectSecrets(content);
  if (secrets.length > 0) {
    const names = secrets.map((s) => s.name).join(", ");
    return failAtPath({
      reason: "invalid_param",
      message: `refusing to write content containing detected secret patterns: ${names}`,
    });
  }

  const routed = await writeWithCapabilityRouter({
    runtime,
    resolved,
    content,
  });
  if (routed.ok === false && routed.reason === "unverified") {
    // The provider call already ran. A contradictory resource acknowledgment
    // proves neither the requested commit nor that nothing happened elsewhere.
    // Never fall back to a second local write or permit an automatic retry.
    return {
      ...failureToActionResult(
        { reason: "io_error", message: routed.message },
        { path: resolved, acceptance: "unknown" },
      ),
      failureProvenance: {
        kind: "persistence_error",
        boundary: "persistence",
        code: "FILE_WRITE_UNVERIFIED",
        retryable: false,
      },
    };
  }
  if (routed.ok === false && routed.reason === "failed") {
    return failAtPath({
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
      return failAtPath({
        reason: "io_error",
        message: `write failed: ${msg}`,
      });
    }
  }

  let receipt: Awaited<ReturnType<typeof fileEffectReceipt>>;
  try {
    receipt = await fileEffectReceipt({
      path: resolved,
      content,
      operation: "write",
      ...(routed.ok ? { acceptedBytes: routed.bytesWritten } : {}),
    });
  } catch (error) {
    // error-policy:J1 post-write verification boundary; the mutation may have
    // happened, but no applied receipt or success callback is fabricated.
    return {
      ...failAtPath({
        reason: "io_error",
        message: `write completed but verification failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
      failureProvenance: {
        kind: "persistence_error",
        boundary: "persistence",
        code: "FILE_WRITE_UNVERIFIED",
        retryable: false,
      },
    };
  }

  try {
    await fileState.recordWrite(conversationId, resolved);
  } catch (error) {
    // error-policy:J1 bookkeeping failed after commit; preserve the actual
    // mutation proof and do not deliver an unqualified success confirmation.
    return {
      ...failAtPath({
        reason: "internal",
        message: `write committed but file-state tracking failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
      effectReceipts: [receipt],
      failureProvenance: {
        kind: "persistence_error",
        boundary: "persistence",
        code: "FILE_STATE_TRACKING_FAILED",
        retryable: false,
      },
    };
  }
  const bytes =
    routed.ok === true
      ? routed.bytesWritten
      : Buffer.byteLength(content, "utf8");
  coreLogger.debug(
    `${CODING_TOOLS_LOG_PREFIX} WRITE ${resolved} bytes=${bytes}`,
  );

  const text = `Wrote ${bytes} byte${bytes === 1 ? "" : "s"} to ${resolved}`;
  return fileMutationResult({
    runtime,
    receipt,
    text,
    content,
    data: { path: resolved, bytes },
    callback,
  });
}
