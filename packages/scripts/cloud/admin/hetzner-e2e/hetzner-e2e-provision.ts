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

// Hetzner periodically removes types / restricts new servers to specific
// locations. When the requested (serverType, location) pair returns
// `unsupported_location_for_server_type` (or the older `invalid_input`
// equivalent), retry with these fallbacks in order before giving up. Each
// fallback should be a cheap shared-cpu type available in at least one
// public location at the time this list was last reviewed.
const SERVER_TYPE_FALLBACKS: ReadonlyArray<{
  serverType: string;
  location: string;
}> = [
  { serverType: "cx22", location: "fsn1" }, // newer x86 shared
  { serverType: "cax11", location: "fsn1" }, // ARM shared
  { serverType: "cax11", location: "hel1" },
  { serverType: "cx22", location: "nbg1" },
  { serverType: "cax11", location: "nbg1" },
];

function isUnsupportedLocation(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : "";
  return (
    message.includes("unsupported_server_type_for_location") ||
    message.includes("unsupported location for server type") ||
    message.includes("unsupported_location_for_server_type")
  );
}

async function main(): Promise<void> {
  const token = requireEnv("HCLOUD_TOKEN_CI");
  const sshKeyId = Number.parseInt(requireEnv("CI_SSH_PUBLIC_KEY_ID"), 10);
  if (!Number.isFinite(sshKeyId)) {
    throw new Error("CI_SSH_PUBLIC_KEY_ID must be a numeric Hetzner SSH key id");
  }

  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const requestedLocation = process.env.HETZNER_E2E_LOCATION ?? "fsn1";
  const requestedServerType = process.env.HETZNER_E2E_SERVER_TYPE ?? "cpx11";
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
  const attempts: Array<{ serverType: string; location: string }> = [
    { serverType: requestedServerType, location: requestedLocation },
    ...SERVER_TYPE_FALLBACKS.filter(
      (combo) =>
        !(
          combo.serverType === requestedServerType &&
          combo.location === requestedLocation
        ),
    ),
  ];

  let server: Awaited<ReturnType<typeof client.createServer>>["server"] | null =
    null;
  let lastError: unknown;
  let serverType = requestedServerType;
  let location = requestedLocation;
  for (const attempt of attempts) {
    try {
      const created = await client.createServer({
        name: `ci-hetzner-e2e-${runId}`,
        serverType: attempt.serverType,
        location: attempt.location,
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
      server = created.server;
      serverType = attempt.serverType;
      location = attempt.location;
      if (
        attempt.serverType !== requestedServerType ||
        attempt.location !== requestedLocation
      ) {
        console.error(
          `[hetzner-e2e-provision] requested ${requestedServerType}@${requestedLocation} was unavailable; succeeded with ${attempt.serverType}@${attempt.location}`,
        );
      }
      break;
    } catch (err) {
      lastError = err;
      if (!isUnsupportedLocation(err)) throw err;
      console.error(
        `[hetzner-e2e-provision] ${attempt.serverType}@${attempt.location} unsupported, trying next fallback`,
      );
    }
  }
  if (!server) {
    throw lastError instanceof Error
      ? lastError
      : new Error("Hetzner provisioning failed across all fallback combos");
  }

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
