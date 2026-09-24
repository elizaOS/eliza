/** Imports one reviewed external subscription or original local trial from an operator-owned manifest without provider writes. */
import { ElizaError } from "@elizaos/core";
import { closeDatabaseConnectionsForTests } from "../../shared/src/db/client";
import { importAppBillingHistory } from "../../shared/src/lib/services/generic-billing-import";
import { readAppBillingOperatorManifest } from "../../shared/src/lib/services/generic-billing-operator-manifest";

const [path, sha256] = process.argv.slice(2);
if (!path || !sha256 || process.argv.length !== 4)
  throw new ElizaError(
    "Usage: bun import-app-billing.ts <manifest.json> <reviewed-sha256>",
    { code: "APP_BILLING_IMPORT_USAGE" },
  );
try {
  const reviewed = await readAppBillingOperatorManifest(path, sha256);
  if (reviewed.manifest.kind !== "subscription_import")
    throw new ElizaError("Expected subscription_import manifest", {
      code: "APP_BILLING_IMPORT_MANIFEST_KIND",
    });
  const result = await importAppBillingHistory({
    manifest: reviewed.manifest,
    digest: reviewed.digest,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await closeDatabaseConnectionsForTests();
}
