/** Ratchets the hosted WhatsApp cutover against Cloud API, webhook, and UI reintroduction. */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_ABSENT_PATHS = [
  "packages/cloud/api/eliza-app/auth/whatsapp",
  "packages/cloud/api/eliza-app/webhook/whatsapp",
  "packages/cloud/api/v1/whatsapp",
  "packages/cloud/api/webhooks/whatsapp",
  "packages/cloud/services/gateway-webhook/src/adapters/whatsapp.ts",
  "packages/cloud/shared/src/lib/services/eliza-app/whatsapp-auth.ts",
  "packages/cloud/shared/src/lib/services/whatsapp-automation",
  "packages/cloud/shared/src/lib/utils/whatsapp-api.ts",
  "packages/cloud/test-mocks/test/provider-contract/whatsapp-cloud-webhook.contract.test.ts",
  "packages/ui/src/cloud/connectors/whatsapp-connection.tsx",
];

const SCAN_ROOTS = [
  "packages/cloud/api",
  "packages/cloud/services/gateway-webhook",
  "packages/cloud/shared/src/lib",
  "packages/cloud/test-mocks",
  "packages/core/src/constants",
  "packages/core/src/validation",
  "packages/homepage/docs",
  "packages/ui/src/cloud",
  "packages/ui/src/cloud-ui",
  "packages/ui/src/i18n/locales",
  "docs/testing",
  "scripts/lifeops",
];

const FORBIDDEN = [
  /\b(?:ELIZA_APP_)?WHATSAPP_(?:TOKEN|BOT_TOKEN|API_TOKEN|ACCESS_TOKEN|PHONE_NUMBER_ID|APP_SECRET|VERIFY_TOKEN|BUSINESS_PHONE)\b/,
  /\/api\/(?:v1\/whatsapp|webhooks\/whatsapp|eliza-app\/(?:auth|webhook)\/whatsapp)(?:\/|\b)/,
  /\b(?:WhatsAppConnection|whatsappAutomationService|routeWhatsAppMessage)\b/,
  /\bwhatsapp-cloud-webhook\b/,
  /["'`]cloud\.whatsapp\./,
  /graph\.facebook\.com\/v(?:19|21)\.0\/.{0,120}(?:phone_number|messages)/i,
];

const ALLOWED_FILES = new Set([
  "packages/cloud/test-mocks/provider-contract-inventory.json",
  "packages/cloud/test-mocks/provider-contract-protected-integrations.json",
]);

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    // error-policy:J3 absence is the expected result for retired source paths.
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sourceFiles(directory) {
  if (!(await exists(directory))) return [];
  const files = [];
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (
        ["node_modules", "dist", ".wrangler", "coverage"].includes(entry.name)
      )
        continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  await visit(directory);
  return files;
}

export async function auditWhatsAppCloudCutover(root = process.cwd()) {
  const failures = [];
  for (const relative of REQUIRED_ABSENT_PATHS) {
    if (await exists(path.join(root, relative)))
      failures.push(`${relative}: retired path exists`);
  }

  for (const scanRoot of SCAN_ROOTS) {
    for (const file of await sourceFiles(path.join(root, scanRoot))) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (ALLOWED_FILES.has(relative)) continue;
      const contents = await readFile(file, "utf8");
      for (const pattern of FORBIDDEN) {
        const match = contents.match(pattern);
        if (match) {
          failures.push(
            `${relative}: contains retired authority ${match[0]} (${pattern})`,
          );
        }
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `hosted WhatsApp cutover audit failed:\n${failures.join("\n")}`,
    );
  }
  return {
    scannedRoots: SCAN_ROOTS.length,
    retiredPaths: REQUIRED_ABSENT_PATHS.length,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await auditWhatsAppCloudCutover();
  process.stdout.write(
    `Hosted WhatsApp cutover ratchet passed (${result.retiredPaths} retired paths, ${result.scannedRoots} roots).\n`,
  );
}
