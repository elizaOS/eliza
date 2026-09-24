import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadProfile,
  verifyArchive,
  verifyExtractedVendor,
} from "../aosp/verify-source-lock.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("AOSP source locks", () => {
  test("Pixel 9a is pinned to its matching public source and vendor build", () => {
    const profile = loadProfile("pixel9a");
    expect(profile.device).toMatchObject({
      codename: "tegu",
      buildId: "BD4A.250505.003",
    });
    expect(profile.manifest.tag).toBe("android-15.0.0_r31");
    expect(profile.projects.map((project) => project.path)).toEqual([
      "device/google/caimito",
      "device/google/caimito-sepolicy",
      "device/google/tegu",
      "device/google/tegu-sepolicy",
      "device/google/tegu-kernels/6.1",
      "device/google/zumapro",
      "device/google/zumapro-sepolicy",
      "device/google/gs-common",
    ]);
    expect(profile.requiredSourceFiles).toContain(
      "device/google/tegu-kernels/6.1/25D4/Image.lz4",
    );
    expect(profile.proprietaryArchive.licenseAcceptance).toBe(
      "interactive-user-required",
    );
    expect(profile.installerEligibility).toBe(
      "blocked-until-physical-evidence",
    );
  });

  test("the verification profile cannot drift from the Pixel build lock", () => {
    const profile = loadProfile("pixel9a");
    const buildLock = JSON.parse(
      readFileSync(join(repositoryRoot, "android/pixel9a.lock.json"), "utf8"),
    );

    expect(profile.manifest).toEqual({
      url: buildLock.manifestUrl,
      tag: buildLock.manifestRevision,
      tagObject: buildLock.manifestTagObject,
      commit: buildLock.manifestCommit,
    });
    expect(profile.projects).toEqual(buildLock.projects);
    expect(profile.requiredSourceFiles).toEqual(buildLock.requiredSourceFiles);
    expect(profile.proprietaryArchive).toMatchObject(
      buildLock.proprietaryArchive,
    );
  });

  test("vendor inputs reject wrong filename, size, and digest", () => {
    const profile = structuredClone(loadProfile("pixel9a"));
    const root = mkdtempSync(join(tmpdir(), "aosp-lock-"));
    const archive = join(root, "fixture.tgz");
    writeFileSync(archive, "locked fixture");
    profile.proprietaryArchive.filename = "fixture.tgz";
    profile.proprietaryArchive.sizeBytes = 14;
    profile.proprietaryArchive.sha256 =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(() => verifyArchive(profile, archive)).toThrow("SHA-256");
    profile.proprietaryArchive.sizeBytes = 99;
    expect(() => verifyArchive(profile, archive)).toThrow("archive size");
  });

  test("vendor extraction is fail-closed until every required path exists", () => {
    const profile = structuredClone(loadProfile("pixel9a"));
    profile.proprietaryArchive.requiredExtractedFiles = [
      "vendor/google_devices/tegu/proprietary/vendor.img",
      "vendor/google_devices/tegu/proprietary/vendor_dlkm.img",
    ];
    const root = mkdtempSync(join(tmpdir(), "aosp-vendor-"));
    mkdirSync(join(root, "vendor/google_devices/tegu/proprietary"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "vendor/google_devices/tegu/proprietary/vendor.img"),
      "fixture",
    );
    expect(() => verifyExtractedVendor(profile, root)).toThrow(
      "vendor_dlkm.img",
    );
    writeFileSync(
      join(root, "vendor/google_devices/tegu/proprietary/vendor_dlkm.img"),
      "fixture",
    );
    expect(verifyExtractedVendor(profile, root).files).toHaveLength(2);
  });
});
