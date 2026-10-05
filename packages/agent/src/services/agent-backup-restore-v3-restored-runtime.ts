/**
 * Long-running entrypoint that serves one committed restore-v3 generation:
 * `node .../agent-backup-restore-v3-restored-runtime.js <restoreAttemptId>`.
 * It takes the exclusive runtime lock, consumes the one-shot boot grant, boots
 * the normal API server on the committed generation, and only then opens the
 * private probe socket. Boot failure exits non-zero and never creates the
 * socket. The activation token exists only in this process's memory.
 */

import type { Buffer } from "node:buffer";
import { agentBackupRestoreV3ContainerRoots } from "@elizaos/contracts/node";
import { logger } from "@elizaos/core";
import {
  captureHostExecutionBaseline,
  installProcessCrashGuards,
} from "@elizaos/host";
import {
  type AgentBackupRestoreV3ProbeServer,
  type AgentBackupRestoreV3RuntimeLock,
  acquireAgentBackupRestoreV3RuntimeLock,
  buildAgentBackupRestoreV3RuntimeAttestation,
  consumeAgentBackupRestoreV3BootGrant,
  isAgentBackupRestoreV3PortListening,
  openAgentBackupRestoreV3GrantedGeneration,
  startAgentBackupRestoreV3ProbeServer,
} from "./agent-backup-restore-v3-restored-runtime-host";
import { servingError } from "./agent-backup-restore-v3-serving-wire";

/** Opening budget for the committed-generation proof, not for the runtime. */
const OPEN_BUDGET_MS = 10 * 60_000;

process.umask(0o077);
captureHostExecutionBaseline();

let token: Buffer | undefined;
let lock: AgentBackupRestoreV3RuntimeLock | undefined;
let probe: AgentBackupRestoreV3ProbeServer | undefined;
process.on("exit", () => {
  token?.fill(0);
  probe?.closeSync();
  lock?.releaseSync();
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === undefined)
    throw servingError("INPUT_INVALID");
  const roots = agentBackupRestoreV3ContainerRoots(args[0]);
  lock = await acquireAgentBackupRestoreV3RuntimeLock(roots.runtimeRoot);
  const consumed = await consumeAgentBackupRestoreV3BootGrant(
    roots.runtimeRoot,
    args[0],
  );
  token = consumed.token;
  const { grant } = consumed;
  const generation = await openAgentBackupRestoreV3GrantedGeneration({
    roots,
    grant,
    control: {
      signal: new AbortController().signal,
      deadlineEpochMs: Date.now() + OPEN_BUDGET_MS,
    },
  });
  // The committed generation is the only state and database this boot may use.
  process.env.ELIZA_STATE_DIR = generation.receipt.paths.state;
  process.env.PGLITE_DATA_DIR = generation.receipt.paths.database;
  installProcessCrashGuards({ onUncaughtException: "restart" });
  const { startElizaProcess } = await import("../runtime/eliza");
  let listenPort: number | undefined;
  const runtime = await startElizaProcess({
    serverOnly: true,
    restoredGeneration: generation,
    onApiServerListening: (port) => {
      listenPort = port;
    },
    onLifecycleReady: (lifecycle) => {
      lifecycle.addTeardown(async () => {
        await probe?.close();
        token?.fill(0);
        await lock?.release();
        await generation.close();
      });
    },
  });
  if (
    !runtime ||
    runtime.agentId !== grant.agentId ||
    listenPort === undefined ||
    !(await isAgentBackupRestoreV3PortListening(listenPort))
  )
    throw servingError("BOOT_UNPROVEN");
  const port = listenPort;
  probe = await startAgentBackupRestoreV3ProbeServer({
    runtimeRoot: roots.runtimeRoot,
    restoreAttemptId: grant.restoreAttemptId,
    answer: async (request) => {
      const state = runtime.getLifecycleState?.();
      if (
        !token ||
        state !== "running" ||
        runtime.agentId !== grant.agentId ||
        typeof runtime.character.name !== "string"
      )
        return null;
      generation.assertEnvironment();
      await generation.assertFiles();
      if (!(await isAgentBackupRestoreV3PortListening(port))) return null;
      return buildAgentBackupRestoreV3RuntimeAttestation(
        grant,
        token,
        request.nonce,
        { listenPort: port, characterName: runtime.character.name },
      );
    },
  });
}

await main().catch((cause: unknown) => {
  // error-policy:J1 Boot diagnostics may carry restored content; only the
  // typed code is logged before the non-zero exit.
  logger.error(
    {
      src: "agent-backup-restore-v3",
      code: (cause as { code?: unknown } | null)?.code,
    },
    "Restored runtime boot failed",
  );
  token?.fill(0);
  process.exit(1);
});
