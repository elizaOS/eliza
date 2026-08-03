/**
 * Exhaustive call-site contract for the Cloud login entry points (#17129).
 *
 * The interactive-only entry point (`handleInteractiveCloudLogin`) pre-opens
 * the named popup itself, so interactive call sites cannot omit it. The
 * deliberate same-tab recovery path (`handleCloudLoginRecovery`) is separately
 * named and non-interactive. This contract scans the real sources so a future
 * interactive call site that reaches the raw null-window path — or the
 * recovery API — fails this test at review time instead of compiling silently.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI_SRC = join(import.meta.dirname, "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(join(UI_SRC, relativePath), "utf8");
}

// The interactive surfaces the issue names explicitly. Each must use only
// `handleInteractiveCloudLogin` for user-facing login.
const INTERACTIVE_SURFACES = [
  "src/components/pages/ConfigPageView.tsx",
  "src/components/pages/ElizaCloudDashboard.tsx",
  "src/first-run/first-run-finish.ts",
  "src/components/settings/CloudOverviewSection.tsx",
  "src/cloud/connectors/CloudConnectorsUpsell.tsx",
] as const;

// The only sanctioned recovery call sites: native re-auth in App.tsx and the
// boot-recovery conductor. No interactive surface may appear here.
const RECOVERY_SITES = [
  "src/App.tsx",
  "src/first-run/use-boot-recovery-conductor.ts",
] as const;

describe("cloud login callsite contract (#17129)", () => {
  it("interactive surfaces never call the raw null-window path", () => {
    for (const file of INTERACTIVE_SURFACES) {
      const source = readSource(file);
      // The raw implementation name is still reachable internally, but no
      // interactive surface may INVOKE it (a bare `handleCloudLogin(` call
      // with no pre-popped window is the #17064/#17129 defect).
      const rawCalls = source.match(/\bhandleCloudLogin\s*\(/g) ?? [];
      expect(
        rawCalls,
        `${file} must not invoke the raw handleCloudLogin path`,
      ).toEqual([]);
    }
  });

  it("interactive surfaces use the interactive entry point", () => {
    for (const file of INTERACTIVE_SURFACES) {
      const source = readSource(file);
      expect(
        source,
        `${file} should reference handleInteractiveCloudLogin`,
      ).toContain("handleInteractiveCloudLogin");
    }
  });

  it("recovery entry point is only invoked at the sanctioned recovery sites", () => {
    const recoveryFiles = RECOVERY_SITES.map(readSource).join("\n");
    const recoveryCalls = recoveryFiles.match(
      /\bhandleCloudLoginRecovery\s*\(/g,
    );
    expect(recoveryCalls?.length ?? 0).toBeGreaterThan(0);

    for (const file of INTERACTIVE_SURFACES) {
      const source = readSource(file);
      const forbidden = source.match(/\bhandleCloudLoginRecovery\s*\(/g) ?? [];
      expect(
        forbidden,
        `${file} is interactive and must not call the recovery entry point`,
      ).toEqual([]);
    }
  });

  it("the raw handleCloudLogin is not part of the public AppActions surface", () => {
    const typesSource = readSource("src/state/types.ts");
    // The public surface may reference the raw name only inside comments or
    // as the recovery wrapper; it must not declare it as an AppActions method
    // accepting a pre-popped window.
    const declaration = typesSource.match(
      /handleCloudLogin:\s*\([\s\S]*?prePoppedWindow/,
    );
    expect(declaration).toBeNull();
    expect(typesSource).toContain("handleCloudLoginRecovery");
  });
});
