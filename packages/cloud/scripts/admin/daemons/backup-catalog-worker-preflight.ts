#!/usr/bin/env -S npx tsx
/**
 * Value-redacted configuration preflight for the manifest-v3 catalogue worker.
 * Disabled mode validates only daemon controls and the two gates; enabled mode
 * loads the same production composition as the daemon, without running a cycle.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentBackupCatalogWorkerComposition } from "@elizaos/cloud-shared/lib/services/agent-backup-catalog-worker-composition";
import {
  readBackupCatalogWorkerConfig,
  safeBackupCatalogConfigurationNames,
} from "./backup-catalog-worker";

export async function preflightBackupCatalogWorker(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ enabled: boolean }> {
  readBackupCatalogWorkerConfig(env, []);
  const composition = await createAgentBackupCatalogWorkerComposition({ env });
  return { enabled: composition.enabled };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry ? path.resolve(entry) === fileURLToPath(import.meta.url) : false;
}

if (isMainModule()) {
  // The matching systemd unit passes only its dedicated allowlisted
  // EnvironmentFile. Reading cloud/.env.local here would defeat the disabled
  // no-secret boundary before the composition can inspect its gates.
  preflightBackupCatalogWorker()
    .then(({ enabled }) => {
      process.stdout.write(
        `${JSON.stringify({ check: "backup-catalog-worker-config", ok: true, enabled })}\n`,
      );
    })
    .catch((error) => {
      const names = safeBackupCatalogConfigurationNames(error);
      process.stderr.write(
        `[backup-catalog-worker-preflight] rejected${
          names.length > 0 ? ` configuration name(s): ${names.join(",")}` : ""
        }\n`,
      );
      process.exitCode = 78;
    });
}
