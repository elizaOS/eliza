#!/usr/bin/env bun
/**
 * Sweep stale CI servers older than 60 minutes. Run on a schedule so a
 * crashed workflow can't leak servers indefinitely. Gracefully exits 0
 * when HCLOUD_TOKEN_CI is unset (so it doesn't spam-fail before secrets
 * are configured).
 */

import { HetznerCloudClient } from "@elizaos/cloud-shared/lib/services/containers/hetzner-cloud-api";

const MAX_AGE_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const token = process.env.HCLOUD_TOKEN_CI;
  if (!token) {
    console.log("[hetzner-e2e-reaper] HCLOUD_TOKEN_CI not set; skipping");
    return;
  }
  const client = HetznerCloudClient.withToken(token);
  const servers = await client.listServers({
    ci: "true",
    workflow: "hetzner-e2e",
  });
  const now = Date.now();
  let deleted = 0;
  for (const server of servers) {
    const created = Date.parse(server.created);
    if (!Number.isFinite(created)) continue;
    const ageMs = now - created;
    if (ageMs < MAX_AGE_MS) continue;
    console.log(
      `[hetzner-e2e-reaper] deleting ${server.id} (${server.name}) age=${Math.round(ageMs / 60000)}min`,
    );
    try {
      await client.deleteServer(server.id);
      deleted++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[hetzner-e2e-reaper] delete ${server.id} failed: ${message}`,
      );
    }
  }
  console.log(
    `[hetzner-e2e-reaper] swept ${deleted}/${servers.length} servers`,
  );
}

await main();
