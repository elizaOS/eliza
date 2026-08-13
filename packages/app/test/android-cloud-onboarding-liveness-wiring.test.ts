/**
 * Contract test for the Android cloud-onboarding liveness wiring (#14359 / #16936).
 *
 * Verifies the liveness-contract export API and that the Android spec source
 * wires it correctly. The actual device-lane execution requires an Android
 * emulator (ci:device family), but the wiring must be present and correct in
 * the committed spec.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertLiveReply, STUB_FIXTURE_MARKER } from "./liveness-contract.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.join(
  testDir,
  "android",
  "cloud-onboarding.android.spec.ts",
);

const specSource = readFileSync(specPath, "utf8");

describe("liveness contract API (#14359 / #16936)", () => {
  it("assertLiveReply accepts a real non-stub reply", () => {
    expect(assertLiveReply("Hello from a real agent!")).toBe(
      "Hello from a real agent!",
    );
  });

  it("assertLiveReply rejects an empty reply", () => {
    expect(() => assertLiveReply("")).toThrow(/empty/);
  });

  it("assertLiveReply rejects a whitespace-only reply", () => {
    expect(() => assertLiveReply("   ")).toThrow(/empty/);
  });

  it("assertLiveReply rejects the stub fixture marker", () => {
    expect(() => assertLiveReply(STUB_FIXTURE_MARKER)).toThrow(
      /stub fixture marker/,
    );
  });

  it("assertLiveReply rejects a non-string reply", () => {
    expect(() => assertLiveReply(null)).toThrow(/string/);
    expect(() => assertLiveReply(undefined)).toThrow(/string/);
    expect(() => assertLiveReply(42)).toThrow(/string/);
  });
});

describe("Android cloud-onboarding liveness wiring (#14359 / #16936)", () => {
  it("imports assertOnboardingLiveness from the shared liveness contract", () => {
    expect(specSource).toMatch(/from\s+"\.\.\/liveness-contract"/);
    expect(specSource).toContain("assertOnboardingLiveness");
  });

  it("makes strict liveness intrinsic — no ELIZA_ONBOARDING_LIVENESS env gate", () => {
    // The old code gated strict liveness behind LIVENESS_ENABLED. That env flag
    // must NOT exist in the spec — liveness is always asserted.
    expect(specSource).not.toContain("LIVENESS_ENABLED");
    expect(specSource).not.toContain("ELIZA_ONBOARDING_LIVENESS");
  });

  it("does not import sendChatAndReadReply (the weaker non-stub path)", () => {
    // The old default branch used sendChatAndReadReply without the assertion.
    // With intrinsic liveness, only assertOnboardingLiveness is needed.
    expect(specSource).not.toMatch(/import\s+\{[^}]*sendChatAndReadReply/);
  });

  it("uses a run-unique challenge prompt (not a generic hello)", () => {
    expect(specSource).toMatch(/randomBytes/);
    expect(specSource).toMatch(/challenge/);
  });

  it("captures a reply JPG screenshot artifact", () => {
    expect(specSource).toMatch(/reply-liveness\.jpg/);
    expect(specSource).toMatch(/reply liveness screenshot/);
  });

  it("ends every mode with the liveness assertion (no if/else branch)", () => {
    // Both modes call runCloudOnboardingMode which must contain the liveness
    // assertion block unconditionally.
    expect(specSource).toMatch(/await assertOnboardingLiveness/);
  });
});
