#!/usr/bin/env node
/**
 * Standalone final-artifact audit for exported iOS cloud `.app`/`.ipa`
 * products. It delegates to the build-integrated policy and prints only the
 * artifact-evidence result; it never claims device or runtime validation.
 */
import path from "node:path";

import { auditIosCloudArtifact } from "./lib/ios-cloud-artifact-audit.mjs";

const artifactPath = process.argv[2];
if (!artifactPath) {
  console.error(
    "Usage: node scripts/audit-ios-cloud-artifact.mjs <App.app|App.ipa>",
  );
  process.exit(2);
}

const requireCodesign =
  /^(1|true|yes|on)$/i.test(
    process.env.ELIZA_IOS_ARTIFACT_REQUIRE_CODESIGN ?? "",
  ) || artifactPath.toLowerCase().endsWith(".ipa");
const result = auditIosCloudArtifact({
  artifactPath,
  freshDistDir: path.resolve(
    process.env.ELIZA_IOS_FRESH_RENDERER_DIST ?? "dist",
  ),
  expectedRuntimeMode: process.env.ELIZA_IOS_ARTIFACT_RUNTIME_MODE ?? "cloud",
  requireCodesign,
  ...(process.env.ELIZA_IOS_ARTIFACT_ATTESTATION_PATH?.trim()
    ? {
        attestationPath: process.env.ELIZA_IOS_ARTIFACT_ATTESTATION_PATH.trim(),
      }
    : {}),
});
console.log(
  `[ios-cloud-artifact] PASS ${result.artifact} sha256=${result.artifactSha256} ` +
    `renderer=${result.renderer.buildId} signature=${result.signature.status} ` +
    `attestation=${result.attestationFile}`,
);
