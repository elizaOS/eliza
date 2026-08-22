/**
 * Linux distribution contract tests use real filesystem modes, symlinks, and
 * finalized Flatpak metadata around a deterministic miniature Electrobun tree.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertFinalizedFlatpakMetadata,
  assertFlatpakFinishArgs,
  assertLinuxDistributionClaim,
  inspectLinuxDesktopBuild,
  LINUX_DISTRIBUTION_CLAIMS,
  requiredFlatpakFreeBytes,
} from "../linux-distribution-contract.mjs";

const tempDirs: string[] = [];
const FINISH_ARGS = [
  "--command=eliza",
  "--share=network",
  "--share=ipc",
  "--socket=wayland",
  "--socket=fallback-x11",
  "--socket=pulseaudio",
  "--device=dri",
];

function tempDir(): string {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "linux-distribution-contract-"),
  );
  tempDirs.push(directory);
  return directory;
}

function executable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

function cefBuild(): string {
  const buildDir = tempDir();
  mkdirSync(path.join(buildDir, "bin/cef"), { mode: 0o755, recursive: true });
  chmodSync(path.join(buildDir, "bin"), 0o755);
  chmodSync(path.join(buildDir, "bin/cef"), 0o755);
  executable(path.join(buildDir, "bin/launcher"), "launcher");
  executable(
    path.join(buildDir, "bin/libNativeWrapper.so"),
    "binary-disable-gpu-sandbox-binary-no-sandbox",
  );
  executable(path.join(buildDir, "bin/cef/libcef.so"), "cef");
  executable(path.join(buildDir, "bin/chrome-sandbox"), "helper");
  return buildDir;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Linux desktop distribution claims", () => {
  it("records the pinned CEF wrapper as renderer-unsandboxed", () => {
    const result = inspectLinuxDesktopBuild(cefBuild());
    expect(result.hasCef).toBe(true);
    expect(result.rendererProcessSandboxed).toBe(false);
    expect(result.unsafeCefSwitches).toEqual([
      "disable-gpu-sandbox",
      "no-sandbox",
    ]);
    expect(result.chromeSandbox?.mode).toBe(0o755);
    expect(result.chromeSandbox?.setuidRootCapable).toBe(false);
  });

  it("fails closed on a direct production-renderer-sandbox claim", () => {
    expect(() =>
      assertLinuxDistributionClaim({
        buildDir: cefBuild(),
        claim: LINUX_DISTRIBUTION_CLAIMS.PRODUCTION_RENDERER_SANDBOXED,
      }),
    ).toThrow(/cannot claim production renderer sandboxing/);
  });

  it("accepts only the reviewed Flatpak outer-sandbox claim", () => {
    expect(() =>
      assertLinuxDistributionClaim({
        buildDir: cefBuild(),
        claim: LINUX_DISTRIBUTION_CLAIMS.FLATPAK_OUTER_SANDBOX,
        finishArgs: FINISH_ARGS,
      }),
    ).not.toThrow();
    expect(() =>
      assertFlatpakFinishArgs([...FINISH_ARGS, "--filesystem=home"]),
    ).toThrow(/unreviewed Flatpak permission/);
    expect(() =>
      assertFlatpakFinishArgs(
        FINISH_ARGS.filter((arg) => arg !== "--socket=pulseaudio"),
      ),
    ).toThrow(/sockets must equal/);
  });

  it("rejects unsafe artifact modes and escaping symlinks", () => {
    const writableBuild = cefBuild();
    chmodSync(path.join(writableBuild, "bin/libNativeWrapper.so"), 0o777);
    expect(() => inspectLinuxDesktopBuild(writableBuild)).toThrow(
      /group\/world-writable/,
    );

    const escapingBuild = cefBuild();
    symlinkSync("/etc/passwd", path.join(escapingBuild, "escape"));
    expect(() => inspectLinuxDesktopBuild(escapingBuild)).toThrow(
      /symlink escapes/,
    );
  });

  it("requires known CEF unsafe markers until upstream source is re-audited", () => {
    const buildDir = cefBuild();
    executable(path.join(buildDir, "bin/libNativeWrapper.so"), "changed");
    expect(() => inspectLinuxDesktopBuild(buildDir)).toThrow(
      /sandbox posture is unknown/,
    );
  });
});

describe("finalized Flatpak metadata", () => {
  it("accepts the exact runtime, SDK, command, and permission sets", () => {
    const metadata = path.join(tempDir(), "metadata");
    writeFileSync(
      metadata,
      [
        "[Application]",
        "name=ai.elizaos.app",
        "runtime=org.gnome.Platform/x86_64/50",
        "sdk=org.freedesktop.Sdk/x86_64/25.08",
        "command=eliza",
        "",
        "[Context]",
        "shared=ipc;network;",
        "sockets=fallback-x11;pulseaudio;wayland;",
        "devices=dri;",
        "",
      ].join("\n"),
    );
    expect(() =>
      assertFinalizedFlatpakMetadata(metadata, {
        runtimeRef: "org.gnome.Platform/x86_64/50",
        sdkRef: "org.freedesktop.Sdk/x86_64/25.08",
      }),
    ).not.toThrow();
  });

  it("rejects finalized filesystem and D-Bus grants", () => {
    const metadata = path.join(tempDir(), "metadata");
    writeFileSync(
      metadata,
      [
        "[Application]",
        "name=ai.elizaos.app",
        "runtime=org.gnome.Platform/x86_64/50",
        "sdk=org.freedesktop.Sdk/x86_64/25.08",
        "command=eliza",
        "[Context]",
        "shared=ipc;network;",
        "sockets=fallback-x11;pulseaudio;wayland;",
        "devices=dri;",
        "filesystems=home;",
      ].join("\n"),
    );
    expect(() =>
      assertFinalizedFlatpakMetadata(metadata, {
        runtimeRef: "org.gnome.Platform/x86_64/50",
        sdkRef: "org.freedesktop.Sdk/x86_64/25.08",
      }),
    ).toThrow(/unreviewed context keys/);
  });
});

describe("Flatpak disk reserve", () => {
  it("reserves three independent copies plus one GiB", () => {
    expect(requiredFlatpakFreeBytes(2n * 1024n ** 3n)).toBe(7n * 1024n ** 3n);
  });
});
