/**
 * Flatpak packaging tests verify that the release bundle targets the real
 * Electrobun launcher and emits desktop metadata without host filesystem or
 * shell escape permissions.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  FLATPAK_FINISH_ARGS,
  FLATPAK_RUNTIME,
  requireLauncher,
  writeMetadata,
} from "../package-electrobun-flatpak.mjs";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flatpak-package-test-"));
  tempDirs.push(dir);
  return dir;
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
    expect(metadata).toContain("https://github.com/elizaOS/eliza/issues");
    expect(icon.width).toBe(512);
    expect(icon.height).toBe(512);
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
});
