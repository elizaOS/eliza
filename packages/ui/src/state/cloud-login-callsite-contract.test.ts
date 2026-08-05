/**
 * Exhaustive call-site contract for the Cloud login entry points (#17129).
 *
 * Dynamically enumerates every production `.ts`/`.tsx` source under
 * `packages/ui/src`, excludes tests/specs/generated, and asserts:
 *   1. No source invokes the raw null-window path (`handleCloudLogin(`).
 *   2. The sanctioned interactive sites use `handleInteractiveCloudLogin`.
 *   3. Only the sanctioned recovery sites invoke `handleCloudLoginRecovery`.
 *   4. The public surface (`types.ts`) does not expose the raw path.
 *   5. The public surface does expose the interactive entry point.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI_SRC = join(import.meta.dirname, "..", "..");

const SANCTIONED_RECOVERY_SITES = new Set([
  "src/App.tsx",
  "src/first-run/use-boot-recovery-conductor.ts",
]);

const SANCTIONED_INTERACTIVE_SITES = new Set([
  "src/components/pages/ConfigPageView.tsx",
  "src/components/pages/ElizaCloudDashboard.tsx",
  "src/first-run/first-run-finish.ts",
  "src/components/settings/CloudOverviewSection.tsx",
  "src/cloud/connectors/CloudConnectorsUpsell.tsx",
]);

const EXCLUDE_DIRS = new Set([
  "__tests__",
  "__e2e__",
  "node_modules",
  "dist",
  "storybook",
]);

const EXCLUDE_SUFFIX = new Set([
  ".test.ts",
  ".test.tsx",
  ".spec.ts",
  ".spec.tsx",
  ".stories.tsx",
]);

const EXCLUDE_FILES = new Set([
  "src/state/cloud-login-callsite-contract.test.ts",
  "src/state/cloud-login-callsite-contract.mutate-proof.test.ts",
  "src/state/useCloudState.ts",
]);

function isExcludedFile(name: string): boolean {
  if (name.endsWith(".d.ts")) return true;
  for (const suffix of EXCLUDE_SUFFIX) {
    if (name.endsWith(suffix)) return true;
  }
  return false;
}

function walk(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out.push(...walk(join(dir, entry.name), `${prefix}${entry.name}/`));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !isExcludedFile(entry.name)
    ) {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

function readSource(rel: string): string {
  const abs = join(UI_SRC, rel);
  if (!existsSync(abs)) return "";
  return readFileSync(abs, "utf8");
}

function hasCall(source: string, name: string): boolean {
  // Non-stateful regex test (no lastIndex carryover).
  return new RegExp(`\\b${name}\\s*\\(`).test(source);
}

function callsCount(source: string, name: string): number {
  const m = source.match(new RegExp(`\\b${name}\\s*\\(`, "g"));
  return m ? m.length : 0;
}

describe("cloud login callsite contract (#17129)", () => {
  const allSources = walk(UI_SRC, "").filter((f) => !EXCLUDE_FILES.has(f));

  it("no source invokes the raw null-window path", () => {
    const violations = allSources.filter((rel) =>
      hasCall(readSource(rel), "handleCloudLogin"),
    );
    expect(
      violations,
      `raw handleCloudLogin must not be invoked anywhere; violations: ${violations.join(", ")}`,
    ).toEqual([]);
  });

  it("sanctioned interactive surfaces use the interactive entry point", () => {
    const missing = [...SANCTIONED_INTERACTIVE_SITES].filter(
      (rel) => !hasCall(readSource(rel), "handleInteractiveCloudLogin"),
    );
    expect(
      missing,
      `interactive surfaces must reference handleInteractiveCloudLogin: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("recovery entry point is only invoked at the sanctioned recovery sites", () => {
    const allRecoveryCalls = allSources.filter((rel) =>
      hasCall(readSource(rel), "handleCloudLoginRecovery"),
    );

    const sanctionedHits = allRecoveryCalls.filter((r) =>
      SANCTIONED_RECOVERY_SITES.has(r),
    );
    expect(sanctionedHits.length).toBeGreaterThan(0);

    const nonSanctioned = allRecoveryCalls.filter(
      (r) => !SANCTIONED_RECOVERY_SITES.has(r),
    );
    expect(
      nonSanctioned,
      `handleCloudLoginRecovery must only be called at ${[...SANCTIONED_RECOVERY_SITES].join(", ")}; violations: ${nonSanctioned.join(", ")}`,
    ).toEqual([]);
  });

  it("the raw handleCloudLogin is not part of the public AppActions surface", () => {
    const typesSource = readSource("src/state/types.ts");
    // Raw path must not be callable (only handleCloudLoginRecovery exists).
    expect(hasCall(typesSource, "handleCloudLogin")).toBe(false);
    expect(typesSource).toContain("handleCloudLoginRecovery");
  });

  it("the public surface exposes the interactive entry point", () => {
    const typesSource = readSource("src/state/types.ts");
    expect(typesSource).toContain("handleInteractiveCloudLogin");
  });
});
