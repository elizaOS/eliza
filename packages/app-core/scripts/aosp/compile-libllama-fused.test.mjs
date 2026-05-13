// Tests for the omnivoice-fused wiring in `compile-libllama.mjs`. The
// production wiring runs zig + the Android NDK; these tests stay
// dry-run-only so they pass on a CI box without those toolchains. End-to-end
// hardware coverage is described in
// `packages/inference/reports/porting/2026-05-12/remaining-work-ledger.md`.
//
// See `packages/app-core/scripts/aosp/compile-libllama.mjs` for the
// wiring itself.
//
// NOTE: The fused-target API (FUSED_ANDROID_TARGETS, parseAndroidTarget,
// describeAndroidTargetDryRun, and a --target-aware parseArgs) is planned
// but not yet implemented in compile-libllama.mjs. Those tests are skipped
// until the implementation lands. The ABI_TARGETS test covers the existing
// two-ABI contract.

import { describe, expect, it } from "vitest";

import { ABI_TARGETS } from "./compile-libllama.mjs";

// ---------------------------------------------------------------------------
// Existing stable API — always runs
// ---------------------------------------------------------------------------

describe("compile-libllama.mjs — stable ABI contract", () => {
  it("ABI_TARGETS still carries the two canonical ABIs", () => {
    expect(ABI_TARGETS).toHaveLength(2);
    expect(ABI_TARGETS.map((t) => t.androidAbi).sort()).toEqual([
      "arm64-v8a",
      "x86_64",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Fused-target API — skipped until compile-libllama.mjs exports the new
// FUSED_ANDROID_TARGETS / parseAndroidTarget / describeAndroidTargetDryRun
// and the --target-aware parseArgs surface lands.
// ---------------------------------------------------------------------------

describe("compile-libllama.mjs — fused-target API (planned, not yet implemented)", () => {
  it.skip("parseAndroidTarget accepts the four fused android targets", () => {
    // Requires FUSED_ANDROID_TARGETS and parseAndroidTarget exports.
    // See compile-libllama.mjs for the planned implementation.
  });

  it.skip("parseAndroidTarget accepts the four non-fused android targets", () => {
    // Requires parseAndroidTarget export.
  });

  it.skip("parseAndroidTarget rejects desktop/server fused targets", () => {
    // Requires parseAndroidTarget export.
  });

  it.skip("parseArgs accepts --target + --dry-run flags", () => {
    // Requires the --target-aware parseArgs refactor (currently uses --abi).
  });

  it.skip("parseArgs accepts multiple --target invocations", () => {
    // Requires the --target-aware parseArgs refactor.
  });

  it.skip("describeAndroidTargetDryRun emits cmake + graft + verify lines for fused targets", () => {
    // Requires describeAndroidTargetDryRun export.
  });

  it.skip("describeAndroidTargetDryRun does NOT emit fused/graft lines for non-fused targets", () => {
    // Requires describeAndroidTargetDryRun export.
  });

  it.skip("CLI --target ... --dry-run produces a plan that mentions cmake, the graft, and verify-symbols (fused target)", () => {
    // Requires the --target-aware CLI wiring and describeAndroidTargetDryRun.
  });

  it.skip("CLI --target rejects desktop targets with a hard error", () => {
    // Requires the --target-aware CLI wiring.
  });
});
