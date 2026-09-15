/** Guards the physical voice and Android workflows against archiving raw diagnostics. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const voiceWorkflow = fs.readFileSync(
  path.join(repoRoot, ".github/workflows/voice-live-e2e.yml"),
  "utf8",
);
const androidWorkflow = fs.readFileSync(
  path.join(repoRoot, ".github/workflows/android-arm64-local-e2e.yml"),
  "utf8",
);
const androidRunner = fs.readFileSync(
  path.join(repoRoot, "packages/app/scripts/android-e2e.mjs"),
  "utf8",
);
const preflight = path.join(
  repoRoot,
  ".github/scripts/device-e2e/arm64-local-preflight.sh",
);
const runnerTempExpression = "$" + "{{ runner.temp }}";
const runIdentityExpression =
  "$" + "{{ github.run_id }}-$" + "{{ github.run_attempt }}";

function executable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function preflightFixture(serial) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arm64-preflight-"));
  const bin = path.join(root, "bin");
  const githubEnv = path.join(root, "github-env");
  fs.mkdirSync(bin);
  executable(
    path.join(bin, "node"),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.15.0; else echo arm64; fi\n',
  );
  executable(path.join(bin, "bun"), "#!/bin/sh\necho 1.3.14\n");
  executable(path.join(bin, "uname"), "#!/bin/sh\necho aarch64\n");
  executable(
    path.join(bin, "java"),
    '#!/bin/sh\necho "    java.specification.version = 21" >&2\n',
  );
  executable(path.join(bin, "ffmpeg"), "#!/bin/sh\nexit 0\n");
  executable(
    path.join(bin, "adb"),
    `#!/bin/sh\ncase "$*" in\n  devices) printf 'List of devices attached\\n%s\\tdevice\\n' '${serial}' ;;\n  *ro.product.cpu.abi*) echo arm64-v8a ;;\n  *sys.boot_completed*) echo 1 ;;\nesac\n`,
  );
  return { root, bin, githubEnv };
}

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

  test("Android workflow does not archive a raw preflight stream", () => {
    expect(androidWorkflow).not.toMatch(/2>&1\s*\\?\s*\n?\s*\|\s*tee/);
    expect(androidWorkflow).toContain(runIdentityExpression);
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

  test("ARM64 preflight keeps the selected serial internal to GITHUB_ENV", () => {
    const serial = "PHYSICAL_SERIAL_CANARY-R58N9933";
    const fixture = preflightFixture(serial);
    const result = spawnSync("bash", [preflight], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        ANDROID_SERIAL: serial,
        GITHUB_ENV: fixture.githubEnv,
      },
    });
    fs.rmSync(fixture.root, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(serial);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /phase=preflight status=passed code=ARM64_DEVICE_READY checks=8/,
    );
  });

  test("ARM64 preflight rejects an unknown serial without echoing it", () => {
    const attached = "PHYSICAL_SERIAL_CANARY-attached";
    const requested = "PHYSICAL_SERIAL_CANARY-untrusted";
    const fixture = preflightFixture(attached);
    const result = spawnSync("bash", [preflight], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        ANDROID_SERIAL: requested,
        GITHUB_ENV: fixture.githubEnv,
      },
    });
    fs.rmSync(fixture.root, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(requested);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(attached);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /phase=preflight status=failed code=DEVICE_SELECTION_INVALID/,
    );
  });
});
