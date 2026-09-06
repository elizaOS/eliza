/** Installs one reviewed application billing slot from an operator-owned manifest after current provider verification. */

import { closeDatabaseConnectionsForTests } from "../../shared/src/db/client";
import { installAppBillingApplicationSlot } from "../../shared/src/lib/services/generic-billing-application-slot";
import { readAppBillingOperatorManifest } from "../../shared/src/lib/services/generic-billing-operator-manifest";

const [path, sha256] = process.argv.slice(2);
if (!path || !sha256 || process.argv.length !== 4)
  throw new Error(
    "Usage: bun install-app-billing-slot.ts <manifest.json> <reviewed-sha256>",
  );
try {
  const reviewed = await readAppBillingOperatorManifest(path, sha256);
  if (reviewed.manifest.kind !== "application_slot")
    throw new Error("Expected application_slot manifest");
  const slot = await installAppBillingApplicationSlot({
    manifest: reviewed.manifest,
    digest: reviewed.digest,
  });
  process.stdout.write(
    `${JSON.stringify({ slotId: slot.id, appId: slot.app_id, environment: slot.livemode ? "live" : "test" })}\n`,
  );
} finally {
  await closeDatabaseConnectionsForTests();
}
