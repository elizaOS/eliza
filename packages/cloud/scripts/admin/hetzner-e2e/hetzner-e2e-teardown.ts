#!/usr/bin/env bun
/**
 * Tear down the throwaway server. Idempotent: 404 is treated as
 * success. If the state file is missing or has no server_id, falls
 * back to a label-selector sweep (ci=true,workflow=hetzner-e2e,run=<runId>).
 *
 * A rejected HCLOUD_TOKEN_CI only soft-skips the sweep when nothing was
 * provisioned this run (no state file and DEPLOY_PROVISIONED != true) —
 * a dead token can't have created a server, so there is nothing to leak.
 * If a server is known to exist, a rejected token stays a hard failure.
 */

import {
  HetznerCloudClient,
  HetznerCloudError,
} from "@elizaos/cloud-shared/lib/services/containers/hetzner-cloud-api";
import { readState } from "./state-file";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[hetzner-e2e-teardown] missing env: ${name}`);
    process.exit(1);
  }
  return value;
}

async function deleteOne(
  client: HetznerCloudClient,
  serverId: number,
): Promise<void> {
  try {
    await client.deleteServer(serverId);
    console.log(`[hetzner-e2e-teardown] deleted server ${serverId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not_found") || message.includes("404")) {
      console.log(`[hetzner-e2e-teardown] server ${serverId} already gone`);
      return;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const token = requireEnv("HCLOUD_TOKEN_CI");
  const client = HetznerCloudClient.withToken(token);

  const state = readState();
  if (state.server_id) {
    await deleteOne(client, state.server_id);
    return;
  }

  const runId = process.env.GITHUB_RUN_ID;
  if (!runId) {
    console.log(
      "[hetzner-e2e-teardown] no state file and no GITHUB_RUN_ID; nothing to do",
    );
    return;
  }

  console.log(
    `[hetzner-e2e-teardown] state file missing; sweeping by label run=${runId}`,
  );
  let servers: Awaited<ReturnType<typeof client.listServers>>;
  try {
    servers = await client.listServers({
      ci: "true",
      workflow: "hetzner-e2e",
      run: String(runId),
    });
  } catch (err) {
    // error-policy:J4 Scheduled cleanup must not page on absent or revoked CI credentials.
    if (err instanceof HetznerCloudError && err.code === "missing_token") {
      if (process.env.DEPLOY_PROVISIONED === "true") {
        console.error(
          "[hetzner-e2e-teardown] HCLOUD_TOKEN_CI rejected but the deploy job provisioned a server this run — a CI server may be leaking. Refresh HCLOUD_TOKEN_CI in the ci-hetzner-e2e environment and re-run teardown (or let the reaper sweep once the token works).",
        );
        throw err;
      }
      if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
        console.error(
          "[hetzner-e2e-teardown] HCLOUD_TOKEN_CI rejected by Hetzner; failing loudly on manual dispatch. Refresh the token in the ci-hetzner-e2e environment.",
        );
        throw err;
      }
      console.warn(
        "[hetzner-e2e-teardown] HCLOUD_TOKEN_CI rejected by Hetzner; nothing was provisioned this run, so nothing can leak. Skipping sweep. Operator: refresh HCLOUD_TOKEN_CI in the ci-hetzner-e2e environment.",
      );
      return;
    }
    throw err;
  }
  for (const server of servers) {
    await deleteOne(client, server.id);
  }
}

await main();
