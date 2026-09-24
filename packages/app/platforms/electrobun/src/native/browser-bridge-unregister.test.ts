/** Verifies that Windows packaging invokes an ownership-guarded browser registration cleanup. */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("browser bridge Windows uninstall integration", () => {
  it("ships a guarded cleanup helper through the real Inno uninstall lifecycle", () => {
    const helper = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../scripts/browser-bridge-unregister.ps1",
      ),
      "utf8",
    );
    const inno = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../../packaging/inno/ElizaOSApp.iss",
      ),
      "utf8",
    );

    expect(helper).toContain("[Microsoft.Win32.Registry]::CurrentUser");
    expect(helper).toContain("Test-ManifestOwnership");
    expect(helper).toContain("browser-bridge-native-host.exe");
    expect(helper).toContain("[System.StringComparison]::OrdinalIgnoreCase");
    expect(helper).toContain(
      "if ($registryOwnsManifest -and $manifestOwned -eq $true)",
    );
    expect(helper).not.toContain("$null -eq $registeredPath -or");
    expect(helper).toContain("DeleteSubKeyTree");
    expect(inno).toContain("[UninstallRun]");
    expect(inno).toContain("browser-bridge-unregister.ps1");
    expect(inno).toContain('RunOnceId: "BrowserBridgeNativeHost"');
  });
});
