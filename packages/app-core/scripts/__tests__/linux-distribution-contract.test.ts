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
  inspectPackagedGlibcCompatibility,
  LINUX_DISTRIBUTION_CLAIMS,
  parseGlibcRequirements,
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
const GLIBC_238_VERSION_INFO = `
Version needs section '.gnu.version_r' contains 1 entry:
  0x0010: Name: GLIBC_2.38  Flags: none  Version: 2
  0x0020: Name: GLIBC_2.2.5  Flags: none  Version: 3
`;
const GLIBC_AUDIT_OPTIONS = {
  readelfVersionInfo: () => GLIBC_238_VERSION_INFO,
};

function tempDir(): string {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "linux-distribution-contract-"),
  );
  tempDirs.push(directory);
  return directory;
}

function executable(filePath: string, contents: string | Buffer): void {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

function elfExecutable(filePath: string, contents = "binary"): void {
  executable(
    filePath,
    Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      Buffer.from(contents),
    ]),
  );
}

function cefBuild(): string {
  const buildDir = tempDir();
  mkdirSync(path.join(buildDir, "bin/cef"), { mode: 0o755, recursive: true });
  chmodSync(path.join(buildDir, "bin"), 0o755);
  chmodSync(path.join(buildDir, "bin/cef"), 0o755);
  elfExecutable(path.join(buildDir, "bin/launcher"), "launcher");
  elfExecutable(
    path.join(buildDir, "bin/libNativeWrapper.so"),
    "binary-disable-gpu-sandbox-binary-no-sandbox",
  );
  elfExecutable(path.join(buildDir, "bin/cef/libcef.so"), "cef");
  elfExecutable(path.join(buildDir, "bin/chrome-sandbox"), "helper");
  return buildDir;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Linux desktop distribution claims", () => {
  it("records the pinned CEF wrapper as renderer-unsandboxed", () => {
    const result = inspectLinuxDesktopBuild(cefBuild(), GLIBC_AUDIT_OPTIONS);
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
        glibcAuditOptions: GLIBC_AUDIT_OPTIONS,
      }),
    ).toThrow(/cannot claim production renderer sandboxing/);
  });

  it("accepts only the reviewed Flatpak outer-sandbox claim", () => {
    expect(() =>
      assertLinuxDistributionClaim({
        buildDir: cefBuild(),
        claim: LINUX_DISTRIBUTION_CLAIMS.FLATPAK_OUTER_SANDBOX,
        finishArgs: FINISH_ARGS,
        glibcAuditOptions: GLIBC_AUDIT_OPTIONS,
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
    expect(() =>
      inspectLinuxDesktopBuild(writableBuild, GLIBC_AUDIT_OPTIONS),
    ).toThrow(/group\/world-writable/);

    const escapingBuild = cefBuild();
    symlinkSync("/etc/passwd", path.join(escapingBuild, "escape"));
    expect(() =>
      inspectLinuxDesktopBuild(escapingBuild, GLIBC_AUDIT_OPTIONS),
    ).toThrow(/symlink escapes/);
  });

  it("requires known CEF unsafe markers until upstream source is re-audited", () => {
    const buildDir = cefBuild();
    elfExecutable(path.join(buildDir, "bin/libNativeWrapper.so"), "changed");
    expect(() =>
      inspectLinuxDesktopBuild(buildDir, GLIBC_AUDIT_OPTIONS),
    ).toThrow(/sandbox posture is unknown/);
  });
});

describe("packaged ELF GLIBC compatibility", () => {
  it("orders numeric requirements and rejects private ABI markers", () => {
    expect(
      parseGlibcRequirements(
        "Name: GLIBC_2.9 Name: GLIBC_2.38 Name: GLIBC_2.10 Name: GLIBC_PRIVATE",
      ),
    ).toEqual({
      maxVersion: "2.38",
      unsupportedMarkers: ["GLIBC_PRIVATE"],
      versions: ["2.9", "2.10", "2.38"],
    });
  });

  it("fails on a lazy inference ELF that raises the pinned wrapper floor", () => {
    const buildDir = cefBuild();
    const lazyDir = path.join(
      buildDir,
      "Resources/app/node_modules/@elizaos/plugin-local-inference/native",
    );
    mkdirSync(lazyDir, { recursive: true });
    const lazyLibrary = path.join(lazyDir, "libelizainference.so");
    elfExecutable(lazyLibrary, "lazy-inference");

    expect(() =>
      inspectPackagedGlibcCompatibility(buildDir, {
        readelfVersionInfo: (filePath: string) =>
          filePath.endsWith(
            path.join("native", "libelizainference.so"),
          )
            ? "Name: GLIBC_2.43"
            : GLIBC_238_VERSION_INFO,
      }),
    ).toThrow(/libelizainference\.so \(GLIBC_2\.43\)/);
  });

  it("audits extensionless ELF files instead of relying on filename filters", () => {
    const buildDir = cefBuild();
    const lazyExecutable = path.join(buildDir, "Resources", "lazy-worker");
    mkdirSync(path.dirname(lazyExecutable), { recursive: true });
    elfExecutable(lazyExecutable, "lazy-worker");

    const result = inspectPackagedGlibcCompatibility(buildDir, {
      readelfVersionInfo: () => GLIBC_238_VERSION_INFO,
    });
    expect(result.files.map(({ path: filePath }) => filePath)).toContain(
      "Resources/lazy-worker",
    );
    expect(result.maxAllowedVersion).toBe("2.38");
    expect(result.maxRequiredVersion).toBe("2.38");
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
