/**
 * Structural coverage for the physical-iPhone remote pairing harness. The
 * canonical and generated AppUITest copies must stay identical, and the trust
 * confirmation must target WebKit's native XCUI alert before any document
 * fallback so the alert cannot interrupt its own tap.
 */
import { readFileSync } from "node:fs";
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
const appHarness = readFileSync(appHarnessPath, "utf8");
const canonicalHarness = readFileSync(canonicalHarnessPath, "utf8");

describe("physical iPhone remote pairing harness", () => {
  it("keeps the generated AppUITest copy identical to canonical source", () => {
    expect(appHarness).toBe(canonicalHarness);
  });

  it("scopes WebKit trust confirmation to its native alert first", () => {
    const nativeQuery = appHarness.indexOf(
      "let nativeConfirm = app.alerts.buttons.matching(",
    );
    const documentQuery = appHarness.indexOf(
      "let documentConfirm = app.buttons.matching(",
    );
    const selection = appHarness.indexOf(
      "let confirm = nativeConfirm.exists ? nativeConfirm : documentConfirm",
    );

    expect(nativeQuery).toBeGreaterThanOrEqual(0);
    expect(documentQuery).toBeGreaterThan(nativeQuery);
    expect(selection).toBeGreaterThan(documentQuery);
  });
});
