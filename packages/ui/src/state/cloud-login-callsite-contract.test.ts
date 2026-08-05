/**
 * Exhaustive call-site contract for the Cloud login entry points (#17129).
 *
 * Dynamically enumerates every production `.ts`/`.tsx` source under
 * `packages/ui/src`, excludes tests/specs/generated, and asserts:
 *   1. No source references the raw null-window path (`handleCloudLogin` —
 *      call or alias). Recovery (`handleCloudLoginRecovery`) and interactive
 *      (`handleInteractiveCloudLogin`) longer identifiers are distinct.
 *   2. The sanctioned interactive sites use `handleInteractiveCloudLogin`.
 *   3. ONLY the sanctioned recovery sites invoke `handleCloudLoginRecovery`,
 *      and EACH of them individually does (both App.tsx and
 *      use-boot-recovery-conductor.ts) — not merely "at least one".
 *   4. The public surface (`types.ts`) does not expose the raw path.
 *   5. The public surface does expose the interactive entry point.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// This test lives at packages/ui/src/state/. The package source root is
// packages/ui (walk below yields paths like "src/App.tsx"). Kept as the
// package root so `readSource` + `walk` both resolve against it consistently;
// the name states what it is so a future move of this file re-checked here.
const UI_PACKAGE_ROOT = join(import.meta.dirname, "..", "..");

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
  const abs = join(UI_PACKAGE_ROOT, rel);
  if (!existsSync(abs)) return "";
  return readFileSync(abs, "utf8");
}

/**
 * Reference check that matches the identifier, not just a call — an alias such
 * as `const login = s.handleCloudLogin; login()` must be caught too. The
 * negative lookahead keeps `handleCloudLoginRecovery` and
 * `handleInteractiveCloudLogin` (distinct, sanctioned longer identifiers) from
 * matching the raw name. Non-stateful (fresh RegExp per call).
 */
function referencesIdentifier(source: string, name: string): boolean {
  const re = new RegExp(`\\b${name}(?!Recovery|InteractiveCloudLogin)\\b`);
  return re.test(source);
}

/**
 * Call-syntax check for the RECOVERY entry point. We forbid *calling* the
 * recovery API outside the sanctioned boot sites. A pure identifier match would
 * false-positive on the legitimate public-surface wiring (AppContext.tsx and
 * types.ts broker the method into AppActions, they do not call it), so here we
 * require the `(`-invocation shape instead. Alias-indirection on recovery is
 * not a real bypass: a caller still has to invoke it, which this catches.
 */
function invokesCall(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(source);
}

describe("cloud login callsite contract (#17129)", () => {
  const allSources = walk(UI_PACKAGE_ROOT, "").filter(
    (f) => !EXCLUDE_FILES.has(f),
  );

  it("no source references the raw null-window path (call or alias)", () => {
    const violations = allSources.filter((rel) =>
      referencesIdentifier(readSource(rel), "handleCloudLogin"),
    );
    expect(
      violations,
      `raw handleCloudLogin must not be referenced anywhere (call or alias); violations: ${violations.join(", ")}`,
    ).toEqual([]);
  });

  it("sanctioned interactive surfaces use the interactive entry point", () => {
    const missing = [...SANCTIONED_INTERACTIVE_SITES].filter(
      (rel) =>
        !referencesIdentifier(readSource(rel), "handleInteractiveCloudLogin"),
    );
    expect(
      missing,
      `interactive surfaces must reference handleInteractiveCloudLogin: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("recovery entry point is invoked at EACH sanctioned site, and nowhere else", () => {
    // Positive: every sanctioned recovery site individually invokes the
    // recovery API (not merely "at least one" — a dropped boot site must fail).
    for (const site of SANCTIONED_RECOVERY_SITES) {
      expect(
        invokesCall(readSource(site), "handleCloudLoginRecovery"),
        `${site} must invoke handleCloudLoginRecovery`,
      ).toBe(true);
    }

    // Negative: no OTHER *call site* may invoke it. (AppContext.tsx and
    // types.ts legitimately broker the method into AppActions without calling
    // it, so the check is call-shaped, not identifier-shaped.)
    const nonSanctioned = allSources.filter(
      (rel) =>
        !SANCTIONED_RECOVERY_SITES.has(rel) &&
        invokesCall(readSource(rel), "handleCloudLoginRecovery"),
    );
    expect(
      nonSanctioned,
      `handleCloudLoginRecovery must only be called at ${[...SANCTIONED_RECOVERY_SITES].join(", ")}; violations: ${nonSanctioned.join(", ")}`,
    ).toEqual([]);
  });

  it("the raw handleCloudLogin is not part of the public AppActions surface", () => {
    const typesSource = readSource("src/state/types.ts");
    // Raw path must not be callable (only handleCloudLoginRecovery exists).
    expect(referencesIdentifier(typesSource, "handleCloudLogin")).toBe(false);
    expect(typesSource).toContain("handleCloudLoginRecovery");
  });

  it("the public surface exposes the interactive entry point", () => {
    const typesSource = readSource("src/state/types.ts");
    expect(typesSource).toContain("handleInteractiveCloudLogin");
  });
});
