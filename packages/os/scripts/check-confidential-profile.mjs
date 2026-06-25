#!/usr/bin/env node
// Aggregate confidential-profile gate. Mirrors the chip
// check_tee_software_aggregate.py pattern: runs all three OS confidential
// data-gates and exits non-zero if any fails.
//
// Gates:
//   - confidential-policy-check           (OS-3, plan §3-§4; incl. policy-digest
//                                           binding: canonical policy digest ==
//                                           both manifests' policy measurement)
//   - confidential-artifacts-check        (OS-3, plan §3-§4; cmdline/sysctl/mask
//                                           artifacts are the policy's enforcement
//                                           form, bidirectionally consistent)
//   - confidential-image-manifest-check   (OS-1, plan §1.3/§2.2)
//   - confidential-image-reproducibility  (OS-5, plan §1.3/§2.2, §7.2; BLOCKED
//                                           until a real repro-build confirms it)
//   - dstack-pins-check                   (OS-4, plan §2.3)
//   - confidential-layer-check            (OS-1, plan §1.3; meta-elizaos Yocto
//                                           layer.conf + recipe source existence)
//
// Exit codes (fail-closed), matching the chip check_tee_software_aggregate.py
// convention (buildable checkers determine pass/fail; gates blocked on an
// external resource — a build host or silicon — are reported as a
// "release-blocked floor" WITHOUT failing the aggregate, exactly like the chip
// aggregate exits 0 while listing its 8 BLOCKED hardware gates):
//   0  every BUILDABLE gate passes. A build-host/hardware-blocked floor gate may
//      still be reported as BLOCK below (it is loudly listed, not silently
//      passed). Release-readiness = exit 0 AND an empty floor; use --release to
//      enforce the latter.
//   1  at least one gate FAILED on bad data, OR (with --release) a floor gate is
//      still BLOCKED.
//
// A "floor" gate is one blocked on an external resource we cannot provide here
// (e.g. confidential-image-reproducibility needs a Yocto build host). A blocked
// gate that is NOT a floor (a config/owner-decision blocker) still fails the
// aggregate, because that is fixable locally.
//
// Runner: plain `node` (no third-party deps).
//   node packages/os/scripts/check-confidential-profile.mjs [--release]

// Gates blocked on an external build host / hardware, not on local config.
const FLOOR_GATES = new Set(["confidential-image-reproducibility"]);

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkConfidentialArtifacts,
  loadArtifacts,
} from "./check-confidential-artifacts.mjs";
import { checkConfidentialImageManifest } from "./check-confidential-image-manifest.mjs";
import { checkConfidentialLayer } from "./check-confidential-layer.mjs";
import {
  checkConfidentialPolicy,
  checkPolicyDigestConsistency,
} from "./check-confidential-policy.mjs";
import { checkDstackPins } from "./check-dstack-pins.mjs";
import { readJson, repoRoot } from "./os-release-lib.mjs";
import { verifyManifest } from "./verify-image-reproducibility.mjs";

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
  confidentialManifest: path.join(
    repoRoot,
    "packages/os/release/confidential-2026-05-21/manifest.json",
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
    confidentialManifest,
    artifacts,
  ] = await Promise.all([
    readJson(FILES.policy),
    readJson(FILES.policySchema),
    readJson(FILES.imageManifest),
    readJson(FILES.imageManifestSchema),
    readJson(FILES.pins),
    readJson(FILES.pinsSchema),
    readJson(FILES.confidentialManifest),
    loadArtifacts(),
  ]);

  // Fold the policy-digest binding into the policy gate: the canonical policy
  // digest MUST equal both manifests' declared policy measurement (GAP 1).
  const policyStructure = checkConfidentialPolicy(policy, policySchema);
  const policyDigest = checkPolicyDigestConsistency(policy, [
    {
      name: "release manifest tee.measurements.policy",
      digest: confidentialManifest?.tee?.measurements?.policy,
    },
    {
      name: "image-manifest.example.json measurements.policy",
      digest: imageManifest?.measurements?.policy,
    },
  ]);
  const policyResult = {
    ok: policyStructure.ok && policyDigest.ok,
    errors: [...policyStructure.errors, ...policyDigest.errors],
  };

  // The reproducibility gate recomputes any present component bytes; in this repo
  // none are checked in (the multi-hour build is BLOCKED), so it reports BLOCKED
  // rather than a hard failure — exactly the fail-closed-but-not-broken state.
  const reproResult = await verifyManifest(imageManifest, undefined);

  const results = [
    ["confidential-policy-check", policyResult],
    [
      "confidential-artifacts-check",
      checkConfidentialArtifacts(policy, artifacts),
    ],
    [
      "confidential-image-manifest-check",
      checkConfidentialImageManifest(imageManifest, imageManifestSchema),
    ],
    ["confidential-image-reproducibility", reproResult],
    [
      "dstack-pins-check",
      checkDstackPins(pins, pinsSchema, confidentialManifest),
    ],
    ["confidential-layer-check", await checkConfidentialLayer()],
  ];

  for (const [name, result] of results) report(name, result);

  // A hard failure is bad data, OR a blocked gate that is NOT an external-resource
  // floor (i.e. fixable locally — config or owner-decision). Floor gates
  // (build host / hardware) are reported but do not fail the buildable aggregate.
  const hardFailures = results.filter(
    ([name, r]) => !r.ok && (!r.blocked || !FLOOR_GATES.has(name)),
  );
  const floorBlocked = results.filter(
    ([name, r]) => !r.ok && r.blocked && FLOOR_GATES.has(name),
  );

  if (hardFailures.length > 0) {
    console.error(
      `check-confidential-profile: FAIL-CLOSED (${hardFailures.length} gate(s) failed on bad data or a locally-fixable blocker)`,
    );
    process.exit(1);
  }

  const release = process.argv.includes("--release");
  const buildable = results.length - floorBlocked.length;
  if (floorBlocked.length > 0) {
    console.log(
      `check-confidential-profile: ${buildable} buildable gate(s) PASS; ` +
        `${floorBlocked.length} release-blocked floor gate(s) BLOCKED on an ` +
        `external build host/hardware: ${floorBlocked
          .map(([n]) => n)
          .join(", ")} (release-blocked floor — not a failure).`,
    );
    if (release) {
      console.error(
        "check-confidential-profile: --release requires an empty floor; a reproducible image must be built on a Yocto build host (OS-5).",
      );
      process.exit(1);
    }
    return;
  }
  console.log("check-confidential-profile: ALL GATES PASS");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
