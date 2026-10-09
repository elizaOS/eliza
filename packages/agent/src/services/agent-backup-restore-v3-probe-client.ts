/**
 * One-shot private relay for a restore-v3 runtime probe. Reads one
 * length-prefixed probe request on stdin, forwards it to the restored
 * runtime's private socket for that attempt, and prints the attestation JSON
 * line on stdout. The probe has no effects, so stdin EOF after the frame is
 * permitted; trailing input, failure or the 10s bound exits 1 silently.
 */

import type { Buffer } from "node:buffer";
import path from "node:path";
import {
  AgentBackupRestoreV3ProbeRequestSchema,
  canonicalizeAgentBackupRestoreV3ServingValue,
} from "@elizaos/contracts/node";
import {
  AGENT_BACKUP_RESTORE_V3_PROBE_TIMEOUT_MS,
  requestAgentBackupRestoreV3Probe,
} from "./agent-backup-restore-v3-serving-probe";
import {
  parseServingEntrypointArguments,
  RESTORE_V3_PROBE_SOCKET_FILE,
  readServingFrame,
  resolveServingRoots,
  servingError,
  writeServingOutput,
} from "./agent-backup-restore-v3-serving-wire";

process.umask(0o077);
const deadline = setTimeout(() => {
  process.exitCode = 1;
  process.exit(1);
}, AGENT_BACKUP_RESTORE_V3_PROBE_TIMEOUT_MS);
let trailing = false;
const trailingInput = (bytes: Buffer) => {
  bytes.fill(0);
  trailing = true;
};

async function main(): Promise<void> {
  const options = parseServingEntrypointArguments(process.argv.slice(2));
  const request = AgentBackupRestoreV3ProbeRequestSchema.parse(
    await readServingFrame(process.stdin, 4096),
  );
  process.stdin.on("data", trailingInput);
  process.stdin.resume();
  const roots = resolveServingRoots(
    request.restoreAttemptId,
    options.testOnlyDataRoot,
  );
  const attestation = await requestAgentBackupRestoreV3Probe(
    path.join(roots.runtimeRoot, RESTORE_V3_PROBE_SOCKET_FILE),
    request,
  );
  if (trailing) throw servingError("INPUT_INVALID");
  await writeServingOutput(
    process.stdout,
    `${canonicalizeAgentBackupRestoreV3ServingValue(attestation)}\n`,
  );
}

await main()
  .catch(() => {
    // error-policy:J1 Only a failed exit crosses the private process boundary.
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(deadline);
    process.stdin.removeListener("data", trailingInput);
    process.stdin.destroy();
  });
