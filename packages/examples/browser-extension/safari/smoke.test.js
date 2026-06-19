import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("Safari extension package", () => {
  test("removes unsupported offscreen permission from generated source", () => {
    const prepare = read("scripts/prepare-safari-source.mjs");

    expect(prepare).toContain(
      'unsupportedSafariPermissions = new Set(["offscreen"])',
    );
    expect(prepare).toContain("chromeManifest.permissions.filter");
    expect(prepare).toContain('join(safariSourceRoot, "manifest.json")');
  });

  test("skips conversion unless macOS/Xcode artifacts are available", () => {
    const build = read("scripts/build-safari-extension.mjs");

    expect(build).toContain('process.platform !== "darwin"');
    expect(build).toContain("ELIZA_BUILD_SAFARI_EXTENSION");
    expect(build).toContain("requiredChromeArtifact");
    expect(build).toContain("safari-web-extension-converter");
  });
});
