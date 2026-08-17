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

export function validatePagesDomainState({
  canonical,
  domains,
  environment,
  legacyPacks,
  redirect,
  tunnel,
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
  requireDnsOnlyRecords(failures, "railway_tunnel_dns", tunnel);
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
      "::error::Usage: validate-terraform-pages-domain-state.mjs <pages-domains-json> <canonical-edge-json> <railway-tunnel-json> <redirect-dns-json> <legacy-certificate-packs-json> <staging|production>",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const failures = validatePagesDomainState({
      canonical: JSON.parse(readFileSync(canonicalPath, "utf8")),
      domains: JSON.parse(readFileSync(domainsPath, "utf8")),
      environment,
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
