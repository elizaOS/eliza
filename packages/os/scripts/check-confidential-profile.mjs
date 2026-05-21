#!/usr/bin/env node
// Aggregate confidential-profile gate. Mirrors the chip
// check_tee_software_aggregate.py pattern: runs all three OS confidential
// data-gates and exits non-zero if any fails.
//
// Gates:
//   - confidential-policy-check          (OS-3, plan §3-§4)
//   - confidential-image-manifest-check  (OS-1, plan §1.3/§2.2)
//   - dstack-pins-check                  (OS-4, plan §2.3)
//
// Exit codes (fail-closed):
//   0  all gates PASS.
//   1  at least one gate FAILED on bad data.
//   3  no data failures, but at least one gate is BLOCKED (correct data that is
//      not yet production-ready, e.g. the dstack pin tag is an OPEN owner
//      decision per plan §8.3). Still non-zero so nothing downstream treats the
//      profile as production-ready.
//
// Runner: plain `node` (no third-party deps).
//   node packages/os/scripts/check-confidential-profile.mjs
import path from "node:path";
import { checkConfidentialImageManifest } from "./check-confidential-image-manifest.mjs";
import { checkConfidentialPolicy } from "./check-confidential-policy.mjs";
import { checkDstackPins } from "./check-dstack-pins.mjs";
import { readJson, repoRoot } from "./os-release-lib.mjs";

const FILES = {
  policy: path.join(
    repoRoot,
    "packages/os/linux/confidential/policy/confidential-policy.json",
  ),
  policySchema: path.join(
    repoRoot,
    "packages/os/release/schema/confidential-policy.schema.json",
  ),
  imageManifest: path.join(
    repoRoot,
    "packages/os/linux/confidential/image-manifest.example.json",
  ),
  imageManifestSchema: path.join(
    repoRoot,
    "packages/os/release/schema/confidential-image-manifest.schema.json",
  ),
  pins: path.join(repoRoot, "packages/os/linux/confidential/dstack-pins.json"),
  pinsSchema: path.join(
    repoRoot,
    "packages/os/release/schema/dstack-pins.schema.json",
  ),
};

function report(name, result) {
  if (result.ok) {
    console.log(`PASS  ${name}`);
    return;
  }
  const status = result.blocked ? "BLOCK" : "FAIL ";
  console.error(`${status} ${name}`);
  for (const error of result.errors) console.error(`        ${error}`);
}

async function main() {
  const [
    policy,
    policySchema,
    imageManifest,
    imageManifestSchema,
    pins,
    pinsSchema,
  ] = await Promise.all([
    readJson(FILES.policy),
    readJson(FILES.policySchema),
    readJson(FILES.imageManifest),
    readJson(FILES.imageManifestSchema),
    readJson(FILES.pins),
    readJson(FILES.pinsSchema),
  ]);

  const results = [
    [
      "confidential-policy-check",
      checkConfidentialPolicy(policy, policySchema),
    ],
    [
      "confidential-image-manifest-check",
      checkConfidentialImageManifest(imageManifest, imageManifestSchema),
    ],
    ["dstack-pins-check", checkDstackPins(pins, pinsSchema)],
  ];

  for (const [name, result] of results) report(name, result);

  const hardFailure = results.some(([, r]) => !r.ok && !r.blocked);
  const blocked = results.some(([, r]) => !r.ok && r.blocked);

  if (hardFailure) {
    console.error(
      "check-confidential-profile: FAIL-CLOSED (a gate failed on bad data)",
    );
    process.exit(1);
  }
  if (blocked) {
    console.error(
      "check-confidential-profile: BLOCKED — data is correct but the profile is not yet production-ready (see BLOCK gates above; e.g. dstack pin tag is an OPEN owner decision, plan §8.3)",
    );
    process.exit(3);
  }
  console.log("check-confidential-profile: ALL GATES PASS");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
