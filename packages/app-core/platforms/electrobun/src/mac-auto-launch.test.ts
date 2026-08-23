/** Locks macOS Launch at Login to Apple's public SMAppService authority. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const nativeSource = readFileSync(
  fileURLToPath(new URL("../native/macos/window-effects.mm", import.meta.url)),
  "utf8",
);
const desktopSource = readFileSync(
  fileURLToPath(new URL("./native/desktop.ts", import.meta.url)),
  "utf8",
);
const buildScript = readFileSync(
  fileURLToPath(new URL("../scripts/build-macos-effects.sh", import.meta.url)),
  "utf8",
);

describe("macOS Launch at Login authority", () => {
  it("uses SMAppService.mainAppService on macOS 13+", () => {
    expect(nativeSource).toContain("<ServiceManagement/ServiceManagement.h>");
    expect(nativeSource).toContain("[SMAppService mainAppService]");
    expect(nativeSource).toContain("registerAndReturnError");
    expect(nativeSource).toContain("unregisterAndReturnError");
    expect(nativeSource).toContain("@available(macOS 13.0, *)");
    expect(buildScript).toContain("-framework ServiceManagement");
  });

  it("does not write or load a macOS LaunchAgent plist", () => {
    const macSection = desktopSource.slice(
      desktopSource.indexOf("// MARK: - Auto-launch helpers (macOS)"),
      desktopSource.indexOf("// MARK: - Auto-launch helpers (Linux)"),
    );

    expect(macSection).not.toContain("LaunchAgents");
    expect(macSection).not.toContain("launchctl");
    expect(macSection).not.toContain("writeFileSync");
    expect(macSection).toContain("setMacLaunchAtLoginEnabled");
  });
});
