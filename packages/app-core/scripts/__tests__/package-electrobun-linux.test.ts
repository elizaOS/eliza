/** Direct Linux package orchestration must be independently selectable and cleanup-safe. */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSelectedLinuxPackages,
  DIRECT_LINUX_PACKAGE_FORMATS,
  resolveLinuxPackageFormats,
  withStagingCleanup,
} from "../package-electrobun-linux.mjs";

const tempDirs: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "linux-package-test-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("direct Linux package format selection", () => {
  it("preserves the historical all-format default and explicit all alias", () => {
    expect(resolveLinuxPackageFormats(undefined)).toEqual([
      "deb",
      "rpm",
      "appimage",
    ]);
    expect(resolveLinuxPackageFormats("all")).toEqual([
      "deb",
      "rpm",
      "appimage",
    ]);
    expect(DIRECT_LINUX_PACKAGE_FORMATS).toEqual(["deb", "rpm", "appimage"]);
  });

  it("runs every builder in the historical order when no selector is given", async () => {
    const calls: string[] = [];
    const builders = {
      deb: vi.fn(async () => {
        calls.push("deb");
        return "package.deb";
      }),
      rpm: vi.fn(async () => {
        calls.push("rpm");
        return "package.rpm";
      }),
      appimage: vi.fn(async () => {
        calls.push("appimage");
        return "package.AppImage";
      }),
    };

    await expect(
      buildSelectedLinuxPackages(
        "/build",
        resolveLinuxPackageFormats(undefined),
        builders,
      ),
    ).resolves.toEqual(["package.deb", "package.rpm", "package.AppImage"]);
    expect(calls).toEqual(["deb", "rpm", "appimage"]);
  });

  it.each(["deb", "rpm", "appimage"])(
    "selects only the requested %s builder",
    async (format) => {
      const builders = {
        deb: vi.fn(async () => "package.deb"),
        rpm: vi.fn(async () => "package.rpm"),
        appimage: vi.fn(async () => "package.AppImage"),
      };

      const outputs = await buildSelectedLinuxPackages(
        "/build",
        resolveLinuxPackageFormats(format),
        builders,
      );

      expect(outputs).toEqual([
        format === "deb"
          ? "package.deb"
          : format === "rpm"
            ? "package.rpm"
            : "package.AppImage",
      ]);
      for (const candidate of DIRECT_LINUX_PACKAGE_FORMATS) {
        expect(builders[candidate]).toHaveBeenCalledTimes(
          candidate === format ? 1 : 0,
        );
      }
    },
  );

  it("rejects unknown formats before packaging", () => {
    expect(() => resolveLinuxPackageFormats("snap")).toThrow(
      /Unsupported Linux package format "snap"/,
    );
  });
});

describe("direct Linux package staging cleanup", () => {
  it("removes staging after success", async () => {
    const parent = tempDir();
    const staging = path.join(parent, "success-stage");

    await expect(
      withStagingCleanup(staging, async () => {
        mkdirSync(staging);
        writeFileSync(path.join(staging, "payload"), "data");
        return "complete";
      }),
    ).resolves.toBe("complete");
    expect(existsSync(staging)).toBe(false);
  });

  it("removes staging and preserves the operation error after failure", async () => {
    const parent = tempDir();
    const staging = path.join(parent, "failure-stage");
    const failure = new Error("packager failed");

    await expect(
      withStagingCleanup(staging, async () => {
        mkdirSync(staging);
        writeFileSync(path.join(staging, "payload"), "data");
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(existsSync(staging)).toBe(false);
  });
});
