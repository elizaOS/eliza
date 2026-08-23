/** Direct Linux package orchestration must be independently selectable and cleanup-safe. */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPIMAGETOOL_ASSETS,
  buildSelectedLinuxPackages,
  DEBIAN_RUNTIME_DEPENDS,
  DEBIAN_RUNTIME_RECOMMENDS,
  DIRECT_LINUX_PACKAGE_FORMATS,
  debArchiveBuildArgs,
  findElectrobunLauncher,
  RPM_RUNTIME_REQUIRES,
  renderAppImageLauncher,
  renderDebianControl,
  renderLinuxLauncherWrapper,
  resolveAppImageToolAsset,
  resolveLinuxPackageFormats,
  sha256File,
  stageAppImageMetadata,
  stagePackageRoot,
  withStagingCleanup,
} from "../package-electrobun-linux.mjs";

const tempDirs: string[] = [];
const hasDpkgDeb =
  process.platform === "linux" && existsSync("/usr/bin/dpkg-deb");

function tempDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "linux-package-test-"));
  tempDirs.push(directory);
  return directory;
}

function expectHardenedTree(root: string): void {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) continue;
    expect(stats.mode & 0o022, current).toBe(0);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(current)) {
        pending.push(path.join(current, entry));
      }
    }
  }
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

