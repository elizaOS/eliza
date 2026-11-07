/**
 * One-shot private restore-v3 serving controller: no runtime, plugins or
 * listeners. Reads one length-prefixed controller request on stdin, keeps
 * stdin open as the liveness channel (EOF or trailing input aborts), and
 * writes exactly one canonical JSON response to stdout. Any failure exits 1
 * with no diagnostics crossing the process boundary.
 */

import { Buffer } from "node:buffer";
import {
  AGENT_BACKUP_RESTORE_V3_SERVING_LIMITS,
  AgentBackupRestoreV3ControllerRequestSchema,
  canonicalizeAgentBackupRestoreV3ServingValue,
} from "@elizaos/contracts/node";
import { runAgentBackupRestoreV3ServingController } from "./agent-backup-restore-v3-serving-controller";
import {
  parseServingEntrypointArguments,
  readServingFrame,
  resolveServingRoots,
  servingError,
  writeServingOutput,
} from "./agent-backup-restore-v3-serving-wire";

process.umask(0o077);
const abort = new AbortController();
const disconnect = () => {
  abort.abort();
  process.stdin.destroy();
};
process.stdin.on("end", disconnect);
process.stdin.on("error", disconnect);
process.stdout.on("error", disconnect);

const trailingInput = (bytes: Buffer) => {
  bytes.fill(0);
  disconnect();
};

async function main(): Promise<void> {
  const options = parseServingEntrypointArguments(process.argv.slice(2));
  const request = AgentBackupRestoreV3ControllerRequestSchema.parse(
    await readServingFrame(
      process.stdin,
      AGENT_BACKUP_RESTORE_V3_SERVING_LIMITS.requestBytes,
    ),
  );
  process.stdin.on("data", trailingInput);
  process.stdin.resume();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const remaining = request.deadlineEpochMs - Date.now();
    if (abort.signal.aborted || remaining <= 0 || remaining > 2_147_483_647)
      throw servingError("INTERRUPTED");
    timeout = setTimeout(() => abort.abort(), remaining);
    const response = await runAgentBackupRestoreV3ServingController(request, {
      roots: resolveServingRoots(
        request.restoreAttemptId,
        options.testOnlyDataRoot,
      ),
      control: {
        signal: abort.signal,
        deadlineEpochMs: request.deadlineEpochMs,
      },
      testOnlyAllowNonLinuxFdEmulation:
        options.testOnlyAllowNonLinuxFdEmulation,
    });
    if (abort.signal.aborted || Date.now() >= request.deadlineEpochMs)
      throw servingError("INTERRUPTED");
    const output = canonicalizeAgentBackupRestoreV3ServingValue(response);
    if (
      Buffer.byteLength(output) >
      AGENT_BACKUP_RESTORE_V3_SERVING_LIMITS.responseBytes
    )
      throw servingError("OUTPUT_FAILED");
    await writeServingOutput(process.stdout, output);
  } finally {
    clearTimeout(timeout);
  }
}

await main()
  .catch(() => {
    // error-policy:J1 Only a failed exit crosses the private process boundary;
    // filesystem, SQL and parser diagnostics must never expose restored content.
    process.exitCode = 1;
  })
  .finally(() => {
    process.stdout.removeListener("error", disconnect);
    process.stdin.removeListener("data", trailingInput);
    process.stdin.destroy();
  });
