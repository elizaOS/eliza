/**
 * Structural coverage for the physical-iPhone remote pairing harness. The
 * canonical and generated AppUITest copies must stay identical, and the trust
 * confirmation must target WebKit's native XCUI alert before any document
 * fallback so the alert cannot interrupt its own tap.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(import.meta.dirname, "..");
const appHarnessPath = path.join(
  appRoot,
  "ios/App/AppUITests/BootCaptureUITests.swift",
);
const canonicalHarnessPath = path.resolve(
  appRoot,
  "../app-core/platforms/ios/App/AppUITests/BootCaptureUITests.swift",
);
const canonicalHarness = readFileSync(canonicalHarnessPath, "utf8");
const materializedAppHarness = existsSync(appHarnessPath)
  ? readFileSync(appHarnessPath, "utf8")
  : null;
const harnessUnderTest = materializedAppHarness ?? canonicalHarness;

describe("physical iPhone remote pairing harness", () => {
  it("keeps the generated AppUITest copy identical when materialized", () => {
    if (materializedAppHarness !== null) {
      expect(materializedAppHarness).toBe(canonicalHarness);
    }
  });

  it("scopes WebKit trust confirmation to its native alert first", () => {
    const nativeQuery = harnessUnderTest.indexOf(
      "let nativeConfirm = app.alerts.buttons.matching(",
    );
    const documentQuery = harnessUnderTest.indexOf(
      "let documentConfirm = app.buttons.matching(",
    );
    const selection = harnessUnderTest.indexOf(
      "let confirm = nativeConfirm.exists ? nativeConfirm : documentConfirm",
    );

    expect(nativeQuery).toBeGreaterThanOrEqual(0);
    expect(documentQuery).toBeGreaterThan(nativeQuery);
    expect(selection).toBeGreaterThan(documentQuery);
  });

  it("requires the scoped Local Network alert to disappear before routing", () => {
    expect(harnessUnderTest).toContain(
      'let allow = springboard.alerts.buttons["Allow"]',
    );
    expect(harnessUnderTest).toContain(
      "the Local Network permission sheet did not dismiss after Allow",
    );
    expect(harnessUnderTest).not.toContain(
      'let allow = springboard.buttons["Allow"]',
    );
  });
});
