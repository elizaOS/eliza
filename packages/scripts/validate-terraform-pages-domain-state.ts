/**
 * Verifies post-apply Pages, DNS, and certificate outputs without embedding
 * executable JavaScript in a shell-quoted workflow block.
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DNS_ONLY_TYPES = new Set(["CNAME", "TXT"]);
const REQUIRED_TUNNEL_ROLES = [
  "apex-routing",
  "apex-verification",
  "wildcard-routing",
  "wildcard-certificate",
  "wildcard-verification",
];

function objectEntries(value) {
  return Object.entries(value ?? {});
}

function requireProxiedRecords(failures, label, records) {
  const entries = objectEntries(records);
  if (entries.length === 0) {
    failures.push(`${label} has no managed DNS records`);
    return;
  }
  for (const [key, record] of entries) {
    if (!record?.id)
      failures.push(`${label}.${key} has no Cloudflare record id`);
    if (record?.proxied !== true)
      failures.push(`${label}.${key} is not proxied`);
  }
}

function requireActivePacks(failures, label, packs) {
  const entries = objectEntries(packs);
  if (entries.length === 0) {
    failures.push(`${label} has no certificate generations`);
    return;
  }
  for (const [key, pack] of entries) {
    if (pack?.status !== "active") {
      failures.push(
        `${label}.${key} certificate is ${pack?.status ?? "missing"}, expected active`,
      );
    }
  }
}

function requireDnsOnlyRecords(failures, label, records) {
  const entries = objectEntries(records);
  if (entries.length === 0) {
    failures.push(`${label} has no managed DNS records`);
    return;
  }
  for (const [key, record] of entries) {
    if (!record?.id)
      failures.push(`${label}.${key} has no Cloudflare record id`);
    if (record?.proxied !== false) {
      failures.push(`${label}.${key} must remain DNS-only`);
    }
    if (!DNS_ONLY_TYPES.has(record?.type)) {
      failures.push(
        `${label}.${key} has unsupported type ${record?.type ?? "missing"}`,
      );
    }
  }
  for (const role of REQUIRED_TUNNEL_ROLES) {
    const count = entries.filter(([, record]) =>
      record?.roles?.includes(role),
    ).length;
    if (count !== 1) {
      failures.push(`${label} must cover ${role} exactly once, found ${count}`);
    }
  }
}

function requireWorkerTunnel(
  failures,
  environment,
  expectedHostname,
  tunnel,
  worker,
  canonical,
) {
  const apex =
    environment === "production"
      ? "tunnel.eliza.app"
      : "tunnel-staging.eliza.app";
  const script = `eliza-tunnel-proxy-${environment}`;
  if (
    !new RegExp(`^${script}\\.[a-z0-9-]+\\.workers\\.dev$`).test(
      expectedHostname,
    ) ||
    worker?.hostname !== expectedHostname
  ) {
    failures.push(
      "tunnel_worker does not match the selected environment Worker",
    );
  }
  const records = objectEntries(tunnel);
  const routes = objectEntries(worker?.routes);
  if (records.length !== 2 || routes.length !== 2) {
    failures.push(
      "Cloudflare tunnel requires exactly two DNS records and routes",
    );
  }
  for (const [role, name] of [
    ["apex-routing", apex],
    ["wildcard-routing", `*.${apex}`],
  ]) {
    const matches = records.filter(
      ([, record]) => record?.roles?.length === 1 && record.roles[0] === role,
    );
    if (matches.length !== 1) {
      failures.push(`Cloudflare tunnel must cover ${role} exactly once`);
      continue;
    }
    const [key, record] = matches[0];
    if (
      !record.id ||
      record.name !== name ||
      record.type !== "CNAME" ||
      record.content !== expectedHostname ||
      record.proxied !== true
    ) {
      failures.push(
        `Cloudflare tunnel ${role} DNS does not match the selected Worker`,
      );
    }
    const route = worker?.routes?.[key];
    if (
      !route?.id ||
      route.pattern !== `${name}/*` ||
      route.script !== script
    ) {
      failures.push(
        `Cloudflare tunnel ${role} route does not match the selected Worker`,
      );
    }
  }
  if (
    !objectEntries(canonical?.certificate_packs).some(
      ([, pack]) =>
        pack?.status === "active" && pack?.hosts?.includes(`*.${apex}`),
    )
  ) {
    failures.push("Cloudflare tunnel has no active wildcard certificate");
  }
}

export function validatePagesDomainState({
  canonical,
  domains,
  environment,
  expectedTunnelWorkerHostname = "",
  legacyPacks,
  redirect,
  tunnel,
  tunnelWorker,
}) {
  const failures = [];
  if (environment !== "staging" && environment !== "production") {
    return [`unsupported environment: ${environment}`];
  }

  const domainEntries = objectEntries(domains);
  if (domainEntries.length === 0) {
    failures.push("pages_domains has no managed Pages domains");
  }
  for (const [key, entry] of domainEntries) {
    if (entry?.status !== "active") {
      failures.push(
        `${key} domain is ${entry?.status ?? "missing"}, expected active`,
      );
    }
    if (!entry?.certificate_authority) {
      failures.push(`${key} has no issued certificate authority`);
    }
  }

  requireProxiedRecords(
    failures,
    "canonical_edge.dns_records",
    canonical?.dns_records,
  );
  requireProxiedRecords(
    failures,
    "canonical_edge.service_dns_records",
    canonical?.service_dns_records,
  );
  requireActivePacks(
    failures,
    "canonical_edge.certificate_packs",
    canonical?.certificate_packs,
  );
  if (expectedTunnelWorkerHostname) {
    requireWorkerTunnel(
      failures,
      environment,
      expectedTunnelWorkerHostname,
      tunnel,
      tunnelWorker,
      canonical,
    );
  } else {
    if (
      tunnelWorker?.hostname ||
      objectEntries(tunnelWorker?.routes).length > 0
    ) {
      failures.push(
        "Tunnel Worker routing is present while Railway is selected",
      );
    }
    requireDnsOnlyRecords(failures, "railway_tunnel_dns", tunnel);
  }
  requireProxiedRecords(failures, "redirect_dns.exact", redirect?.exact);
  requireProxiedRecords(
    failures,
    "redirect_dns.deep_wildcards",
    redirect?.deep_wildcards,
  );
  requireActivePacks(
    failures,
    "legacy_certificate_packs.redirect",
    legacyPacks?.redirect,
  );

  if (environment === "staging") {
    requireProxiedRecords(
      failures,
      "redirect_dns.staging_agent",
      redirect?.staging_agent,
    );
    if (legacyPacks?.staging_agent?.status !== "active") {
      failures.push(
        `legacy staging agent certificate is ${legacyPacks?.staging_agent?.status ?? "missing"}, expected active`,
      );
    }
  }

  return failures;
}

function main() {
  const [
    domainsPath,
    canonicalPath,
    tunnelPath,
    redirectPath,
    legacyPacksPath,
    environment,
    tunnelWorkerPath,
  ] = process.argv.slice(2);
  if (
    !domainsPath ||
    !canonicalPath ||
    !tunnelPath ||
    !redirectPath ||
    !legacyPacksPath ||
    !environment
  ) {
    console.error(
      "::error::Usage: validate-terraform-pages-domain-state.ts <pages-domains-json> <canonical-edge-json> <railway-tunnel-json> <redirect-dns-json> <legacy-certificate-packs-json> <staging|production> [tunnel-worker-json]",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const failures = validatePagesDomainState({
      canonical: JSON.parse(readFileSync(canonicalPath, "utf8")),
      domains: JSON.parse(readFileSync(domainsPath, "utf8")),
      environment,
      expectedTunnelWorkerHostname:
        process.env.TF_VAR_tunnel_worker_hostname ?? "",
      tunnelWorker: tunnelWorkerPath
        ? JSON.parse(readFileSync(tunnelWorkerPath, "utf8"))
        : undefined,
      legacyPacks: JSON.parse(readFileSync(legacyPacksPath, "utf8")),
      redirect: JSON.parse(readFileSync(redirectPath, "utf8")),
      tunnel: JSON.parse(readFileSync(tunnelPath, "utf8")),
    });
    if (failures.length > 0) {
      console.error(
        `::error::Pages-domain state verification failed: ${failures.join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log("Pages-domain state verification passed.");
  } catch (error) {
    console.error(
      `::error::Unable to verify Pages-domain state: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