describe("Linux package runtime contracts", () => {
  it("declares the native wrapper, Secret Service, media, and inference dependencies", () => {
    const control = renderDebianControl();
    expect(control).toContain(`Depends: ${DEBIAN_RUNTIME_DEPENDS.join(", ")}`);
    expect(control).toContain(
      `Recommends: ${DEBIAN_RUNTIME_RECOMMENDS.join(", ")}`,
    );
    for (const dependency of [
      "libc6 (>= 2.38)",
      "libwebkit2gtk-4.1-0",
      "libsecret-1-0",
      "libasound2t64 | libasound2",
      "libvulkan1",
      "libgomp1",
    ]) {
      expect(DEBIAN_RUNTIME_DEPENDS).toContain(dependency);
    }
    expect(RPM_RUNTIME_REQUIRES).toEqual(
      expect.arrayContaining([
        "glibc >= 2.38",
        "webkit2gtk4.1",
        "libsecret",
        "vulkan-loader",
        "libgomp",
      ]),
    );
  });

  it("selects a checksum-pinned native appimagetool for both supported architectures", () => {
    expect(resolveAppImageToolAsset("x64", "x64")).toEqual(
      APPIMAGETOOL_ASSETS.x64,
    );
    expect(resolveAppImageToolAsset("arm64", "arm64")).toEqual(
      APPIMAGETOOL_ASSETS.arm64,
    );
    expect(() => resolveAppImageToolAsset("arm64", "x64")).toThrow(
      /native-only/,
    );
    expect(() => resolveAppImageToolAsset("riscv64", "riscv64")).toThrow(
      /No pinned appimagetool asset/,
    );
    for (const asset of Object.values(APPIMAGETOOL_ASSETS)) {
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(asset.updatedAt).toMatch(/^2025-/);
    }
  });

  it("computes the digest used to verify downloaded packaging tools", () => {
    const fixture = path.join(tempDir(), "asset");
    writeFileSync(fixture, "verified fixture\n");
    expect(sha256File(fixture)).toBe(
      "32dfcc02fe339f75e5d08db10ed9b7bbf2df6dc68ea5ae0b4ba3df3799f22a77",
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

describe("direct Debian payload hardening", () => {
  it("forces root ownership when dpkg-deb creates the archive", () => {
    expect(
      debArchiveBuildArgs("/tmp/eliza-deb", "/artifacts/eliza.deb"),
    ).toEqual([
      "--root-owner-group",
      "--build",
      "/tmp/eliza-deb",
      "/artifacts/eliza.deb",
    ]);
  });

  it("quotes executable paths and normalizes generated payload modes", async () => {
    const buildDir = tempDir();
    const packageRoot = path.join(tempDir(), "package-root");
    const executable = path.join(
      buildDir,
      "Eliza's Desktop $HOME",
      "bin",
      "launcher",
    );
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, '#!/usr/bin/env sh\nprintf "%s\\n" "$@"\n');
    chmodSync(executable, 0o755);
    const decoy = path.join(buildDir, "bin", "bspatch");
    mkdirSync(path.dirname(decoy), { recursive: true });
    writeFileSync(decoy, "#!/usr/bin/env sh\nexit 99\n");
    chmodSync(decoy, 0o755);
    const permissiveDir = path.join(buildDir, "mutable payload");
    mkdirSync(permissiveDir, { mode: 0o775 });
    chmodSync(permissiveDir, 0o775);
    writeFileSync(path.join(permissiveDir, "group-writable"), "fixture\n", {
      mode: 0o664,
    });
    chmodSync(path.join(permissiveDir, "group-writable"), 0o664);

    expect(findElectrobunLauncher(buildDir)).toBe(executable);

    await stagePackageRoot(buildDir, packageRoot);

    const wrapper = path.join(packageRoot, "usr/bin/eliza");
    const desktop = path.join(
      packageRoot,
      "usr/share/applications/eliza.desktop",
    );
    const icon = path.join(
      packageRoot,
      "usr/share/icons/hicolor/512x512/apps/eliza.png",
    );
    expect(readFileSync(wrapper, "utf8")).toBe(
      renderLinuxLauncherWrapper(
        "/opt/eliza/Eliza's Desktop $HOME/bin/launcher",
      ),
    );
    expect(readFileSync(desktop, "utf8")).toContain("Exec=eliza\nIcon=eliza\n");
    expect(statSync(wrapper).mode & 0o777).toBe(0o755);
    expect(statSync(desktop).mode & 0o777).toBe(0o644);
    expect(statSync(icon).mode & 0o777).toBe(0o644);
    expectHardenedTree(packageRoot);

    const localWrapper = path.join(tempDir(), "quoted-launcher");
    writeFileSync(localWrapper, renderLinuxLauncherWrapper(executable), {
      mode: 0o755,
    });
    expect(
      execFileSync(localWrapper, ["argument with spaces", "$HOME"], {
        encoding: "utf8",
      }),
    ).toBe("argument with spaces\n$HOME\n");
  });

  it("selects the direct Electrobun launcher instead of sibling tools", () => {
    const buildDir = tempDir();
    const binDir = path.join(buildDir, "bin");
    mkdirSync(binDir);
    for (const name of ["bspatch", "launcher"]) {
      const candidate = path.join(binDir, name);
      writeFileSync(candidate, `#!/usr/bin/env sh\necho ${name}\n`);
      chmodSync(candidate, 0o755);
    }

    expect(findElectrobunLauncher(buildDir)).toBe(
      path.join(binDir, "launcher"),
    );
  });

  it("stages AppImage metadata and normalized export modes", () => {
    const appDir = tempDir();
    const desktopDir = path.join(appDir, "usr/share/applications");
    mkdirSync(desktopDir, { recursive: true });
    writeFileSync(
      path.join(desktopDir, "eliza.desktop"),
      "[Desktop Entry]\nExec=eliza\n",
      { mode: 0o664 },
    );

    stageAppImageMetadata(appDir);

    const appRun = path.join(appDir, "AppRun");
    const desktop = path.join(appDir, "ai.elizaos.eliza.desktop");
    const icon = path.join(appDir, "eliza.png");
    const metainfo = path.join(
      appDir,
      "usr/share/metainfo/ai.elizaos.eliza.appdata.xml",
    );
    expect(readFileSync(appRun, "utf8")).toBe(renderAppImageLauncher());
    expect(readFileSync(appRun, "utf8")).toContain(
      "Eliza cannot start because Linux runtime libraries are missing",
    );
    expect(readFileSync(metainfo, "utf8")).toContain(
      '<launchable type="desktop-id">ai.elizaos.eliza.desktop</launchable>',
    );
    expect(statSync(appRun).mode & 0o777).toBe(0o755);
    expect(statSync(desktop).mode & 0o777).toBe(0o644);
    expect(
      existsSync(path.join(appDir, "usr/share/applications/eliza.desktop")),
    ).toBe(false);
    expect(
      statSync(
        path.join(appDir, "usr/share/applications/ai.elizaos.eliza.desktop"),
      ).mode & 0o777,
    ).toBe(0o644);
    expect(statSync(icon).mode & 0o777).toBe(0o644);
    expect(statSync(metainfo).mode & 0o777).toBe(0o644);
  });

  it.runIf(hasDpkgDeb)(
    "writes root-owned control and payload members in a tiny Debian archive",
    () => {
      const packageRoot = tempDir();
      const controlDir = path.join(packageRoot, "DEBIAN");
      const payloadDir = path.join(packageRoot, "usr/share/eliza-test");
      const archive = path.join(tempDir(), "ownership-fixture.deb");
      mkdirSync(controlDir, { recursive: true });
      mkdirSync(payloadDir, { recursive: true });
      writeFileSync(
        path.join(controlDir, "control"),
        [
          "Package: eliza-ownership-fixture",
          "Version: 1.0.0",
          "Architecture: all",
          "Maintainer: elizaOS <hello@elizaos.ai>",
          "Description: ownership fixture",
          "",
        ].join("\n"),
        { mode: 0o644 },
      );
      writeFileSync(path.join(payloadDir, "payload"), "fixture\n", {
        mode: 0o644,
      });

      execFileSync(
        "/usr/bin/dpkg-deb",
        debArchiveBuildArgs(packageRoot, archive),
      );
      for (const archivePart of ["--ctrl-tarfile", "--fsys-tarfile"]) {
        const tar = execFileSync("/usr/bin/dpkg-deb", [archivePart, archive]);
        const listing = execFileSync("tar", ["--numeric-owner", "-tvf", "-"], {
          encoding: "utf8",
          input: tar,
        });
        for (const line of listing.trim().split("\n")) {
          expect(line).toMatch(/^[^ ]+ 0\/0 /);
        }
      }
    },
  );
});
