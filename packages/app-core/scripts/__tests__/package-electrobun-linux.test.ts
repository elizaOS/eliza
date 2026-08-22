/** Direct Linux package orchestration must be independently selectable and cleanup-safe. */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSelectedLinuxPackages,
  DIRECT_LINUX_PACKAGE_FORMATS,
  debArchiveBuildArgs,
  findElectrobunLauncher,
  renderLinuxLauncherWrapper,
  resolveLinuxPackageFormats,
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
    expect(readFileSync(appRun, "utf8")).toBe(
      [
        "#!/usr/bin/env sh",
        'HERE="$(dirname "$(readlink -f "$0")")"',
        `exec "$HERE"/'opt/eliza/bin/launcher' "$@"`,
        "",
      ].join("\n"),
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
