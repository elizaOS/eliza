// Verifies Sideloader target selection and fail-closed release metadata rules.

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import checksums from "../../vendor/checksums.json";
import {
  installPinnedSideloader,
  resolvePinnedSideloaderTarget,
} from "../../vendor/sideloader-installer.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryVendorRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "eliza-sideloader-test-"));
  temporaryRoots.push(root);
  return root;
}

describe("pinned Sideloader installer", () => {
  it.each([
    ["darwin", "arm64", "sideloader-cli-arm64-apple-macos"],
    ["darwin", "x64", "sideloader-cli-x86_64-apple-darwin"],
    ["linux", "arm64", "sideloader-cli-aarch64-linux-gnu"],
    ["linux", "x64", "sideloader-cli-x86_64-linux-gnu"],
    ["win32", "x64", "sideloader-cli-x86_64-windows-msvc.exe"],
  ] as const)(
    "selects the reviewed %s-%s archive",
    (platform, arch, expectedBinary) => {
      const target = resolvePinnedSideloaderTarget(
        checksums.sideloader,
        platform,
        arch,
      );

      expect(target.version).toBe("1.0-pre4");
      expect(target.binary).toBe(expectedBinary);
      expect(target.asset).toContain("/releases/download/1.0-pre4/");
      expect(target.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(target.size).toBeGreaterThan(1_000_000);
    },
  );

  it("refuses architectures without an exact reviewed asset", () => {
    expect(() =>
      resolvePinnedSideloaderTarget(checksums.sideloader, "win32", "arm64"),
    ).toThrow("No pinned Sideloader target for win32-arm64");
  });

  it("refuses a release URL that drifts from the pinned version", () => {
    const config = structuredClone(checksums.sideloader);
    const target = config.pinned.targets["darwin-arm64"];
    if (!target) throw new Error("missing test fixture target");
    target.asset = target.asset.replace("1.0-pre4", "1.0-pre3");

    expect(() =>
      resolvePinnedSideloaderTarget(config, "darwin", "arm64"),
    ).toThrow("Invalid Sideloader release URL");
  });

  it("refuses an invalid checksum before any download", () => {
    const config = structuredClone(checksums.sideloader);
    const target = config.pinned.targets["linux-x64"];
    if (!target) throw new Error("missing test fixture target");
    target.sha256 = "0";

    expect(() => resolvePinnedSideloaderTarget(config, "linux", "x64")).toThrow(
      "Invalid Sideloader SHA-256",
    );
  });

  it.each(["../sideloader.zip", "nested/sideloader.zip", ".."])(
    "refuses unsafe archive filename %s",
    (archive) => {
      const config = structuredClone(checksums.sideloader);
      const target = config.pinned.targets["darwin-arm64"];
      if (!target) throw new Error("missing test fixture target");
      target.archive = archive;

      expect(() =>
        resolvePinnedSideloaderTarget(config, "darwin", "arm64"),
      ).toThrow("Invalid Sideloader archive name");
    },
  );

  it("refuses a non-GitHub download origin", () => {
    const config = structuredClone(checksums.sideloader);
    const target = config.pinned.targets["darwin-arm64"];
    if (!target) throw new Error("missing test fixture target");
    target.asset = target.asset.replace("github.com", "example.com");

    expect(() =>
      resolvePinnedSideloaderTarget(config, "darwin", "arm64"),
    ).toThrow("Invalid Sideloader release URL");
  });

  it("removes partial state when the server reports a different size", async () => {
    const root = temporaryVendorRoot();
    const body = new TextEncoder().encode("not the pinned archive");

    await expect(
      installPinnedSideloader({
        vendorRoot: root,
        platform: "darwin",
        arch: "arm64",
        config: checksums.sideloader,
        fetchImpl: async () =>
          new Response(body, {
            headers: { "content-length": String(body.byteLength) },
          }),
      }),
    ).rejects.toThrow("archive size does not match pinned metadata");
    expect(readdirSync(root)).toEqual([]);
  });

  it("removes the downloaded archive when its checksum does not match", async () => {
    const root = temporaryVendorRoot();
    const body = new TextEncoder().encode("not the pinned archive");
    const config = structuredClone(checksums.sideloader);
    const target = config.pinned.targets["darwin-arm64"];
    if (!target) throw new Error("missing test fixture target");
    target.size = body.byteLength;
    target.sha256 = createHash("sha256")
      .update("different bytes")
      .digest("hex");

    await expect(
      installPinnedSideloader({
        vendorRoot: root,
        platform: "darwin",
        arch: "arm64",
        config,
        fetchImpl: async () => new Response(body),
      }),
    ).rejects.toThrow("Sideloader checksum mismatch");
    expect(readdirSync(root)).toEqual([]);
  });
});
