/**
 * Contract test for the iOS cloud-onboarding liveness wiring (#14359 / #16936).
 *
 * Verifies that the iOS cloud-onboarding smoke harness passes a liveness flag
 * to the in-app verifier, the in-app verifier parses it, and the harness
 * validates the non-stub reply. This is a static-source contract check — the
 * device-lane execution requires iOS simulator infra (ci:device family), but
 * the wiring must be present and correct in the committed source.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(testDir, "..");
const harnessPath = path.join(
  appDir,
  "scripts",
  "ios-cloud-onboarding-smoke.mjs",
);
const mainPath = path.join(appDir, "src", "main.tsx");

const harnessSource = readFileSync(harnessPath, "utf8");
const mainSource = readFileSync(mainPath, "utf8");

describe("iOS cloud-onboarding liveness wiring (#14359 / #16936)", () => {
  it("harness passes liveness flag in the smoke request JSON", () => {
    expect(harnessSource).toContain("livenessEnabled");
    expect(harnessSource).toMatch(/JSON\.stringify\(\s*\{[^}]*liveness/);
  });

  it("harness validates the liveness reply when liveness is enabled", () => {
    expect(harnessSource).toContain("livenessReply");
    expect(harnessSource).toContain("STUB_FIXTURE_MARKER");
    expect(harnessSource).toMatch(
      /liveness was requested but no reply was captured/,
    );
    expect(harnessSource).toMatch(/stub fixture marker/);
  });

  it("harness imports STUB_FIXTURE_MARKER from the shared liveness contract", () => {
    expect(harnessSource).toMatch(
      /from\s+"\.\.\/test\/liveness-contract\.mjs"/,
    );
  });

  it("in-app verifier parses liveness and livenessPrompt from the request", () => {
    expect(mainSource).toMatch(
      /parseIosCloudOnboardingSmokeRequest[\s\S]*liveness/,
    );
    expect(mainSource).toMatch(/parsed\.liveness\s*===\s*true/);
    expect(mainSource).toMatch(/livenessPrompt/);
  });

  it("in-app verifier calls driveIosLivenessChatTurn when liveness is true", () => {
    const cloudSmokeFn =
      /runIosCloudOnboardingSmokeIfRequested[\s\S]*?driveIosLivenessChatTurn/;
    expect(mainSource).toMatch(cloudSmokeFn);
  });

  it("in-app verifier reports livenessRequested and livenessReply in the result", () => {
    const cloudResultBlock =
      /writeIosCloudOnboardingSmokeResult[\s\S]*?livenessRequested[\s\S]*?livenessReply/;
    expect(mainSource).toMatch(cloudResultBlock);
  });
});
