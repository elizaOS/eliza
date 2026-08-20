/**
 * Validates that a reviewed Terraform plan mutates only additive canonical
 * wildcard certificate and hosted-site DNS resources for one environment.
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function validateCanonicalEdgeAdditivePlan(plan, environment) {
  if (environment !== "staging" && environment !== "production") {
    return [`unsupported environment: ${environment}`];
  }
  const siteWildcard =
    environment === "production"
      ? "*.sites.eliza.app"
      : "*.sites-staging.eliza.app";
  const packPrefix = "cloudflare_certificate_pack.canonical_edge[";
  const dnsPrefix = `cloudflare_dns_record.canonical_edge_wildcard["${siteWildcard}|`;
  const changes = plan.resource_changes ?? [];
  let packTargets = 0;
  let dnsTargets = 0;
  let creates = 0;
  const failures = [];

  for (const resource of changes) {
    const actions = resource.change?.actions ?? [];
    if (resource.change?.importing) {
      failures.push(
        `${resource.address}: import is not additive infrastructure creation`,
      );
      continue;
    }
    const noOp = actions.length === 1 && actions[0] === "no-op";
    if (resource.mode !== "managed" || noOp) continue;
    const isPack = resource.address.startsWith(packPrefix);
    const isSiteDns = resource.address.startsWith(dnsPrefix);
    if (!isPack && !isSiteDns) {
      failures.push(
        `${resource.address}: out-of-scope action ${actions.join("/")}`,
      );
      continue;
    }
    if (actions.length !== 1 || actions[0] !== "create") {
      failures.push(
        `${resource.address}: non-additive action ${actions.join("/")}`,
      );
      continue;
    }
    creates += 1;
  }

  for (const resource of changes) {
    if (resource.mode !== "managed") continue;
    if (resource.address.startsWith(packPrefix)) packTargets += 1;
    if (resource.address.startsWith(dnsPrefix)) dnsTargets += 1;
  }
  if (packTargets === 0) failures.push("no canonical certificate-pack targets");
  if (dnsTargets === 0) failures.push("no hosted-site wildcard DNS targets");
  if (creates === 0)
    failures.push("scope contains no additive resource creation");
  return failures;
}

function main() {
  const [planPath, environment] = process.argv.slice(2);
  if (!planPath || !environment) {
    console.error(
      "::error::Usage: validate-terraform-canonical-edge-additive-plan.mjs <plan-json> <staging|production>",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const failures = validateCanonicalEdgeAdditivePlan(plan, environment);
    if (failures.length > 0) {
      console.error(
        `::error::Reviewed canonical-edge plan is not additive-only: ${failures.join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log("Reviewed additive-only canonical-edge plan.");
  } catch (error) {
    console.error(
      `::error::Unable to validate reviewed canonical-edge plan: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
