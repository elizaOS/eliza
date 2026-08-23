/**
 * Runs the source scenario CLI without its process-exit shim and records the
 * bounded active-handle state after cleanup, so natural process quiescence is
 * part of Cloud stability evidence rather than hidden by a forced exit.
 */

import { writeFile } from "node:fs/promises";
import { runCli } from "@elizaos/scenario-runner/cli";

type ProcessWithDiagnostics = NodeJS.Process & {
  _getActiveHandles?: () => unknown[];
  _getActiveRequests?: () => unknown[];
};

function describe(value: unknown): { constructorName: string; fd?: number } {
  const record = value as { constructor?: { name?: unknown }; fd?: unknown };
  return {
    constructorName:
      typeof record?.constructor?.name === "string"
        ? record.constructor.name.slice(0, 160)
        : "unknown",
    ...(Number.isSafeInteger(record?.fd) ? { fd: record.fd as number } : {}),
  };
}

async function writeQuiescenceEvidence(): Promise<void> {
  const evidencePath = process.env.ELIZA_STABILITY_CHILD_QUIESCENCE_LEDGER;
  if (!evidencePath) {
    throw new Error("missing ELIZA_STABILITY_CHILD_QUIESCENCE_LEDGER");
  }
  const diagnosticProcess = process as ProcessWithDiagnostics;
  const payload = JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      handles: (diagnosticProcess._getActiveHandles?.() ?? [])
        .map(describe)
        .slice(0, 256),
      requests: (diagnosticProcess._getActiveRequests?.() ?? [])
        .map(describe)
        .slice(0, 256),
    },
    null,
    2,
  );
  if (Buffer.byteLength(payload) > 256 * 1024) {
    throw new Error("child quiescence evidence exceeded 256 KiB");
  }
  await writeFile(evidencePath, payload, { encoding: "utf8", mode: 0o600 });
}

try {
  process.exitCode = await runCli(process.argv.slice(2));
  await writeQuiescenceEvidence();
} catch (error) {
  // error-policy:J1 The source-child boundary retains failure and exits naturally.
  process.stderr.write(
    `[cloud-stability-child] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
  await writeQuiescenceEvidence();
}
