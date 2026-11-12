/** Guards the physical voice workflow and the Android runner against archiving raw diagnostics. */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const voiceWorkflow = fs.readFileSync(
  path.join(repoRoot, ".github/workflows/voice-live-e2e.yml"),
  "utf8",
);
const androidRunner = fs.readFileSync(
  path.join(repoRoot, "packages/app/scripts/android-e2e.ts"),
  "utf8",
);
const runnerTempExpression = "$" + "{{ runner.temp }}";
describe("device evidence workflow privacy", () => {
  test("voice uploads exclude raw model, backend, matrix-cell, and runner logs", () => {
    expect(voiceWorkflow).not.toContain("runner=$(hostname)");
    expect(voiceWorkflow).not.toMatch(/2>&1\s*\|\s*tee/);
    expect(voiceWorkflow).not.toContain("voice-web-live/backend.log\n");
    expect(voiceWorkflow).not.toContain(
      `${runnerTempExpression}/voice-macos-hardware-capture\n`,
    );
    expect(voiceWorkflow).not.toContain(
      `${runnerTempExpression}/voice-windows-hardware-capture\n`,
    );
    expect(voiceWorkflow).not.toContain(
      `path: ${runnerTempExpression}/voice-real-matrix\n`,
    );
    expect(voiceWorkflow).toContain(
      "phase=provisioning status=failed code=VOICE_ASSETS_QUERY_FAILED",
    );
    expect(voiceWorkflow).toContain(
      'find "$ELIZA_ASR_BUNDLE" -type f 2> "$PRIVATE_QUERY_LOG"',
    );
    expect(voiceWorkflow).toContain(
      'voice-web-live/loopback-recorder.log" 2>&1 &',
    );
  });

  test("Android runner routes helper and process diagnostics through the privacy boundary", () => {
    expect(androidRunner).toContain("createAndroidEvidenceBoundary");
    expect(androidRunner).toContain("projectAndroidDeviceEvidenceBundle");
    expect(androidRunner).toContain("settleAndroidEvidenceTeardown");
    expect(androidRunner).toContain("eliza-android-e2e-private-");
    expect(androidRunner).not.toContain("runBundledCommand");
    expect(androidRunner).not.toContain("formatFailureForensicsBlock");
    expect(androidRunner).not.toMatch(/console\.(?:log|error|warn)/);
    expect(androidRunner).not.toContain('stdio: "inherit"');
    expect(androidRunner).not.toContain("captureAndroidLogcat");
    expect(androidRunner).not.toMatch(/setBundleDevice\([^)]*serial/s);
  });
});
