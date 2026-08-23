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

  it("uses a validated per-run reply marker instead of stale transcript text", () => {
    expect(harnessUnderTest).toContain('env["ELIZA_TEST_CHAT_REPLY_MARKER"]');
    expect(harnessUnderTest).toContain(
      "configured.utf8.allSatisfy(isAllowedAscii)",
    );
    expect(harnessUnderTest).toContain(
      "ELIZA_TEST_CHAT_REPLY_MARKER must be 8-96 ASCII letters",
    );
  });

  it("proves the paired remote session survives a same-container relaunch", () => {
    const testStart = harnessUnderTest.indexOf(
      "func testPairedRemoteChatPersistsAcrossRelaunch() throws",
    );
    const helperStart = harnessUnderTest.indexOf(
      "private func requireHome(",
      testStart,
    );
    const testBody = harnessUnderTest.slice(testStart, helperStart);

    expect(testStart).toBeGreaterThanOrEqual(0);
    expect(testBody).toContain('env["ELIZA_TEST_CHAT_BEFORE_RESTART_MARKER"]');
    expect(testBody).toContain('env["ELIZA_TEST_CHAT_AFTER_RESTART_MARKER"]');
    expect(testBody).toContain("app.terminate()");
    expect(testBody).toContain("launchWithRetry(app)");
    expect(testBody.match(/sendPairedChatTurn\(/g)).toHaveLength(2);
    expect(
      testBody.match(/connectRemoteAgentFromClipboardIfRequested\(/g),
    ).toHaveLength(1);
    expect(testBody).toContain(
      "the remote session fell back to signed-out Cloud after relaunch",
    );
  });
});
