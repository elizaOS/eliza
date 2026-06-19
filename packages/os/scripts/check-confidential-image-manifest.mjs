#!/usr/bin/env node
// OS-1 gate: confidential-image-manifest-check (plan §1.3/§2.2; shared with chip
// 06 §2.2 / WI-3).
//
// Validates a confidential image manifest (the "image is the policy" contract):
//   1. structurally against confidential-image-manifest.schema.json, and
//   2. asserts every measured component digest (kernel/initrd/rootfs/appCompose)
//      is a sha256 digest, and that the appCompose component digest agrees with
//      the normalized measurements.compose entry (one bytes, two views).
//
// Since no real reproducible image exists yet (gate
// confidential-image-reproducibility / OS-5 is BLOCKED on a build host), the
// shipped example is a fixture: this gate enforces schema-conformance + digest
// shape only and prints the BLOCKED status for the real build.
//
// Runner: plain `node` (no third-party deps).
//   node packages/os/scripts/check-confidential-image-manifest.mjs
import path from "node:path";
import { validateAgainstSchema } from "./json-schema-lite.mjs";
import { parseArgs, readJson, repoRoot } from "./os-release-lib.mjs";

const DEFAULT_MANIFEST = path.join(
  repoRoot,
  "packages/os/linux/confidential/image-manifest.example.json",
);
const SCHEMA_PATH = path.join(
  repoRoot,
  "packages/os/release/schema/confidential-image-manifest.schema.json",
);

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMPONENT_NAMES = ["kernel", "initrd", "rootfs", "appCompose"];

export function checkConfidentialImageManifest(manifest, schema) {
  const structure = validateAgainstSchema(manifest, schema);
  if (!structure.ok) {
    return { ok: false, errors: structure.errors.map((e) => `schema: ${e}`) };
  }

  const errors = [];

  // Every required component digest must be a real sha256 digest (not a
  // placeholder that the schema pattern would also accept). The schema enforces
  // the shape; here we additionally reject the all-zero digest.
  for (const name of COMPONENT_NAMES) {
    const digest = manifest.components[name]?.digest;
    if (!DIGEST_PATTERN.test(String(digest))) {
      errors.push(
        `components.${name}.digest must be sha256:<64 lowercase hex>`,
      );
    } else if (digest === `sha256:${"0".repeat(64)}`) {
      errors.push(`components.${name}.digest is an all-zero placeholder`);
    }
  }

  // The appCompose component is the RTMR3 input; its digest must equal the
  // normalized measurements.compose entry so the two views cannot drift.
  const composeComponent = manifest.components.appCompose?.digest;
  const composeMeasurement = manifest.measurements?.compose;
  if (
    DIGEST_PATTERN.test(String(composeComponent)) &&
    composeMeasurement !== undefined &&
    composeComponent !== composeMeasurement
  ) {
    errors.push(
      "components.appCompose.digest must equal measurements.compose (the app-compose bytes are measured into RTMR3)",
    );
  }

  return { ok: errors.length === 0, errors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = typeof args.input === "string" ? args.input : DEFAULT_MANIFEST;
  const [manifest, schema] = await Promise.all([
    readJson(input),
    readJson(SCHEMA_PATH),
  ]);
  const result = checkConfidentialImageManifest(manifest, schema);
  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    console.error("confidential-image-manifest-check: FAIL-CLOSED");
    process.exit(1);
  }
  console.log(
    `confidential-image-manifest-check: PASS schema + digest-shape (${input})`,
  );
  if (manifest.reproducibility?.confirmed !== true) {
    console.log(
      "  note: reproducible image build is BLOCKED (gate confidential-image-reproducibility / OS-5, needs a build host). " +
        "Component digests are golden placeholders, not bytes from a real build; only schema-conformance + digest shape are proven here.",
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
