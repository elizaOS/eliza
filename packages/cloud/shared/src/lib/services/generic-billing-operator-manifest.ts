/** Loads an exact reviewed local billing manifest with file-owner and SHA-256 checks before any privileged operation. */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { ElizaError } from "@elizaos/core";
import { appBillingOperatorManifestSchema } from "./generic-billing-import-manifest";

function invalid(message: string): never {
  throw new ElizaError(message, { code: "APP_BILLING_OPERATOR_MANIFEST_INVALID" });
}
export async function readAppBillingOperatorManifest(path: string, approvedSha256: string) {
  if (!/^[0-9a-f]{64}$/u.test(approvedSha256))
    invalid("Supply the exact reviewed manifest SHA-256");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o022) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      invalid(
        "Billing manifest must be a regular operator-owned file without group or world write permission",
      );
    const bytes = await file.readFile();
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== approvedSha256) invalid("Billing manifest differs from the reviewed digest");
    const parsed = appBillingOperatorManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    return { manifest: parsed, digest };
  } finally {
    await file.close();
  }
}
