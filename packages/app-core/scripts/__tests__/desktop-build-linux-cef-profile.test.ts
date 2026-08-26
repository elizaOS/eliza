/** Guards the production desktop builder's Linux CEF hotfix sequencing. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../desktop-build.mjs", import.meta.url)),
  "utf8",
);

function functionSource(name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  expect(start, `${name} should exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextName} should follow ${name}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("desktop Linux CEF hotfix sequencing", () => {
  it("allows lazy native artifacts to remain absent during preflight", () => {
    const preflight = functionSource(
      "runDesktopPreflight",
      "preflightStoreVariantSigning",
    );
    expect(preflight).toContain("patchElectrobunLinuxCefProfile();");
    expect(preflight).not.toContain("requireNative: true");
  });

  it("requires the native patch after the first package pass and repackages", () => {
    const packaging = functionSource("packageDesktopBuild", "runDesktopBuild");
    const firstPackage = packaging.indexOf("runElectrobun(packageArgs");
    const requirePatch = packaging.indexOf(
      "patchElectrobunLinuxCefProfile({ requireNative: true })",
    );
    const secondPackage = packaging.indexOf(
      "runElectrobun(packageArgs",
      firstPackage + 1,
    );

    expect(firstPackage).toBeGreaterThanOrEqual(0);
    expect(requirePatch).toBeGreaterThan(firstPackage);
    expect(secondPackage).toBeGreaterThan(requirePatch);
    expect(packaging).toContain(
      "repackageForLinuxCefProfile || repackageForRpcHardening",
    );
  });
});
