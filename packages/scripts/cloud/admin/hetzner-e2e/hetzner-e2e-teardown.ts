#!/usr/bin/env bun
/**
 * Tear down the throwaway server. Idempotent: 404 is treated as
 * success. If the state file is missing or has no server_id, falls
 * back to a label-selector sweep (ci=true,workflow=hetzner-e2e,run=<runId>).
 */

import { HetznerCloudClient } from "@elizaos/cloud-shared/lib/services/containers/hetzner-cloud-api";
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
  const servers = await client.listServers({
    ci: "true",
    workflow: "hetzner-e2e",
    run: String(runId),
  });
  for (const server of servers) {
    await deleteOne(client, server.id);
  }
}

await main();
