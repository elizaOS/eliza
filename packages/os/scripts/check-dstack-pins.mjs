#!/usr/bin/env node
// OS-4 gate: dstack-pins-check (plan §2.3).
//
// Validates packages/os/linux/confidential/dstack-pins.json:
//   1. structurally against dstack-pins.schema.json, and
//   2. against the hardening invariants that MUST hold before any high-value key
//      is rooted in a dstack-managed CVM. dstack is packaging + transport + an
//      optional KMS, never the sole root of trust.
//
// Release-pin model (owner decision, plan §8.3): we TRACK THE LATEST dstack
// release (>= the Feb-2026 Secure-by-Default baseline) rather than freezing a
// tag, so upstream hardening lands automatically. A track-latest pin is a VALID
// confirmed pin iff track==="latest", reverifyOnUpdate===true and minReleaseDate
// is set; a confirmed frozen tag is also accepted. Trust is rooted in the
// platform RoT + signed golden measurements, and every boot re-verifies the
// invariants, so a malicious/downgraded release still cannot release keys.
//
// The hardening invariants (forbid/require/requiredClaims/root-of-trust/
// appAuthAllowlist) are NEVER relaxed — track-latest only removes the version
// freeze. The appAuthAllowlist must be non-empty and consistent with the signed
// golden manifest (release/confidential-2026-05-21/manifest.json).
//
// Runner: plain `node` (no third-party deps).
//   node packages/os/scripts/check-dstack-pins.mjs
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateAgainstSchema } from "./json-schema-lite.mjs";
import { parseArgs, readJson, repoRoot } from "./os-release-lib.mjs";

const DEFAULT_PINS = path.join(
  repoRoot,
  "packages/os/linux/confidential/dstack-pins.json",
);
const SCHEMA_PATH = path.join(
  repoRoot,
  "packages/os/release/schema/dstack-pins.schema.json",
);
const MANIFEST_PATH = path.join(
  repoRoot,
  "packages/os/release/confidential-2026-05-21/manifest.json",
);

const REQUIRED_CLAIMS = ["debugDisabled", "productionLifecycle"];
// Golden manifest measurements the AppAuth allowlist must mirror (§2.3).
const ALLOWLIST_MEASUREMENTS = ["agent", "container", "compose"];

// Returns { ok, blocked, errors }. `blocked` is reserved for "data is correct
// but not yet production-ready"; with the track-latest pin confirmed and the
// allowlist bound to the golden manifest, the shipped data is no longer blocked.
// `manifest` is the confidential release manifest used to assert the allowlist
// mirrors the signed golden measurements.
export function checkDstackPins(pins, schema, manifest) {
  const structure = validateAgainstSchema(pins, schema);
  if (!structure.ok) {
    return {
      ok: false,
      blocked: false,
      errors: structure.errors.map((e) => `schema: ${e}`),
    };
  }

  const errors = [];

  // §2.3: every forbidden weakness class must be forbidden.
  for (const [key, value] of Object.entries(pins.forbid)) {
    if (value !== true) {
      errors.push(
        `forbid.${key} must be true (a forbidden weakness class is not forbidden, §2.3)`,
      );
    }
  }
  // §2.3: every required hardening must be required.
  for (const [key, value] of Object.entries(pins.require)) {
    if (value !== true) {
      errors.push(
        `require.${key} must be true (a mandatory hardening is not required, §2.3)`,
      );
    }
  }
  // §2.3 production claims that must be asserted.
  for (const claim of REQUIRED_CLAIMS) {
    if (pins.requiredClaims[claim] !== true) {
      errors.push(
        `requiredClaims.${claim} must be true (production claim not asserted, §2.3)`,
      );
    }
  }
  // §2.3 principle: dstack-KMS is never the sole root of trust.
  if (pins.rootOfTrust.anchor === "dstack-kms") {
    errors.push(
      "rootOfTrust.anchor must NOT be solely dstack-KMS (root of trust is the platform RoT + golden measurements, §2.3)",
    );
  }
  if (pins.rootOfTrust.defaultVerifier === "dstack-kms") {
    errors.push(
      "rootOfTrust.defaultVerifier must NOT be dstack-KMS (default verifier is the on-device eliza-local-verifier, §2.3)",
    );
  }

  // Release pin: track-latest (>= Secure-by-Default baseline, re-verified every
  // boot) OR a confirmed frozen tag. Either is a valid confirmed pin.
  const { pinnedRelease: pin } = pins;
  const trackLatestValid =
    pin.track === "latest" &&
    pin.reverifyOnUpdate === true &&
    typeof pin.minReleaseDate === "string" &&
    pin.minReleaseDate.length > 0;
  const frozenTagValid =
    pin.confirmed === true && typeof pin.tag === "string" && pin.tag.length > 0;
  if (!trackLatestValid && !frozenTagValid) {
    errors.push(
      'pinnedRelease is INVALID: provide either a track-latest pin (track="latest", reverifyOnUpdate=true, minReleaseDate set) or a confirmed frozen tag (confirmed=true, tag set). FAIL-CLOSED (§2.3/§8.3).',
    );
  }

  // §2.3: the AppAuth allowlist must be non-empty (an empty allowlist trusts no
  // code hash and FAILS CLOSED) and must mirror the signed golden manifest
  // measurements (agent/container/compose).
  const codeHashes = pins.appAuthAllowlist.codeHashes;
  if (!Array.isArray(codeHashes) || codeHashes.length === 0) {
    errors.push(
      "appAuthAllowlist.codeHashes must be NON-EMPTY (an empty allowlist trusts no code hash, FAIL-CLOSED, §2.3).",
    );
  } else if (manifest) {
    const measurements = manifest?.tee?.measurements ?? {};
    for (const name of ALLOWLIST_MEASUREMENTS) {
      const golden = measurements[name];
      if (typeof golden !== "string") {
        errors.push(
          `appAuthAllowlist consistency: golden manifest is missing tee.measurements.${name} (§2.3).`,
        );
      } else if (!codeHashes.includes(golden)) {
        errors.push(
          `appAuthAllowlist.codeHashes must include the golden tee.measurements.${name} digest (allowlist must mirror the signed golden manifest, §2.3).`,
        );
      }
    }
  }

  return { ok: errors.length === 0, blocked: false, errors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = typeof args.input === "string" ? args.input : DEFAULT_PINS;
  const [pins, schema, manifest] = await Promise.all([
    readJson(input),
    readJson(SCHEMA_PATH),
    readJson(MANIFEST_PATH),
  ]);
  const result = checkDstackPins(pins, schema, manifest);
  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    console.error("dstack-pins-check: FAIL-CLOSED");
    process.exit(1);
  }
  console.log(`dstack-pins-check: PASS (${input})`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
