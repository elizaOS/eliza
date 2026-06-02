#!/usr/bin/env bun
/**
 * Provision a throwaway Hetzner server for the nightly E2E workflow.
 *
 * Reads:
 *   HCLOUD_TOKEN_CI            - Hetzner Cloud API token (CI-scoped)
 *   CI_SSH_PUBLIC_KEY_ID       - Numeric Hetzner SSH key id (one-time uploaded)
 *   GITHUB_RUN_ID              - run id, embedded in labels
 *   HETZNER_E2E_LOCATION       - default fsn1
 *   HETZNER_E2E_SERVER_TYPE    - default cx22 (cpx11 was deprecated)
 *   HETZNER_E2E_IMAGE          - default ubuntu-24.04
 *
 * On success: prints `{id, ip}` JSON to stdout AND writes the server id
 * into the state file IMMEDIATELY after the create-call returns, before
 * any further work — so a crash never leaks a server.
 */

import {
  HetznerCloudClient,
  HetznerCloudError,
} from "@elizaos/cloud-shared/lib/services/containers/hetzner-cloud-api";
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

// Conditions under which we should try the next fallback combo. Covers
// Hetzner's "this server type can't be created here" and "this server
// type is going away" responses — both render the requested combo
// unusable and a different shared-cpu type / location is the natural
// remediation. We also treat project-wide quota exhaustion as retryable
// because the pre-reap pass runs immediately before the loop: if it
// freed any slots, the next attempt may now fit under the cap. The
// fallback ladder is finite (~5 combos) so a genuinely exhausted project
// will still surface as the last combo's error after the loop exits.
// Pure auth / billing failures (HTTP 401, real 403 without limit code)
// are NOT in this list — those are surfaced unchanged so the operator
// fixes the underlying account issue.
function isRetryableCombo(err: unknown): boolean {
  if (err instanceof HetznerCloudError && err.code === "quota_exceeded") {
    return true;
  }
  // "error during placement" (HTTP 412) is Hetzner's transient signal that the
  // requested type can't be placed in that location right now — a different
  // location usually succeeds, so keep walking the fallback ladder instead of
  // aborting the whole provision on the first capacity hiccup.
  if (err instanceof HetznerCloudError && err.status === 412) {
    return true;
  }
  const message = err instanceof Error ? err.message.toLowerCase() : "";
  return (
    message.includes("error during placement") ||
    message.includes("placement") ||
    message.includes("unsupported_server_type_for_location") ||
    message.includes("unsupported location for server type") ||
    message.includes("unsupported_location_for_server_type") ||
    message.includes("is deprecated") ||
    message.includes("server_type_deprecated") ||
    message.includes("resource_unavailable") ||
    message.includes("not_found") || // Hetzner returns 404 when a deprecated type is fully removed
    // Hetzner returns HTTP 403 with body `{ error: { code: "limit_reached",
    // message: "server limit reached" } }` when the project cap is hit.
    // Match both the apiCode and the human message so we stay correct even
    // if mapStatusToCode is bypassed (e.g. transport layer wraps the body).
    message.includes("server limit reached") ||
    message.includes("limit_reached") ||
    message.includes("resource_limit_exceeded")
  );
}

// Pre-provision reap: delete any prior CI servers older than this. Stops a
// chain of failed runs (which leak servers because teardown only fires when
// provision succeeds) from blocking new runs with "server limit reached".
// 20min is well above the ~10min healthy E2E budget; anything older is
// guaranteed dead. The half-hourly reaper workflow handles the >60min case;
// this is the fast lane.
const PRE_REAP_AGE_MS = 20 * 60 * 1000;

async function preReapOldServers(
  client: InstanceType<typeof HetznerCloudClient>,
): Promise<void> {
  const servers = await client
    .listServers({ ci: "true", workflow: "hetzner-e2e" })
    .catch((err: unknown) => {
      console.warn(
        `[hetzner-e2e-provision] pre-reap listServers failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [] as Awaited<ReturnType<typeof client.listServers>>;
    });
  const now = Date.now();
  for (const server of servers) {
    const created = Date.parse(server.created);
    if (!Number.isFinite(created)) continue;
    if (now - created < PRE_REAP_AGE_MS) continue;
    console.error(
      `[hetzner-e2e-provision] pre-reap deleting ${server.id} (${server.name}) age=${Math.round((now - created) / 60000)}min`,
    );
    try {
      await client.deleteServer(server.id);
    } catch (err) {
      console.warn(
        `[hetzner-e2e-provision] pre-reap delete ${server.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const token = requireEnv("HCLOUD_TOKEN_CI");
  const sshKeyId = Number.parseInt(requireEnv("CI_SSH_PUBLIC_KEY_ID"), 10);
  if (!Number.isFinite(sshKeyId)) {
    throw new Error(
      "CI_SSH_PUBLIC_KEY_ID must be a numeric Hetzner SSH key id",
    );
  }

  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const requestedLocation = process.env.HETZNER_E2E_LOCATION ?? "fsn1";
  // cpx11 was deprecated in 2026Q2; cx22 is the current shared-cpu x86
  // successor (similar 2 vCPU / 4 GB footprint, same fsn1/hel1/nbg1
  // availability). Operators can still pin a specific type via env.
  const requestedServerType = process.env.HETZNER_E2E_SERVER_TYPE ?? "cx22";
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
  await preReapOldServers(client);
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
      if (!isRetryableCombo(err)) {
        // Surface a hint before propagating: a non-retryable failure on
        // the first attempt is almost always an auth/account problem
        // (missing or stale HCLOUD_TOKEN_CI, project disabled). Without
        // this, the workflow log just shows the bare HetznerCloudError
        // and the operator has to guess.
        if (err instanceof HetznerCloudError && err.code === "missing_token") {
          console.error(
            "[hetzner-e2e-provision] Hetzner rejected the token (HTTP 401/403). " +
              "Refresh HCLOUD_TOKEN_CI in the ci-hetzner-e2e GitHub environment, or verify the project is active.",
          );
        }
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[hetzner-e2e-provision] ${attempt.serverType}@${attempt.location} unavailable (${reason}); trying next fallback`,
      );
    }
  }
  if (!server) {
    // Layer 2 diagnostic: when every fallback combo also failed with
    // quota_exceeded, the operator needs a single actionable next step —
    // not a stack of "unavailable" lines that look like a transient API
    // glitch. Refresh `HCLOUD_TOKEN_CI` only if the token's project no
    // longer matches the CI project; otherwise delete leaked servers in
    // the Hetzner console (https://console.hetzner.cloud/) and re-run.
    if (
      lastError instanceof HetznerCloudError &&
      lastError.code === "quota_exceeded"
    ) {
      throw new Error(
        `Hetzner project quota exhausted across all fallback combos (last error: ${lastError.message}). ` +
          "Operator action required: pre-reap freed nothing in 20min window, and the workflow cannot proceed. " +
          "Check https://console.hetzner.cloud/ for leaked CI servers (label ci=true, workflow=hetzner-e2e), " +
          "or rotate HCLOUD_TOKEN_CI if it now points to a project with a tighter cap.",
      );
    }
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
