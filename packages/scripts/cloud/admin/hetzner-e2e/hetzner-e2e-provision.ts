#!/usr/bin/env bun
/**
 * Provision a throwaway Hetzner server for the nightly E2E workflow.
 *
 * Reads:
 *   HCLOUD_TOKEN_CI            - Hetzner Cloud API token (CI-scoped)
 *   CI_SSH_PUBLIC_KEY_ID       - Numeric Hetzner SSH key id (one-time uploaded)
 *   GITHUB_RUN_ID              - run id, embedded in labels
 *   HETZNER_E2E_LOCATION       - default fsn1
 *   HETZNER_E2E_SERVER_TYPE    - default cpx11
 *   HETZNER_E2E_IMAGE          - default ubuntu-24.04
 *
 * On success: prints `{id, ip}` JSON to stdout AND writes the server id
 * into the state file IMMEDIATELY after the create-call returns, before
 * any further work — so a crash never leaks a server.
 */

import { HetznerCloudClient } from "@elizaos/cloud-shared/lib/services/containers/hetzner-cloud-api";
import { appendStateAtomic } from "./state-file";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[hetzner-e2e-provision] missing env: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const token = requireEnv("HCLOUD_TOKEN_CI");
  const sshKeyId = Number.parseInt(requireEnv("CI_SSH_PUBLIC_KEY_ID"), 10);
  if (!Number.isFinite(sshKeyId)) {
    throw new Error("CI_SSH_PUBLIC_KEY_ID must be a numeric Hetzner SSH key id");
  }

  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const location = process.env.HETZNER_E2E_LOCATION ?? "fsn1";
  const serverType = process.env.HETZNER_E2E_SERVER_TYPE ?? "cpx11";
  const image = process.env.HETZNER_E2E_IMAGE ?? "ubuntu-24.04";
  const createdAt = new Date().toISOString();

  // Minimal user-data: install docker via Hetzner's cloud-init helpers.
  const userData = [
    "#cloud-config",
    "package_update: true",
    "packages:",
    "  - docker.io",
    "  - ca-certificates",
    "runcmd:",
    "  - systemctl enable --now docker",
    "  - touch /var/lib/cloud/instance/e2e-ready",
    "",
  ].join("\n");

  const client = HetznerCloudClient.withToken(token);
  const { server } = await client.createServer({
    name: `ci-hetzner-e2e-${runId}`,
    serverType,
    location,
    image,
    userData,
    sshKeyIds: [sshKeyId],
    labels: {
      ci: "true",
      workflow: "hetzner-e2e",
      run: String(runId),
      // Hetzner label values reject ":" — use a safe ISO variant.
      created: createdAt.replace(/[:.]/g, "-"),
    },
  });

  const ip = server.public_net.ipv4?.ip ?? "";

  // Persist immediately so teardown can find it even if we crash next line.
  appendStateAtomic({
    server_id: server.id,
    ip,
    created_at: createdAt,
    run_id: String(runId),
  });

  console.log(JSON.stringify({ id: server.id, ip }));
}

await main();
