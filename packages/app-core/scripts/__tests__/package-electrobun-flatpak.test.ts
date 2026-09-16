/**
 * Flatpak packaging tests verify that the release bundle targets the real
 * Electrobun launcher and emits desktop metadata without host filesystem or
 * shell escape permissions.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertFlatpakArtifactDirectoryOutsideBuild,
  FLATPAK_BUNDLED_LIBRARIES,
  FLATPAK_FINISH_ARGS,
  FLATPAK_RUNTIME,
  hardenFlatpakStagingPermissions,
  requireLauncher,
  resolveFlatpakArtifactDirectory,
  resolveFlatpakRefs,
  withFlatpakStagingCleanup,
  writeMetadata,
} from "../package-electrobun-flatpak.mjs";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flatpak-package-test-"));
  tempDirs.push(dir);
  return dir;
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
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Electrobun Flatpak packaging", () => {
  it("uses the GNOME runtime that supplies WebKitGTK", () => {
    expect(FLATPAK_RUNTIME).toEqual({
      platform: "org.gnome.Platform",
      sdk: "org.gnome.Sdk",
      version: "49",
    });
    expect(FLATPAK_BUNDLED_LIBRARIES.map(({ soname }) => soname)).toEqual([
      "libayatana-appindicator3.so.1",
      "libayatana-indicator3.so.7",
      "libayatana-ido3-0.4.so.0",
      "libdbusmenu-glib.so.4",
      "libdbusmenu-gtk3.so.4",
    ]);
  });

  it("resolves full runtime and SDK refs without architecture drift", () => {
    expect(resolveFlatpakRefs({ arch: "x86_64" })).toEqual({
      runtimeRef: "org.gnome.Platform/x86_64/49",
      sdkRef: "org.gnome.Sdk/x86_64/49",
    });
    expect(
      resolveFlatpakRefs({
        arch: "x86_64",
        runtimeRef: "org.gnome.Platform/x86_64/50",
        sdkRef: "org.freedesktop.Sdk/x86_64/25.08",
      }),
    ).toEqual({
      runtimeRef: "org.gnome.Platform/x86_64/50",
      sdkRef: "org.freedesktop.Sdk/x86_64/25.08",
    });
    expect(() =>
      resolveFlatpakRefs({
        arch: "x86_64",
        runtimeRef: "org.gnome.Platform/aarch64/50",
      }),
    ).toThrow(/requested architecture/);
  });

  it("preserves the in-repository artifact directory by default", () => {
    const baseDirectory = tempDir();
    const defaultDirectory = path.join(baseDirectory, "artifacts");
    expect(
      resolveFlatpakArtifactDirectory(undefined, {
        baseDirectory,
        defaultDirectory,
        defaultCapacityDirectory: baseDirectory,
      }),
    ).toEqual({
      artifactDirectory: defaultDirectory,
      capacityDirectory: baseDirectory,
    });
  });

  it("resolves an external output and preflights its existing filesystem", () => {
    const baseDirectory = tempDir();
    const externalRoot = tempDir();
    const requested = path.join(externalRoot, "nested", "artifacts");

    expect(
      resolveFlatpakArtifactDirectory(requested, { baseDirectory }),
    ).toEqual({
      artifactDirectory: requested,
      capacityDirectory: externalRoot,
    });
  });

  it("rejects missing, root, file, and symlink artifact targets", () => {
    const baseDirectory = tempDir();
    const fileTarget = path.join(baseDirectory, "file");
    const realDirectory = tempDir();
    const linkTarget = path.join(baseDirectory, "link");
    writeFileSync(fileTarget, "not a directory");
    symlinkSync(realDirectory, linkTarget);

    expect(() =>
      resolveFlatpakArtifactDirectory("true", { baseDirectory }),
    ).toThrow(/requires a non-empty directory path/);
    expect(() =>
      resolveFlatpakArtifactDirectory(path.parse(baseDirectory).root, {
        baseDirectory,
      }),
    ).toThrow(/filesystem root/);
    expect(() =>
      resolveFlatpakArtifactDirectory(fileTarget, { baseDirectory }),
    ).toThrow(/not a directory/);
    expect(() =>
      resolveFlatpakArtifactDirectory(path.join(linkTarget, "nested"), {
        baseDirectory,
      }),
    ).toThrow(/must not traverse a symlink/);
  });

  it("rejects an artifact directory inside the copied build tree", () => {
    const buildDirectory = tempDir();
    expect(() =>
      assertFlatpakArtifactDirectoryOutsideBuild(
        path.join(buildDirectory, "artifacts"),
        buildDirectory,
      ),
    ).toThrow(/must not be inside the build tree/);
  });

  it("requires the packaged Electrobun launcher", () => {
    const buildDir = tempDir();
    mkdirSync(path.join(buildDir, "bin"), { recursive: true });
    const launcher = path.join(buildDir, "bin/launcher");
    writeFileSync(launcher, "#!/bin/sh\n");
    chmodSync(launcher, 0o755);

    expect(requireLauncher(buildDir)).toBe("bin/launcher");
  });

  it("rejects a CLI-only tree", () => {
    const buildDir = tempDir();
    mkdirSync(path.join(buildDir, "bin"), { recursive: true });
    writeFileSync(path.join(buildDir, "bin/elizaos"), "#!/bin/sh\n");

    expect(() => requireLauncher(buildDir)).toThrow(/bin\/launcher/);
  });

  it("emits graphical metadata with an export-safe icon", async () => {
    const filesDir = tempDir();
    await writeMetadata(filesDir, "bin/launcher");

    const wrapper = readFileSync(path.join(filesDir, "bin/eliza"), "utf8");
    const desktop = readFileSync(
      path.join(filesDir, "share/applications/ai.elizaos.app.desktop"),
      "utf8",
    );
    const metadata = readFileSync(
      path.join(filesDir, "share/metainfo/ai.elizaos.app.metainfo.xml"),
      "utf8",
    );
    const icon = await sharp(
      path.join(
        filesDir,
        "share/icons/hicolor/512x512/apps/ai.elizaos.app.png",
      ),
    ).metadata();

    expect(wrapper).toContain("/app/opt/eliza/bin/launcher");
    expect(desktop).toContain("Terminal=false");
    expect(desktop).toContain("Exec=eliza");
    expect(metadata).toContain('type="desktop-application"');
    expect(metadata).toContain(
      '<developer id="ai.elizaos"><name>elizaOS</name></developer>',
    );
    expect(metadata).toContain("https://github.com/elizaOS/eliza/issues");
    expect(icon.width).toBe(512);
    expect(icon.height).toBe(512);
  });

  it("quotes hostile launcher paths and closes permissive-umask stage modes", async () => {
    const appDir = path.join(tempDir(), "app");
    const filesDir = path.join(appDir, "files");
    const injectionMarker = path.join(tempDir(), "launcher-injection");
    const relativeLauncher = `nested dir/launcher's $(touch ${injectionMarker})`;
    const previousUmask = process.umask(0o002);
    try {
      mkdirSync(path.join(filesDir, "opt/eliza/bin"), { recursive: true });
      writeFileSync(path.join(appDir, "metadata"), "[Application]\n", {
        mode: 0o666,
      });
      writeFileSync(path.join(filesDir, "opt/eliza/bin/payload"), "payload", {
        mode: 0o666,
      });
      await writeMetadata(filesDir, relativeLauncher);

      const wrapper = path.join(filesDir, "bin/eliza");
      expect(readFileSync(wrapper, "utf8")).toBe(
        `#!/usr/bin/env sh\nexec '/app/opt/eliza/nested dir/launcher'"'"'s $(touch ${injectionMarker})' "$@"\n`,
      );
      const execution = spawnSync(wrapper, [], { encoding: "utf8" });
      expect(execution.status).not.toBe(0);
      expect(existsSync(injectionMarker)).toBe(false);

      expect(hardenFlatpakStagingPermissions(appDir)).toBeGreaterThan(0);
      expectHardenedTree(appDir);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("keeps the side-load bundle off host escape surfaces", () => {
    expect(FLATPAK_FINISH_ARGS).toContain("--socket=wayland");
    expect(FLATPAK_FINISH_ARGS).toContain("--socket=fallback-x11");
    expect(FLATPAK_FINISH_ARGS).not.toContain("--filesystem=home");
    expect(FLATPAK_FINISH_ARGS).not.toContain("--filesystem=host");
    expect(FLATPAK_FINISH_ARGS).not.toContain("--socket=session-bus");
    expect(FLATPAK_FINISH_ARGS).not.toContain("--socket=system-bus");
    expect(FLATPAK_FINISH_ARGS).not.toContain(
      "--talk-name=org.freedesktop.Flatpak",
    );
  });

  it("removes Flatpak staging after success and failure", async () => {
    const successRoot = path.join(tempDir(), "success-stage");
    await expect(
      withFlatpakStagingCleanup(successRoot, async () => {
        mkdirSync(successRoot);
        writeFileSync(path.join(successRoot, "payload"), "data");
        return "complete";
      }),
    ).resolves.toBe("complete");
    expect(existsSync(successRoot)).toBe(false);

    const failureRoot = path.join(tempDir(), "failure-stage");
    const failure = new Error("flatpak failed");
    await expect(
      withFlatpakStagingCleanup(failureRoot, async () => {
        mkdirSync(failureRoot);
        writeFileSync(path.join(failureRoot, "payload"), "data");
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(existsSync(failureRoot)).toBe(false);
  });
});
