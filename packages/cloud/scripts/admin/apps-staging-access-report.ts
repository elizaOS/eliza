import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HetznerServer } from "../../shared/src/lib/services/containers/hetzner-cloud-api";

/** Classify the configured target without exporting inventory identifiers or addresses. */
export function classifyAppsStagingHost(
  servers: HetznerServer[],
  addresses: string[],
) {
  // These are observations of provider labels and attachments, not approved
  // targets, apps-network identity or proof of guest authorization.
  const stagingControlRoleCandidates = {
    appsControlCount: 0,
    appsWorkerCount: 0,
    runningCount: 0,
    privateNetworkAttachmentObservedCount: 0,
  };
  const matches = servers.flatMap((server) => {
    const role = server.labels?.role;
    const publicAddressMatch =
      addresses.includes(server.public_net.ipv4?.ip ?? "") ||
      addresses.includes(server.public_net.ipv6?.ip ?? "");
    const privateNet: unknown = Reflect.get(server, "private_net");
    if (
      server.labels?.environment === "staging" &&
      (role === "apps-control" || role === "apps-worker")
    ) {
      if (role === "apps-control")
        stagingControlRoleCandidates.appsControlCount++;
      else stagingControlRoleCandidates.appsWorkerCount++;
      if (server.status === "running")
        stagingControlRoleCandidates.runningCount++;
      if (
        Array.isArray(privateNet) &&
        privateNet.some((network: unknown) => {
          if (network === null || typeof network !== "object") return false;
          const ip = Reflect.get(network, "ip");
          return typeof ip === "string" && isIP(ip) !== 0;
        })
      )
        stagingControlRoleCandidates.privateNetworkAttachmentObservedCount++;
    }
    const privateAddressMatch =
      Array.isArray(privateNet) &&
      privateNet.some(
        (network: unknown) =>
          network !== null &&
          typeof network === "object" &&
          typeof Reflect.get(network, "ip") === "string" &&
          addresses.includes(Reflect.get(network, "ip")),
      );
    if (!publicAddressMatch && !privateAddressMatch) return [];
    return [
      {
        running: server.status === "running",
        environment:
          server.labels?.environment === "staging" ? "staging" : "unverified",
        role:
          role === "apps-control" ||
          role === "apps-worker" ||
          role === "app-node" ||
          role === "tenant-db"
            ? role
            : "unverified",
        publicAddressMatch,
        privateAddressMatch,
      },
    ];
  });
  return {
    inventoryServerCount: servers.length,
    stagingControlRoleCandidates,
    configuredHostMatchCount: matches.length,
    matchingServer: matches.length === 1 ? matches[0] : null,
    guestAuthorizationVerified: false,
  };
}

/** Use the actual deployment key parser, but return only its public fingerprint. */
export function configuredDeployKeyFingerprint(privateKey: string): string {
  const directory = mkdtempSync(join(tmpdir(), "apps-staging-key-"));
  try {
    const keyPath = join(directory, "key");
    const publicPath = join(directory, "public");
    writeFileSync(keyPath, `${privateKey.trim()}\n`, { mode: 0o600 });
    const publicKey = execFileSync(
      "ssh-keygen",
      ["-y", "-P", "", "-f", keyPath],
      {
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    writeFileSync(publicPath, publicKey, { mode: 0o600 });
    const description = execFileSync(
      "ssh-keygen",
      ["-E", "sha256", "-lf", publicPath],
      {
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const fingerprint = description.split(/\s+/)[1];
    if (!/^SHA256:[A-Za-z0-9+/]+$/.test(fingerprint ?? "")) throw new Error();
    return fingerprint;
  } catch {
    throw new Error("configured_deploy_key_unreadable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const host = process.env.ELIZA_APPS_WORKER_HOST?.trim();
  const key = process.env.ELIZA_APPS_WORKER_SSH_KEY;
  const token = process.env.HCLOUD_APPS_TOKEN;
  if (!host || !key || !token)
    throw new Error("protected_configuration_missing");
  if (
    process.env.NODE_ENV !== "production" ||
    process.env.HCLOUD_API_BASE_URL
  ) {
    throw new Error("provider_origin_not_pinned");
  }
  if (
    !isIP(host) &&
    !/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)
  ) {
    throw new Error("configured_host_invalid");
  }
  const fingerprint = configuredDeployKeyFingerprint(key);
  let addresses: string[];
  try {
    addresses = isIP(host)
      ? [host]
      : (await lookup(host, { all: true })).map((result) => result.address);
  } catch {
    throw new Error("configured_host_dns_failed");
  }
  // Import only after configuration checks. The existing client owns pagination and provider transport.
  const { HetznerCloudClient } = await import(
    "../../shared/src/lib/services/containers/hetzner-cloud-api"
  );
  let servers: HetznerServer[];
  try {
    servers = await HetznerCloudClient.withToken(token).listServers();
  } catch {
    throw new Error("apps_project_inventory_failed");
  }
  const report = classifyAppsStagingHost(servers, addresses);
  console.log(
    JSON.stringify({
      sourceCommit: process.env.GITHUB_SHA,
      environment: "staging",
      configuredDeployKeyFingerprint: fingerprint,
      configuredHostType: isIP(host) ? "ip" : "hostname",
      ...report,
    }),
  );
  const match = report.matchingServer;
  if (
    !match?.running ||
    match.environment !== "staging" ||
    (match.role !== "apps-control" && match.role !== "apps-worker")
  )
    process.exitCode = 1;
}

export function appsStagingReportFailure(error: unknown) {
  // These messages are closed local classifications, never provider bytes or a key parser's stderr.
  const codes = [
    "protected_configuration_missing",
    "provider_origin_not_pinned",
    "configured_host_invalid",
    "configured_deploy_key_unreadable",
    "configured_host_dns_failed",
    "apps_project_inventory_failed",
  ];
  return {
    environment: "staging",
    guestAuthorizationVerified: false,
    error:
      error instanceof Error && codes.includes(error.message)
        ? error.message
        : "report_failed",
  };
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.log(JSON.stringify(appsStagingReportFailure(error)));
    process.exitCode = 1;
  });
}
