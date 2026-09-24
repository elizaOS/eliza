#!/usr/bin/env node
/**
 * Concise operator status for the shared SMS gateway launch.
 *
 * This wraps the completion audit and gives the remaining physical/registrar
 * actions in a short form. It does not send SMS or mutate any external system.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const auditScript = path.join(
  scriptDir,
  "check-sms-gateway-completion-audit.mjs",
);
const defaultAuditEvidencePath = path.join(
  repoRoot,
  ".eliza-local",
  "sms-gateway-completion-audit-latest.json",
);
const defaultBlockersPath = path.join(
  repoRoot,
  ".eliza-local",
  "sms-gateway-blockers-latest.json",
);

function runAudit() {
  const result = spawnSync("node", [auditScript], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function has(output, pattern) {
  return pattern.test(output);
}

function auditEvidencePath(output) {
  const match = output.match(/\[sms-gateway-audit\] evidence=(.+)/);
  return match?.[1]?.trim() || defaultAuditEvidencePath;
}

function readAuditEvidence(evidencePath) {
  if (!fs.existsSync(evidencePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  } catch {
    return null;
  }
}

function findRequirement(evidence, key) {
  if (!Array.isArray(evidence?.requirements)) return null;
  return (
    evidence.requirements.find((requirement) => requirement.key === key) ?? null
  );
}

function supplementalSummary(requirement, predicate = () => true) {
  if (!Array.isArray(requirement?.evidence)) return null;
  const item = requirement.evidence.find(
    (entry) => entry.exists && predicate(entry),
  );
  return item?.summary ?? null;
}

function printHomepageEvidence(requirement) {
  const summary = supplementalSummary(requirement);
  if (!summary) return;
  const blockedChecks = Array.isArray(summary.blockedChecks)
    ? summary.blockedChecks
        .map((check) => `${check.name}=${check.detail}`)
        .join("; ")
    : "";
  if (blockedChecks) {
    console.log(
      `[sms-gateway-status] evidence homepage-public-dns: ${blockedChecks}`,
    );
  }
}

function printAndroidEvidence(requirement) {
  const summary = supplementalSummary(requirement);
  if (!summary) return;
  console.log(
    `[sms-gateway-status] evidence android-transport: blocker=${summary.blocker ?? "unknown"} pairing=${summary.pairingEndpointAdvertised ? "yes" : "no"} connect=${summary.connectEndpointAdvertised ? "yes" : "no"}`,
  );
}

function printBlueBubblesEvidence(requirement) {
  const validation = supplementalSummary(requirement, (entry) =>
    entry.path.includes("bluebubbles-outbound-validation"),
  );
  const egress = supplementalSummary(requirement, (entry) =>
    entry.path.includes("bluebubbles-gateway-e2e"),
  );
  if (validation) {
    console.log(
      `[sms-gateway-status] evidence bluebubbles-validation: blocker=${validation.blocker ?? "unknown"} recipient=${validation.recipient ?? "unknown"}`,
    );
  }
  if (egress) {
    console.log(
      `[sms-gateway-status] evidence bluebubbles-egress: doctor=${egress.doctorStatus ?? "unknown"} sent=${egress.sentCount ?? 0}`,
    );
  }
}

function buildBlockerBundle(evidence, evidencePath) {
  const blockedRequirements = Array.isArray(evidence?.requirements)
    ? evidence.requirements.filter(
        (requirement) => requirement.status === "blocked",
      )
    : [];
  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    gatewayPhoneNumber: evidence?.gatewayPhoneNumber ?? "+14159611510",
    auditEvidencePath: evidencePath,
    proven: Array.isArray(evidence?.proven) ? evidence.proven : [],
    blocked: blockedRequirements.map((requirement) => ({
      key: requirement.key,
      label: requirement.label,
      detail: requirement.detail,
      next: Array.isArray(requirement.next) ? requirement.next : [],
      evidence: Array.isArray(requirement.evidence) ? requirement.evidence : [],
    })),
  };
}

function writeBlockerBundle(evidence, evidencePath) {
  if (!evidence || evidence.ok) return null;
  fs.mkdirSync(path.dirname(defaultBlockersPath), { recursive: true });
  const bundle = buildBlockerBundle(evidence, evidencePath);
  fs.writeFileSync(defaultBlockersPath, `${JSON.stringify(bundle, null, 2)}\n`);
  return defaultBlockersPath;
}

function main() {
  const audit = runAudit();
  const output = audit.output;
  const evidencePath = auditEvidencePath(output);
  const evidence = readAuditEvidence(evidencePath);
  const blockersPath = writeBlockerBundle(evidence, evidencePath);
  const proven = [
    ["homepage bundle", /PROVEN homepage-bundle/],
    ["production Cloud onboarding", /PROVEN cloud-first-run/],
    ["routing contracts", /PROVEN routing-contracts/],
    ["provisioning handoff", /PROVEN provisioning-handoff/],
    ["Android APK", /PROVEN android-apk/],
    ["BlueBubbles inbound", /PROVEN bluebubbles-inbound/],
  ].filter(([, pattern]) => has(output, pattern));

  console.log(
    `[sms-gateway-status] proven=${proven.map(([label]) => label).join(", ") || "none"}`,
  );

  if (has(output, /BLOCKED homepage-public-dns/)) {
    console.log(
      "[sms-gateway-status] blocked: clear eliza.app client hold, then apply GitHub Pages DNS records with sms-gateway:homepage:dns -- --apply",
    );
    printHomepageEvidence(findRequirement(evidence, "homepage-public-dns"));
  }
  if (has(output, /BLOCKED routing-contracts/)) {
    console.log(
      "[sms-gateway-status] blocked: build linked workspaces with bun run --cwd packages/cloud/shared build:linked-workspaces, then rerun sms-gateway:status",
    );
  }
  if (has(output, /BLOCKED android-transport/)) {
    console.log(
      "[sms-gateway-status] blocked: run sms-gateway:watch:pair, open Android Wireless debugging > Pair device with pairing code, then run sms-gateway:verify",
    );
    printAndroidEvidence(findRequirement(evidence, "android-transport"));
  }
  if (has(output, /BLOCKED bluebubbles-transport/)) {
    console.log(
      "[sms-gateway-status] blocked: after explicit real-send approval, run sms-gateway:validate:bluebubbles -- --confirm-real-send, then sms-gateway:verify:bluebubbles",
    );
    printBlueBubblesEvidence(
      findRequirement(evidence, "bluebubbles-transport"),
    );
  }

  if (audit.status === 0) {
    if (fs.existsSync(evidencePath)) {
      console.log(`[sms-gateway-status] evidence=${evidencePath}`);
    }
    console.log("[sms-gateway-status] status=complete");
    return;
  }

  if (fs.existsSync(evidencePath)) {
    console.log(`[sms-gateway-status] evidence=${evidencePath}`);
  }
  if (blockersPath) {
    console.log(`[sms-gateway-status] blockers=${blockersPath}`);
  }
  console.log("[sms-gateway-status] status=blocked");
  process.exitCode = audit.status;
}

main();
