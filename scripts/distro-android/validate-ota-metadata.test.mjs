import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadBrandConfig } from "./brand-config.mjs";
import { validateOtaMetadata } from "./validate-ota-metadata.mjs";

const brand = loadBrandConfig();
const digest = "a".repeat(64);

function validMetadata(overrides = {}) {
  const buildFingerprint =
    "eliza/eliza_cf_x86_64_phone/eliza:16/BP2A.260501.001/1:userdebug/dev-keys";
  return {
    schemaVersion: 1,
    brand: "eliza",
    distroName: "ElizaOS",
    packageName: "ai.elizaos.app",
    channel: "beta",
    releaseVersion: "2026.05.11.1",
    buildId: "BP2A.260501.001",
    buildFingerprint,
    androidVersion: "16",
    securityPatchLevel: "2026-05-01",
    releaseNotesUrl:
      "https://github.com/elizaOS/eliza/releases/tag/aosp-2026.05.11.1",
    payloads: [
      {
        type: "full",
        fileName: "elizaos-full-2026.05.11.1.zip",
        url: "https://github.com/elizaOS/eliza/releases/download/aosp-2026.05.11.1/elizaos-full-2026.05.11.1.zip",
        sha256: digest,
        sizeBytes: 100,
        targetBuildFingerprint: buildFingerprint,
        rollbackIndex: 2026051101,
        rollbackIndexLocation: 0,
        payloadPropertiesUrl:
          "https://github.com/elizaOS/eliza/releases/download/aosp-2026.05.11.1/payload_properties.txt",
        metadataSha256: "b".repeat(64),
      },
    ],
    ...overrides,
  };
}

describe("validateOtaMetadata", () => {
  it("accepts complete signed-release metadata", () => {
    const result = validateOtaMetadata(validMetadata(), brand);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it("requires brand identity to match the selected brand config", () => {
    const result = validateOtaMetadata(
      validMetadata({ packageName: "com.example.other" }),
      brand,
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /packageName must match/);
  });

  it("rejects incremental-only metadata", () => {
    const metadata = validMetadata({
      payloads: [
        {
          ...validMetadata().payloads[0],
          type: "incremental",
          sourceBuildFingerprint: "old/fingerprint",
          fileName: "incremental.zip",
        },
      ],
    });
    const result = validateOtaMetadata(metadata, brand);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /at least one full OTA/);
  });

  it("keeps release URLs HTTPS-only unless local validation opts in", () => {
    const fileUrl = "file:///tmp/elizaos-full.zip";
    const metadata = validMetadata({
      releaseNotesUrl: fileUrl,
      payloads: [{ ...validMetadata().payloads[0], url: fileUrl }],
    });
    assert.equal(validateOtaMetadata(metadata, brand).ok, false);
    assert.equal(
      validateOtaMetadata(metadata, brand, { allowFileUrls: true }).ok,
      true,
    );
  });
});
