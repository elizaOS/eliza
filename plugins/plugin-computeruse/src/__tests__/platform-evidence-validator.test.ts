/**
 * Exercises the validate-platform-evidence CLI over temp manifests via spawnSync,
 * asserting accept/reject on the platform-contract rules.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const validator = path.join(
  packageRoot,
  "scripts/validate-platform-evidence.mjs",
);

function runValidator(args: string[] = []) {
  return spawnSync(process.execPath, [validator, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
  });
}

function withTempManifest(
  manifest: unknown,
  run: (manifestPath: string) => void,
): void {
  const dir = mkdtempSync(
    path.join(tmpdir(), "computeruse-platform-evidence-"),
  );
  try {
    const manifestPath = path.join(dir, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    run(manifestPath);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function completeMacosManifest() {
  const checks = [
    "capabilityProbe",
    "screenRecordingPermission",
    "screenshotCapture",
    "accessibilityPermission",
    "mouseKeyboardInput",
    "windowListFocus",
    "browserAutomation",
    "clipboardRoundTrip",
    "approvalMode",
  ].map((id) => ({
    id,
    method: id,
    status: "passed",
    requiredEvidence: [`${id} evidence recorded`],
  }));

  return {
    schemaVersion: 1,
    platform: "macos-desktop",
    status: "passed",
    target: {
      minimumMacos: "macOS 13 or newer",
      requiredPermissions: ["Screen Recording", "Accessibility"],
      driver: "nutjs",
    },
    evidence: {
      machineModel: "MacBookPro-test",
      macosVersion: "15.5",
      buildId: "test-build",
      validatedAt: "2026-06-23T00:00:00.000Z",
      validator: "vitest",
      artifacts: ["evidence/macos-smoke.png"],
    },
    checks,
  };
}

function completeLinuxManifest() {
  const checks = [
    "capabilityProbe",
    "dependencyProbe",
    "screenshotCapture",
    "mouseKeyboardInput",
    "windowListFocus",
    "browserAutomation",
    "clipboardRoundTrip",
    "terminalSafety",
    "approvalMode",
  ].map((id) => ({
    id,
    method: id,
    status: "passed",
    requiredEvidence: [`${id} evidence recorded`],
  }));

  return {
    schemaVersion: 1,
    platform: "linux-desktop",
    status: "passed",
    target: {
      minimumDistribution: "Ubuntu 22.04",
      displayServer: "X11",
      driver: "nutjs",
    },
    evidence: {
      machineId: "linux-test-machine",
      distribution: "Ubuntu 24.04",
      kernelVersion: "6.8.0-test",
      displayServer: "X11",
      buildId: "test-build",
      validatedAt: "2026-06-23T00:00:00.000Z",
      validator: "vitest",
      artifacts: ["evidence/linux-smoke.png"],
    },
    checks,
  };
}

function completeWindowsManifest() {
  const checks = [
    "capabilityProbe",
    "screenshotCapture",
    "mouseKeyboardInput",
    "windowListFocus",
    "browserAutomation",
    "clipboardRoundTrip",
    "terminalSafety",
    "approvalMode",
    "windowsHardeningRegression",
  ].map((id) => ({
    id,
    method: id,
    status: "passed",
    requiredEvidence: [`${id} evidence recorded`],
  }));

  return {
    schemaVersion: 1,
    platform: "windows-desktop",
    status: "passed",
    target: {
      minimumWindows: "Windows 10 or newer",
      driver: "nutjs",
      shell: "PowerShell -NoProfile",
    },
    evidence: {
      machineModel: "Windows-test-machine",
      windowsVersion: "Windows 11 Pro",
      buildId: "test-build",
      validatedAt: "2026-06-23T00:00:00.000Z",
      validator: "vitest",
      artifacts: ["evidence/windows-smoke.png"],
    },
    checks,
  };
}

describe("platform evidence validator", () => {
  it("validates all tracked manifests in non-complete mode", () => {
    const result = runValidator();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "[ios-device-evidence] 10 checks validated (requires_device_evidence)",
    );
    expect(result.stdout).toContain(
      "[android-device-evidence] 10 checks validated (requires_device_evidence)",
    );
    expect(result.stdout).toContain(
      "[android-aosp-evidence] 8 checks validated (requires_device_evidence)",
    );
    expect(result.stdout).toContain(
      "[macos-desktop-evidence] 9 checks validated (passed)",
    );
    expect(result.stdout).toContain(
      "[linux-desktop-evidence] 9 checks validated (requires_device_evidence)",
    );
    // Windows desktop CUA is fully device-verified (#9581 — real Windows 11 host,
    // 9/9 passed; see test-results/evidence/9581-windows-cua/). Its release
    // manifest is promoted to `passed`, like macOS evidence fields were promoted
    // when that on-device evidence landed.
    expect(result.stdout).toContain(
      "[windows-desktop-evidence] 9 checks validated (passed)",
    );
  });

  it("fails the complete gate while real platform evidence is still missing", () => {
    const result = runValidator(["--require-complete"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "ios-device-validation.json: --require-complete needs evidence.deviceModel",
    );
    expect(result.stderr).toContain(
      "android-device-validation.json: --require-complete needs evidence.deviceModel",
    );
    expect(result.stderr).toContain(
      "android-aosp-validation.json: --require-complete needs evidence.imageName",
    );
    expect(result.stderr).not.toContain("macos-desktop-validation.json");
    expect(result.stderr).toContain(
      "linux-desktop-validation.json: --require-complete needs evidence.machineId",
    );
    // windows-desktop is intentionally NOT asserted here: it is fully
    // device-verified (#9581, 9/9 passed) and its release manifest is promoted to
    // `passed`, so it does not trip the complete gate. The gate still fails
    // overall on iOS/Android/macOS/Linux below.
    expect(result.stderr).toContain(
      "--require-complete: check mediaProjectionCapture is requires_device_evidence",
    );
    expect(result.stderr).toContain(
      "--require-complete: check dependencyProbe is requires_device_evidence",
    );
  });

  it("rejects malformed manifests instead of silently narrowing the gate", () => {
    withTempManifest(
      {
        schemaVersion: 1,
        platform: "android-consumer",
        status: "requires_device_evidence",
        target: {},
        evidence: { artifacts: [] },
        checks: [],
      },
      (manifestPath) => {
        const result = runValidator([manifestPath]);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("target.minimumApi");
        expect(result.stderr).toContain("missing check id: permissionsSetup");
        expect(result.stderr).toContain(
          "missing check id: lifeOpsScheduledTaskHandoff",
        );
      },
    );
  });

  it("allows complete desktop manifests only when evidence and statuses are present", () => {
    withTempManifest(completeMacosManifest(), (manifestPath) => {
      const result = runValidator(["--require-complete", manifestPath]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "[macos-desktop-evidence] 9 checks validated (passed)",
      );
    });
    withTempManifest(completeLinuxManifest(), (manifestPath) => {
      const result = runValidator(["--require-complete", manifestPath]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "[linux-desktop-evidence] 9 checks validated (passed)",
      );
    });
    withTempManifest(completeWindowsManifest(), (manifestPath) => {
      const result = runValidator(["--require-complete", manifestPath]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "[windows-desktop-evidence] 9 checks validated (passed)",
      );
    });
  });
});
