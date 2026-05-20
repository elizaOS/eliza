#!/usr/bin/env node
/**
 * Sequential software-side verification for the shared SMS gateway objective.
 *
 * This intentionally disables Bun coverage in a temporary cwd for each group so
 * operator runs do not fail on coverage reporter output or macOS file limits.
 * It does not send SMS and does not mutate external systems.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const packagesRoot = path.join(repoRoot, "packages");

const groups = [
  {
    key: "routing-contracts",
    label: "known-owner priority, friend-contact routing, and contact recording",
    files: [
      "cloud-shared/src/lib/services/phone-gateway-devices.test.ts",
      "cloud-shared/src/lib/services/agent-gateway-router.test.ts",
      "cloud-shared/src/lib/services/message-router/index.test.ts",
    ],
  },
  {
    key: "provisioning-handoff",
    label: "$5 starter credit and onboarding transcript handoff",
    files: [
      "cloud-shared/src/lib/services/eliza-app/onboarding-chat.test.ts",
      "cloud-shared/src/lib/services/eliza-app/provisioning.test.ts",
    ],
  },
  {
    key: "homepage-contact",
    label: "homepage contact surface points at the shared gateway number",
    files: ["homepage/tests/contact.test.ts"],
  },
  {
    key: "bluebubbles-webhook",
    label: "BlueBubbles webhook registers/routes the shared gateway device",
    files: ["cloud-api/webhooks/bluebubbles/route.test.ts"],
  },
  {
    key: "operator-scripts",
    label: "gateway operator scripts and guarded real-send behavior",
    files: ["app-core/scripts/android-sms-gateway-template.test.mjs"],
  },
];

function createBunTestCwd(prefix) {
  const tmpRoot = path.join(repoRoot, ".tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(tmpRoot, prefix));
  fs.writeFileSync(
    path.join(cwd, "bunfig.toml"),
    "[test]\ntimeout = 60000\ncoverage = false\n",
  );
  return cwd;
}

function runGroup(group) {
  const cwd = createBunTestCwd(`sms-gateway-software-${group.key}-`);
  try {
    const files = group.files.map((file) => path.join(packagesRoot, file));
    const result = spawnSync("bun", ["test", ...files, "--reporter=dots"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const status = result.status ?? (result.error ? 1 : 0);
    if (status === 0) {
      const passLine = output.match(/\d+ pass\s*\n0 fail/)?.[0]?.replace(/\s+/g, " ");
      console.log(
        `[sms-gateway-software] PASS ${group.key}: ${group.label}${passLine ? ` (${passLine})` : ""}`,
      );
      return true;
    }
    console.error(`[sms-gateway-software] FAIL ${group.key}: ${group.label}`);
    console.error(output.trim());
    return false;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

let ok = true;
for (const group of groups) {
  ok = runGroup(group) && ok;
}

if (ok) {
  console.log("[sms-gateway-software] status=pass");
} else {
  console.log("[sms-gateway-software] status=failed");
  process.exitCode = 1;
}
