/** Keeps generated macOS release apps on supported permission entitlements and permission-host signing. */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const templateElectrobunRoot = resolve(
  here,
  "../../templates/project/apps/app/electrobun",
);
const templateConfig = readFileSync(
  resolve(templateElectrobunRoot, "electrobun.config.ts"),
  "utf8",
);
const templateWrapperPath = resolve(
  templateElectrobunRoot,
  "scripts/bin/codesign",
);

describe("project template macOS permission entitlements", () => {
  it("uses audio-input instead of the unsupported microphone key", () => {
    expect(templateConfig).toContain(
      '"com.apple.security.device.audio-input": true',
    );
    expect(templateConfig).not.toContain(
      '"com.apple.security.device.microphone"',
    );
  });

  it("ships the canonical executable permission-host wrapper on the release build PATH", () => {
    const canonicalWrapperPath = resolve(
      here,
      "../../../app-core/platforms/electrobun/scripts/bin/codesign",
    );
    const packageManifest = JSON.parse(
      readFileSync(resolve(templateElectrobunRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(readFileSync(templateWrapperPath, "utf8")).toBe(
      readFileSync(canonicalWrapperPath, "utf8"),
    );
    expect(statSync(templateWrapperPath).mode & 0o111).not.toBe(0);
    expect(packageManifest.scripts.build).toContain(
      'PATH="$PWD/scripts/bin:$PATH"',
    );
  });
});
