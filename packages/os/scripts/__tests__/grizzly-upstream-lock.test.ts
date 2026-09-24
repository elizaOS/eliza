import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadProfile } from "../aosp/verify-source-lock.mjs";
import { assertGeneratedVendorTree } from "../distro-android/bootstrap-aosp.mjs";

const lock = JSON.parse(
  readFileSync(
    new URL("../../android/pixel11pro.lock.json", import.meta.url),
    "utf8",
  ),
);
const boardPath = "vendor/google_devices/grizzly/BoardConfig.mk";

test("grizzly source-verification profile agrees with the build lock", () => {
  const profile = loadProfile("pixel11pro");
  expect(profile.manifest).toEqual({
    url: lock.manifestUrl,
    tag: lock.manifestRevision,
    tagObject: lock.manifestTagObject,
    commit: lock.manifestCommit,
  });
  expect(profile.projects).toEqual(
    lock.externalProjects.map(
      (project: { path: string; url: string; commit: string }) => ({
        path: project.path,
        name: project.url
          .replace("https://github.com/", "")
          .replace(/\.git$/, ""),
        commit: project.commit,
      }),
    ),
  );
});

test("grizzly pins the audited extractor and its exact corrected board output", () => {
  expect(
    lock.externalProjects.find(
      (entry: { path: string }) => entry.path === "vendor/adevtool",
    ).commit,
  ).toBe("144f004cc484d7e7234cdd167cee48e5f240288f");
  expect(lock.generatedVendor.requiredArtifacts).toContainEqual({
    path: boardPath,
    sizeBytes: 3622,
    sha256: "533bf35c78f073958e82b3138eec378ae7f6f5c25545aa23de1173aa03d1545e",
  });
  // Updating the extractor must not silently mix in beta firmware/kernel blobs.
  expect(lock.referenceFactoryImage.buildId).toBe("CD1A.260714.001.A9");
  expect(lock.rollbackFactoryImage).toEqual(lock.referenceFactoryImage);
});

test("old inherited geometry and partial migrations fail the generated-text gate", () => {
  const entry = lock.generatedVendor.requiredTextFiles.find(
    (item: { path: string }) => item.path === boardPath,
  );
  const lines = [
    "BOARD_SUPER_PARTITION_SIZE := 10737418240",
    "BOARD_SUPER_PARTITION_ERROR_LIMIT := 10213130240",
    "BOARD_SUPER_PARTITION_GROUPS := google_dynamic_partitions",
    "BOARD_GOOGLE_DYNAMIC_PARTITIONS_SIZE := 10733223936",
    "BOARD_GOOGLE_DYNAMIC_PARTITIONS_PARTITION_LIST := system system_dlkm system_ext product vendor vendor_dlkm",
  ];
  expect(entry.includes).toEqual(lines);
  const root = mkdtempSync(join(tmpdir(), "grizzly-geometry-test-"));
  try {
    mkdirSync(dirname(join(root, boardPath)), { recursive: true });
    const textContract = {
      generatedVendor: {
        requiredFiles: [boardPath],
        requiredTextFiles: [entry],
      },
    };
    writeFileSync(join(root, boardPath), lines.join("\n"));
    expect(() => assertGeneratedVendorTree(root, textContract)).not.toThrow();
    for (let index = 0; index < lines.length; index += 1) {
      writeFileSync(
        join(root, boardPath),
        lines.filter((_line, i) => i !== index).join("\n"),
      );
      expect(() => assertGeneratedVendorTree(root, textContract)).toThrow(
        "contract mismatch",
      );
    }
    writeFileSync(
      join(root, boardPath),
      lines.join("\n").replace("10737418240", "8531214336"),
    );
    expect(() => assertGeneratedVendorTree(root, textContract)).toThrow(
      "contract mismatch",
    );
    // Correct text alone must not satisfy the independent byte-level gate.
    writeFileSync(join(root, boardPath), lines.join("\n"));
    expect(() =>
      assertGeneratedVendorTree(root, {
        generatedVendor: {
          ...textContract.generatedVendor,
          requiredArtifacts: lock.generatedVendor.requiredArtifacts.filter(
            (item: { path: string }) => item.path === boardPath,
          ),
        },
      }),
    ).toThrow("artifact mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
