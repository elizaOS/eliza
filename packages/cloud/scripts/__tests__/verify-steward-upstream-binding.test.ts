/**
 * Locks the environment-specific Steward routing contract and the protected
 * Cloud release wiring that validates a configured candidate before the atomic
 * Worker secrets file is created.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CANONICAL_STEWARD_UPSTREAM_URLS,
  verifyStewardUpstreamBinding,
} from "../verify-steward-upstream-binding.mjs";

const repoRoot = resolve(import.meta.dirname, "../../../..");

describe("verifyStewardUpstreamBinding", () => {
  test("accepts each environment's canonical upstream", () => {
    for (const deployEnvironment of ["staging", "production"] as const) {
      expect(
        verifyStewardUpstreamBinding({
          deployEnvironment,
          stewardApiUrl: CANONICAL_STEWARD_UPSTREAM_URLS[deployEnvironment],
        }),
      ).toEqual({
        ok: true,
        preservedExistingBinding: false,
        error: null,
      });
    }
  });

  test("rejects a production upstream candidate in staging", () => {
    const result = verifyStewardUpstreamBinding({
      deployEnvironment: "staging",
      stewardApiUrl: CANONICAL_STEWARD_UPSTREAM_URLS.production,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(CANONICAL_STEWARD_UPSTREAM_URLS.staging);
    expect(result.error).not.toContain(
      CANONICAL_STEWARD_UPSTREAM_URLS.production,
    );
  });

  test("rejects a staging upstream candidate in production", () => {
    const result = verifyStewardUpstreamBinding({
      deployEnvironment: "production",
      stewardApiUrl: CANONICAL_STEWARD_UPSTREAM_URLS.staging,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(CANONICAL_STEWARD_UPSTREAM_URLS.production);
    expect(result.error).not.toContain(CANONICAL_STEWARD_UPSTREAM_URLS.staging);
  });

  test("blank candidates preserve the unreadable existing Worker binding", () => {
    for (const stewardApiUrl of ["", "   ", undefined]) {
      expect(
        verifyStewardUpstreamBinding({
          deployEnvironment: "staging",
          stewardApiUrl,
        }),
      ).toEqual({
        ok: true,
        preservedExistingBinding: true,
        error: null,
      });
    }
  });

  test("unknown and Object.prototype environments fail closed", () => {
    for (const deployEnvironment of ["preview", "constructor", "toString"]) {
      const result = verifyStewardUpstreamBinding({
        deployEnvironment,
        stewardApiUrl: CANONICAL_STEWARD_UPSTREAM_URLS.staging,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("has no canonical Steward upstream");
    }
  });
});

describe("cloud-cf-release Steward routing contract", () => {
  const releaseWorkflow = readFileSync(
    resolve(repoRoot, ".github/workflows/cloud-cf-release.yml"),
    "utf8",
  );

  test("validates the candidate before creating the atomic Worker secrets file", () => {
    const check = releaseWorkflow.indexOf(
      "verify-steward-upstream-binding.mjs",
    );
    const secretsFile = releaseWorkflow.indexOf("worker-secrets-file.mjs");
    expect(check).toBeGreaterThan(-1);
    expect(secretsFile).toBeGreaterThan(check);
  });

  test("passes only the protected environment candidate through process env", () => {
    expect(releaseWorkflow).toContain(
      'node "$CHECKOUT_DIR/packages/cloud/scripts/verify-steward-upstream-binding.mjs"',
    );
    expect(releaseWorkflow).not.toMatch(
      /echo\b[^\n]*\$?STEWARD_API_URL|printf\b[^\n]*\$?STEWARD_API_URL/,
    );
  });
});
