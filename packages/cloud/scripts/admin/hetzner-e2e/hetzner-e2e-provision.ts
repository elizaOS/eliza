#!/usr/bin/env bun
/**
 * Provision a throwaway Hetzner server for the nightly E2E workflow.
 *
 * Reads:
 *   HCLOUD_TOKEN_CI            - Hetzner Cloud API token (CI-scoped)
 *   CI_SSH_PUBLIC_KEY_ID       - Numeric Hetzner SSH key id (one-time uploaded)
 *   GITHUB_RUN_ID              - run id, embedded in labels
 *   HETZNER_E2E_LOCATION       - default fsn1
 *   HETZNER_E2E_SERVER_TYPE    - default cpx22
 *   HETZNER_E2E_IMAGE          - default ubuntu-24.04
 *
 * On success the CLI prints `{id, ip}` JSON and writes the canonical
 * `server_id` into the state file immediately after creation. Project-wide
 * quota failures stop after one create attempt and report only aggregate
 * capacity data so private server details never enter CI logs.
 */

import {
  HetznerCloudClient,
  HetznerCloudError,
} from "@elizaos/cloud-shared/lib/services/containers/hetzner-cloud-api";
import {
  buildProvisionFailureDiagnostic,
  type CapacityInventory,
  writeProvisionFailureDiagnostic,
} from "./hetzner-e2e-provision-diagnostic";
import { appendStateAtomic } from "./state-file";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[hetzner-e2e-provision] missing env: ${name}`);
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
  // cx22 is deprecated and cax (ARM) currently returns "error during
  // placement" for the CI project; cpx22 (x86 2c/4g) is the available shared
  // type across the EU datacenters, with cpx11 in hil (US-W) as a last resort.
  // Verified against GET /v1/datacenters .server_types.available (2026-06).
  { serverType: "cpx22", location: "nbg1" },
  { serverType: "cpx22", location: "hel1" },
  { serverType: "cpx22", location: "fsn1" },
  { serverType: "cpx11", location: "hil" }, // US-West fallback
];

// Only placement-specific failures can improve by changing type or location.
// Project quota, authentication, and billing failures apply to every combo and
// must stop immediately so CI does not issue redundant create requests.
function isRetryableCombo(err: unknown): boolean {
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
    message.includes("not_found") // Hetzner returns 404 when a deprecated type is fully removed
  );
}

function isProjectQuotaError(err: unknown): err is HetznerCloudError {
  return err instanceof HetznerCloudError && err.code === "quota_exceeded";
}

// The workflow's non-overlapping concurrency guarantees that an older tagged
// server cannot belong to another active official run when this provisioner
// starts. The age floor still protects manually created lookalikes and clocks.
const PRE_REAP_AGE_MS = 20 * 60 * 1000;

async function preReapOldServers(client: HetznerCloudClient): Promise<void> {
  const servers = await client.listServers({
    ci: "true",
    workflow: "hetzner-e2e",
  });
  const now = Date.now();
  for (const server of servers) {
    const candidate = asRecord(server);
    const labels = asRecord(candidate?.labels);
    if (
      labels?.ci !== "true" ||
      labels.workflow !== "hetzner-e2e" ||
      !Number.isSafeInteger(candidate?.id) ||
      Number(candidate?.id) <= 0 ||
      typeof candidate?.created !== "string"
    ) {
      continue;
    }
    const created = Date.parse(candidate.created);
    if (!Number.isFinite(created)) continue;
    if (now - created < PRE_REAP_AGE_MS) continue;
    const name = sanitizedDimension(candidate.name);
    console.error(
      `[hetzner-e2e-provision] pre-reap deleting ${candidate.id} (${name}) age=${Math.round((now - created) / 60000)}min`,
    );
    await client.deleteServer(Number(candidate.id));
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sanitizedDimension(value: unknown): string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    /^[A-Za-z0-9._-]+$/.test(value)
    ? value
    : "unknown";
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

async function readSanitizedCapacityInventory(
  client: HetznerCloudClient,
): Promise<CapacityInventory> {
  const response: unknown = await client.listServers();
  if (!Array.isArray(response)) {
    throw new Error(
      "Hetzner capacity inventory did not contain a server array",
    );
  }
  const servers = response;
  const inventory: CapacityInventory = {
    totalServers: servers.length,
    hetznerE2eServers: 0,
    otherServers: 0,
    byStatus: {},
    byServerType: {},
    byLocation: {},
  };

  for (const server of servers) {
    const candidate = asRecord(server);
    const labels = asRecord(candidate?.labels);
    const isHetznerE2e =
      labels?.ci === "true" && labels.workflow === "hetzner-e2e";
    if (isHetznerE2e) {
      inventory.hetznerE2eServers++;
    } else {
      inventory.otherServers++;
    }
    const serverType = asRecord(candidate?.server_type);
    const datacenter = asRecord(candidate?.datacenter);
    const location = asRecord(datacenter?.location);
    incrementCount(inventory.byStatus, sanitizedDimension(candidate?.status));
    incrementCount(
      inventory.byServerType,
      sanitizedDimension(serverType?.name),
    );
    incrementCount(inventory.byLocation, sanitizedDimension(location?.name));
  }

  return inventory;
}

export async function runHetznerE2eProvision(): Promise<{
  id: number;
  ip: string;
}> {
  const token = requireEnv("HCLOUD_TOKEN_CI");
  const sshKeyId = Number.parseInt(requireEnv("CI_SSH_PUBLIC_KEY_ID"), 10);
  if (!Number.isFinite(sshKeyId)) {
    throw new Error(
      "CI_SSH_PUBLIC_KEY_ID must be a numeric Hetzner SSH key id",
    );
  }

  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone GitHub Actions script is outside Turbo task caching.
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone GitHub Actions script is outside Turbo task caching.
  const requestedLocation = process.env.HETZNER_E2E_LOCATION ?? "fsn1";
  // cx22 is now deprecated; cpx22 (x86 2 vCPU / 4 GB) is the current shared
  // type available across fsn1/hel1/nbg1 per GET /v1/datacenters. Operators can
  // still pin a specific type via env.
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone GitHub Actions script is outside Turbo task caching.
  const requestedServerType = process.env.HETZNER_E2E_SERVER_TYPE ?? "cpx22";
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone GitHub Actions script is outside Turbo task caching.
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
      if (isProjectQuotaError(err)) {
        let inventory: CapacityInventory | null = null;
        let inventoryError: unknown;
        try {
          inventory = await readSanitizedCapacityInventory(client);
        } catch (error) {
          // error-policy:J2 The create failure remains the cause; the diagnostic failure is attached separately.
          inventoryError = error;
        }
        if (inventory) {
          console.error(
            `[hetzner-e2e-provision] project capacity inventory: ${JSON.stringify(inventory)}`,
          );
        }
        throw new HetznerE2eQuotaError(
          "quota_exceeded",
          `Hetzner project quota exhausted after ${attempt.serverType}@${attempt.location} (${err.message}). ` +
            "Operator action required: inspect project capacity or raise the server limit; changing location cannot bypass a project-wide quota.",
          err.status,
          err,
          inventory,
          inventoryError,
        );
      }
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

  return { id: server.id, ip };
}

if (import.meta.main) {
  void runHetznerE2eProvision()
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error: unknown) => {
      const diagnostic = buildProvisionFailureDiagnostic(error);
      const diagnosticPath =
        // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub Actions injects this standalone script path.
        process.env.HETZNER_E2E_DIAGNOSTIC_FILE ??
        "/tmp/hetzner-e2e-provision-diagnostic.json";
      try {
        writeProvisionFailureDiagnostic(diagnosticPath, diagnostic);
      } catch (diagnosticWriteError) {
        // error-policy:J2 Preserve the provisioning failure if its reporting boundary also fails.
        throw new AggregateError(
          [error, diagnosticWriteError],
          "Hetzner provisioning failed and its structured diagnostic could not be written",
          { cause: error },
        );
      }
      console.error(
        `[hetzner-e2e-provision] failure diagnostic: ${JSON.stringify(diagnostic)}`,
      );
      console.error(error);
      process.exitCode = 1;
    });
}

class HetznerE2eQuotaError extends HetznerCloudError {
  constructor(
    code: "quota_exceeded",
    message: string,
    status: number | undefined,
    cause: unknown,
    public readonly inventory: CapacityInventory | null,
    public readonly inventoryError: unknown,
  ) {
    super(code, message, status, cause);
    this.name = "HetznerE2eQuotaError";
  }
}
