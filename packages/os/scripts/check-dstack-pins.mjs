#!/usr/bin/env node
// OS-4 gate: dstack-pins-check (plan §2.3).
//
// Validates packages/os/linux/confidential/dstack-pins.json:
//   1. structurally against dstack-pins.schema.json, and
//   2. against the hardening invariants that MUST hold before any high-value key
//      is rooted in a dstack-managed CVM. dstack is packaging + transport + an
//      optional KMS, never the sole root of trust.
//
// CRUCIAL fail-closed rule: an UNCONFIRMED release pin (pinnedRelease.confirmed
// === false or tag === null) must NOT pass as production-ready. The plan leaves
// the exact post-Feb-2026 tag as an open owner decision (§8.3); until it is
// confirmed, this gate reports BLOCKED / FAIL-CLOSED.
//
// Runner: plain `node` (no third-party deps).
//   node packages/os/scripts/check-dstack-pins.mjs
import path from "node:path";
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

const REQUIRED_CLAIMS = ["debugDisabled", "productionLifecycle"];

// Returns { ok, blocked, errors }. `blocked` is true when the only reason the
// gate fails is an unconfirmed release pin (the OPEN owner decision §8.3), so
// callers can distinguish "data is wrong" from "data is correct but not yet
// production-ready".
export function checkDstackPins(pins, schema) {
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

  // CRUCIAL: an unconfirmed pin must not pass as production-ready.
  const unconfirmed =
    pins.pinnedRelease.confirmed !== true || pins.pinnedRelease.tag === null;
  if (unconfirmed) {
    errors.push(
      "pinnedRelease is UNCONFIRMED (confirmed=false or tag=null): the exact post-Feb-2026 dstack release tag is an OPEN owner decision (plan §8.3). FAIL-CLOSED — an unconfirmed pin must not pass as production-ready.",
    );
  }

  const onlyBlockedByPin = unconfirmed && errors.length === 1;
  return { ok: errors.length === 0, blocked: onlyBlockedByPin, errors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = typeof args.input === "string" ? args.input : DEFAULT_PINS;
  const [pins, schema] = await Promise.all([
    readJson(input),
    readJson(SCHEMA_PATH),
  ]);
  const result = checkDstackPins(pins, schema);
  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    console.error(
      result.blocked
        ? "dstack-pins-check: BLOCKED / FAIL-CLOSED (data is correct; confirm the pin tag per plan §8.3 to unblock)"
        : "dstack-pins-check: FAIL-CLOSED",
    );
    process.exit(1);
  }
  console.log(`dstack-pins-check: PASS (${input})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
