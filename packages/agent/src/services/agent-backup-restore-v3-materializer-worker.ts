/**
 * One-shot private Agent restore entrypoint: no runtime, plugins or listeners.
 * The owning coordinator supplies the exact private root identities on stdin.
 * Parent disconnect aborts the operation and joins all materializers (including
 * PGlite validation children) before releasing authority or exiting.
 */

import type { Buffer } from "node:buffer";
import { openAgentBackupRestoreV3CandidateFs } from "./agent-backup-restore-v3-candidate-fs";
import { createAgentBackupRestoreV3CandidateMaterializer } from "./agent-backup-restore-v3-candidate-materializer";
import {
  materializerReceiptDigest,
  materializerWireError,
  readMaterializerRequest,
} from "./agent-backup-restore-v3-materializer-wire";

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
  const emulation = process.argv.slice(2);
  if (
    emulation.length !== 0 &&
    !(
      emulation.length === 1 &&
      emulation[0] === "--test-only-non-linux-fs" &&
      process.platform !== "linux" &&
      process.env.NODE_ENV === "test"
    )
  )
    throw materializerWireError("INPUT_INVALID");
  const { request, payload } = await readMaterializerRequest(process.stdin);
  // SSH/Docker expose stdin, not arbitrary inherited descriptors. Keeping this
  // same pipe open lets transport disconnect cancel an already-dispatched effect.
  process.stdin.on("data", trailingInput);
  process.stdin.resume();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const remaining = request.deadlineEpochMs - Date.now();
    if (abort.signal.aborted || remaining <= 0 || remaining > 2_147_483_647)
      throw materializerWireError("INTERRUPTED");
    timeout = setTimeout(() => abort.abort(), remaining);
    const control = {
      signal: abort.signal,
      deadlineEpochMs: request.deadlineEpochMs,
    };
    const candidateFs = await openAgentBackupRestoreV3CandidateFs({
      trustedRoot: request.trustedRoot,
      attemptRoot: request.attemptRoot,
      control,
      ...(emulation.length === 1
        ? { testOnlyAllowNonLinuxFdEmulation: true as const }
        : {}),
    });
    let digest: string;
    try {
      if (
        materializerReceiptDigest(candidateFs.trustedRootIdentity) !==
          materializerReceiptDigest(request.trustedRootIdentity) ||
        materializerReceiptDigest(candidateFs.attemptRootIdentity) !==
          materializerReceiptDigest(request.attemptRootIdentity)
      )
        throw materializerWireError("ROOT_CHANGED");
      const materializer =
        createAgentBackupRestoreV3CandidateMaterializer(candidateFs);
      if (request.method === "stageRecord") {
        const {
          payloadBytes: _bytes,
          payloadSha256: _hash,
          ...record
        } = request.receipt;
        digest = materializerReceiptDigest(
          await materializer.stageRecord(
            request.session,
            { ...record, payload },
            control,
          ),
        );
      } else if (request.method === "finishComponent") {
        digest = materializerReceiptDigest(
          await materializer.finishComponent(
            request.session,
            request.receipt,
            control,
          ),
        );
      } else {
        digest = materializerReceiptDigest(
          await materializer.assembleCandidate(
            request.session,
            request.receipt,
            control,
          ),
        );
      }
    } finally {
      await candidateFs.close();
    }
    if (abort.signal.aborted || Date.now() >= request.deadlineEpochMs)
      throw materializerWireError("INTERRUPTED");
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(digest, (error) =>
        error ? reject(materializerWireError("OUTPUT_FAILED")) : resolve(),
      ),
    );
  } finally {
    clearTimeout(timeout);
    payload.fill(0);
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
