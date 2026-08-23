/** Verifies the hosted Windows lane retains its staged compiled-host and registration lifecycle proof. */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../../../..");
const workflowSource = fs.readFileSync(
  path.join(repoRoot, ".github/workflows/browser-bridge-windows-security.yml"),
  "utf8",
);
const proofSource = fs.readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/electrobun/scripts/test-browser-bridge-windows-native-host.ps1",
  ),
  "utf8",
);
const installerProofSource = fs.readFileSync(
  path.join(
    repoRoot,
    "packages/app-core/platforms/electrobun/scripts/verify-windows-installer-proof.ps1",
  ),
  "utf8",
);

describe("browser bridge hosted Windows native-host proof", () => {
  it("runs a staged compiled-host probe and registration lifecycle contracts", () => {
    expect(workflowSource).toContain("timeout-minutes: 30");
    expect(workflowSource).toContain(
      "- name: Compile and probe staged Windows native host\n        shell: powershell\n        run: packages/app-core/platforms/electrobun/scripts/test-browser-bridge-windows-native-host.ps1",
    );
    expect(workflowSource).toContain("browser-bridge-registration.test.ts");
    expect(workflowSource).toContain("browser-bridge-unregister.test.ts");
  });

  it("distinguishes adjacent-helper success from the app-not-running fallback", () => {
    expect(proofSource).toContain("bun build --compile --minify");
    expect(proofSource).toContain("--target bun-windows-x64");
    expect(proofSource).toContain('"browser-bridge-secret.ps1"');
    expect(proofSource).toContain('ELIZA_STATE_DIR"] = $stateRoot');
    expect(proofSource).toContain('$response.code -eq "app_not_running"');
    expect(proofSource).toContain('$response.code -ne "broker_unavailable"');
  });

  it("requires registry defaults to point at the installed manifests", () => {
    expect(installerProofSource).toContain(
      "Get-CurrentUserDefaultRegistryValue $registration.RegistryKey",
    );
    expect(installerProofSource).toContain(
      "[System.IO.Path]::GetFullPath([string]$registeredManifestPath)",
    );
    expect(installerProofSource).toContain(
      "[System.IO.Path]::GetFullPath($registration.ManifestPath)",
    );
  });
});
