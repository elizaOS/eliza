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
const auditScript = path.join(scriptDir, "check-sms-gateway-completion-audit.mjs");
const defaultAuditEvidencePath = path.join(
  repoRoot,
  ".eliza-local",
  "sms-gateway-completion-audit-latest.json",
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

function main() {
  const audit = runAudit();
  const output = audit.output;
  const evidencePath = auditEvidencePath(output);
  const proven = [
    ["homepage bundle", /PROVEN homepage-bundle/],
    ["production Cloud onboarding", /PROVEN cloud-onboarding/],
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
  }
  if (has(output, /BLOCKED routing-contracts/)) {
    console.log(
      "[sms-gateway-status] blocked: build linked workspaces with bun run --cwd packages/cloud-shared build:linked-workspaces, then rerun sms-gateway:status",
    );
  }
  if (has(output, /BLOCKED android-transport/)) {
    console.log(
      "[sms-gateway-status] blocked: run sms-gateway:watch:pair, open Android Wireless debugging > Pair device with pairing code, then run sms-gateway:verify",
    );
  }
  if (has(output, /BLOCKED bluebubbles-transport/)) {
    console.log(
      "[sms-gateway-status] blocked: after explicit real-send approval, run sms-gateway:validate:bluebubbles -- --confirm-real-send, then sms-gateway:verify:bluebubbles",
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
  console.log("[sms-gateway-status] status=blocked");
  process.exitCode = audit.status;
}

main();
