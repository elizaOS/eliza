/**
 * Contract test for the iOS cloud-onboarding liveness wiring (#14359 / #16936).
 *
 * Tests the real liveness contract behavior (assertLiveReply across all edge
 * cases) and verifies the iOS harness + in-app verifier wiring is correct. The
 * device-lane execution requires iOS simulator infra (ci:device family); these
 * tests prove the contract and wiring are present and correct in committed source.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertLiveReply,
  isLiveReply,
  LivenessAssertionError,
  STUB_FIXTURE_MARKER,
} from "./liveness-contract.mjs";

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

describe("liveness contract — assertLiveReply behavior (#14359 / #16936)", () => {
  it("accepts a real non-stub reply and returns trimmed text", () => {
    expect(assertLiveReply("  Hello from a real agent!  ")).toBe(
      "Hello from a real agent!",
    );
  });

  it("rejects an empty reply with LivenessAssertionError", () => {
    expect(() => assertLiveReply("")).toThrow(LivenessAssertionError);
    expect(() => assertLiveReply("")).toThrow(/empty/);
  });

  it("rejects a whitespace-only reply", () => {
    expect(() => assertLiveReply("   \n\t  ")).toThrow(/empty/);
  });

  it("rejects the stub fixture marker", () => {
    expect(() => assertLiveReply(STUB_FIXTURE_MARKER)).toThrow(
      /stub fixture marker/,
    );
  });

  it("rejects a reply containing the stub marker as substring", () => {
    expect(() =>
      assertLiveReply(`prefix ${STUB_FIXTURE_MARKER} suffix`),
    ).toThrow(/stub fixture marker/);
  });

  it("rejects a null reply", () => {
    expect(() => assertLiveReply(null)).toThrow(/string.*null/);
  });

  it("rejects an undefined reply", () => {
    expect(() => assertLiveReply(undefined)).toThrow(/string.*undefined/);
  });

  it("rejects a numeric reply", () => {
    expect(() => assertLiveReply(42)).toThrow(/string.*number/);
  });

  it("includes the label in the error message when provided", () => {
    expect(() =>
      assertLiveReply("", { label: "ios-cloud-onboarding-tap" }),
    ).toThrow(/ios-cloud-onboarding-tap/);
  });
});

describe("liveness contract — isLiveReply predicate behavior", () => {
  it("returns true for a real reply", () => {
    expect(isLiveReply("Hello agent!")).toBe(true);
  });

  it("returns false for an empty reply", () => {
    expect(isLiveReply("")).toBe(false);
  });

  it("returns false for the stub marker", () => {
    expect(isLiveReply(STUB_FIXTURE_MARKER)).toBe(false);
  });

  it("returns false for a non-string", () => {
    expect(isLiveReply(null)).toBe(false);
    expect(isLiveReply(undefined)).toBe(false);
    expect(isLiveReply(0)).toBe(false);
  });
});

describe("iOS cloud-onboarding harness liveness wiring (#14359 / #16936)", () => {
  it("always sends liveness: true (not gated by env vars)", () => {
    expect(harnessSource).toContain("liveness: true");
    expect(harnessSource).not.toMatch(
      /ELIZA_ONBOARDING_LIVENESS|IOS_CLOUD_ONBOARDING_LIVENESS/,
    );
  });

  it("uses a run-unique challenge prompt via cryptoRandomHex", () => {
    expect(harnessSource).toMatch(/cryptoRandomHex/);
    expect(harnessSource).toMatch(/livenessChallenge/);
  });

  it("validates the liveness reply unconditionally", () => {
    expect(harnessSource).toContain("STUB_FIXTURE_MARKER");
    expect(harnessSource).toMatch(
      /liveness was requested but no reply was captured/,
    );
    expect(harnessSource).toMatch(/stub fixture marker/);
    expect(harnessSource).not.toContain("livenessEnabled");
  });

  it("imports STUB_FIXTURE_MARKER from the shared liveness contract", () => {
    expect(harnessSource).toMatch(
      /from\s+"\.\.\/test\/liveness-contract\.mjs"/,
    );
  });
});

describe("iOS in-app verifier liveness wiring (#14359 / #16936)", () => {
  it("parseIosCloudOnboardingSmokeRequest defaults liveness to true", () => {
    // The cloud parse function's fallback has mode + livenessPrompt + liveness.
    // Match it specifically (the remote-connect fallback has apiBase instead of mode).
    const cloudFallbackMatch = mainSource.match(
      /const\s+fallback\s*=\s*\{\s*mode:[^}]*liveness:\s*(true|false)[^}]*livenessPrompt/,
    );
    expect(cloudFallbackMatch).toBeTruthy();
    expect(cloudFallbackMatch?.[1]).toBe("true");
  });

  it("parseIosCloudOnboardingSmokeRequest defaults liveness to true when key absent", () => {
    // parsed.liveness !== false means absent/undefined → true
    expect(mainSource).toMatch(/parsed\.liveness\s*!==\s*false/);
  });

  it("always drives the chat turn in the cloud path (not gated by request.liveness)", () => {
    // The cloud path's livenessReply must be unconditional — find the block
    // after writeIosCloudOnboardingSmokeResult's ok: check, not the remote-
    // connect path (writeIosOnboardingSmokeResult).
    const cloudFnStart = mainSource.indexOf(
      "runIosCloudOnboardingSmokeIfRequested",
    );
    expect(cloudFnStart).toBeGreaterThan(-1);
    const cloudFnEnd = mainSource.indexOf(
      "writeIosCloudOnboardingSmokeResult",
      mainSource.indexOf("ok:", cloudFnStart + 100),
    );
    expect(cloudFnEnd).toBeGreaterThan(cloudFnStart);
    const cloudFnBody = mainSource.slice(cloudFnStart, cloudFnEnd + 100);
    expect(cloudFnBody).toMatch(/await driveIosLivenessChatTurn/);
    // The old conditional must be gone in the cloud path
    expect(cloudFnBody).not.toMatch(
      /request\.liveness\s*\?\s*await driveIosLivenessChatTurn/,
    );
  });

  it("reports livenessRequested: true in the result (not request.liveness)", () => {
    expect(mainSource).toMatch(/livenessRequested:\s*true/);
  });

  it("parses livenessPrompt from the request", () => {
    expect(mainSource).toMatch(/livenessPrompt/);
  });
});
