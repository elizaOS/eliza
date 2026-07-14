/**
 * Verifies version lookup against both the source tree and flattened npm layout.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ElizaError } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { resolveElizaVersion } from "./version-resolver.ts";

const temporaryRoots: string[] = [];

function packageModuleUrl(relativeModulePath: string, version: string): string {
  return metadataModuleUrl(
    relativeModulePath,
    `${JSON.stringify({ name: "version-fixture", version })}\n`,
  );
}

function metadataModuleUrl(
  relativeModulePath: string,
  metadata: string,
): string {
  const root = mkdtempSync(join(tmpdir(), "eliza-version-resolver-"));
  temporaryRoots.push(root);
  writeFileSync(join(root, "package.json"), metadata);
  const modulePath = join(root, relativeModulePath);
  mkdirSync(join(modulePath, ".."), { recursive: true });
  return pathToFileURL(modulePath).href;
}

afterEach(() => {
  delete process.env.ELIZA_BUNDLED_VERSION;
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveElizaVersion", () => {
  it("reads package metadata from the TypeScript source layout", () => {
    const moduleUrl = packageModuleUrl("src/runtime/version.js", "1.2.3");

    expect(resolveElizaVersion(moduleUrl)).toBe("1.2.3");
  });

  it("reads package metadata from the flattened npm layout", () => {
    const moduleUrl = packageModuleUrl("runtime/version.js", "4.5.6");

    expect(resolveElizaVersion(moduleUrl)).toBe("4.5.6");
  });

  it("does not let process environment spoof package identity", () => {
    process.env.ELIZA_BUNDLED_VERSION = "999.0.0";
    const moduleUrl = packageModuleUrl("runtime/version.js", "4.5.6");

    expect(resolveElizaVersion(moduleUrl)).toBe("4.5.6");
  });

  it.each([
    ["malformed JSON", "{"],
    ["non-object metadata", '"1.2.3"'],
    ["a missing version", "{}"],
    ["a blank version", '{"version":"  "}'],
    ["a version with surrounding whitespace", '{"version":" 1.2.3 "}'],
    ["an invalid version", '{"version":"release-latest"}'],
    ["a numeric prerelease with a leading zero", '{"version":"1.2.3-01"}'],
  ])("rejects %s", (_label, metadata) => {
    const moduleUrl = metadataModuleUrl("runtime/version.js", metadata);

    expect(() => resolveElizaVersion(moduleUrl)).toThrow(
      expect.objectContaining<Partial<ElizaError>>({
        code: "VERSION_METADATA_INVALID",
      }),
    );
  });

  it("rejects missing version metadata instead of fabricating a version", () => {
    const root = mkdtempSync(join(tmpdir(), "eliza-version-resolver-"));
    temporaryRoots.push(root);
    const modulePath = join(root, "runtime", "version.js");
    mkdirSync(join(modulePath, ".."), { recursive: true });

    expect(() => resolveElizaVersion(pathToFileURL(modulePath).href)).toThrow(
      expect.objectContaining<Partial<ElizaError>>({
        code: "VERSION_METADATA_MISSING",
      }),
    );
  });
});
