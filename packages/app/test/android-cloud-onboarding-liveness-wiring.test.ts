/**
 * Contract test for the Android cloud-onboarding liveness wiring (#14359 / #16936).
 *
 * Verifies that the Android cloud-onboarding device spec imports and invokes
 * the shared liveness contract after the home surface is reached. The actual
 * device-lane execution requires an Android emulator (ci:device family), but
 * the wiring must be present and correct in the committed spec.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.join(
  testDir,
  "android",
  "cloud-onboarding.android.spec.ts",
);

const specSource = readFileSync(specPath, "utf8");

describe("Android cloud-onboarding liveness wiring (#14359 / #16936)", () => {
  it("imports the shared liveness contract", () => {
    expect(specSource).toMatch(/from\s+"\.\.\/liveness-contract"/);
    expect(specSource).toContain("assertOnboardingLiveness");
    expect(specSource).toContain("sendChatAndReadReply");
  });

  it("gates the strict non-stub assertion on ELIZA_ONBOARDING_LIVENESS", () => {
    expect(specSource).toContain("LIVENESS_ENABLED");
    expect(specSource).toMatch(/ELIZA_ONBOARDING_LIVENESS/);
  });

  it("ends every mode (tap + autologin) with a chat turn", () => {
    // Both modes call runCloudOnboardingMode which must contain the liveness
    // assertion block.
    expect(specSource).toMatch(/if \(LIVENESS_ENABLED\)/);
    expect(specSource).toMatch(/android-cloud-onboarding-\$\{mode\}/);
  });

  it("asserts a non-empty reply even without the liveness flag", () => {
    expect(specSource).toMatch(
      /cloud onboarding chat turn must produce a non-empty reply/,
    );
  });

  it("attaches the liveness reply as test evidence", () => {
    expect(specSource).toMatch(
      /testInfo\.attach\(`liveness reply \(\$\{mode\}\)`/,
    );
  });
});
