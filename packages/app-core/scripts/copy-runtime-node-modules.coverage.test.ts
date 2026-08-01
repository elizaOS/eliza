/**
 * Exercises runtime-copy decisions against real temporary manifests and filesystem trees.
 * Explicit platform inputs keep native-variant assertions deterministic across CI runners.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertRequiredBundledPackagesLanded,
  assertTarSafeRuntimePaths,
  copyPackageDir,
  expandWorkspacePattern,
  getRuntimeDependencies,
  getRuntimeDependencyEntries,
  getWorkspacePackageRuntimeCopyEntries,
  inferVersionFromBunEntryPath,
  isExactVersionSpecifier,
  isPackageCompatibleWithCurrentPlatform,
  lockfileResolutionError,
  matchesRuntimeVariant,
  normalizeResolvedPackage,
  parseArgs,
  parseRegistryVersionConstraint,
  patchCopiedElevenLabsTarSafePaths,
  readWorkspacePatterns,
  recursiveRemoveErrorDetail,
  selectCopyTargetNodeModules,
  selectResolvedCandidate,
  shouldCopyPackageEntry,
  shouldCopyWorkspacePublishEntry,
  shouldKeepPackageRelativePath,
  shouldSkipPackagedAppCoreEntry,
  shouldSkipPackagedDependency,
  visitFiles,
} from "./copy-runtime-node-modules";

let tmpDir: string;
const workspaceFixtureDirs: string[] = [];

function writeManifest(
  name: string,
  manifest: Record<string, unknown> = {},
): string {
  const dir = mkdtempSync(path.join(tmpDir, "pkg-"));
  const manifestPath = path.join(dir, "package.json");
  writeFileSync(manifestPath, JSON.stringify({ name, ...manifest }, null, 2));
  return manifestPath;
}

function writeWorkspaceManifest(
  name: string,
  manifest: Record<string, unknown> = {},
): string {
  const dir = mkdtempSync(
    path.join(process.cwd(), ".runtime-copy-workspace-cov-"),
  );
  workspaceFixtureDirs.push(dir);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, ...manifest }, null, 2),
  );
  return dir;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "copy-runtime-cov-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  for (const dir of workspaceFixtureDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("matchesRuntimeVariant", () => {
  it("keeps variants with no os/libc/arch constraints", () => {
    // A token that maps to nothing => unconstrained => always kept.
    expect(matchesRuntimeVariant("generic", "darwin", "arm64")).toBe(true);
  });

  it("matches an os+arch variant for the matching target", () => {
    expect(matchesRuntimeVariant("darwin-arm64", "darwin", "arm64")).toBe(true);
  });

  it("rejects an os variant when the target os differs", () => {
    expect(matchesRuntimeVariant("darwin-arm64", "win32", "arm64")).toBe(false);
  });

  it("rejects an arch variant when the target arch differs", () => {
    expect(matchesRuntimeVariant("linux-x64", "linux", "arm64")).toBe(false);
  });

  it("normalizes x86_64 variants to x64", () => {
    expect(matchesRuntimeVariant("linux-x86_64", "linux", "x64")).toBe(true);
    expect(matchesRuntimeVariant("linux-x86_64", "linux", "arm64")).toBe(false);
  });

  it("treats a universal-arch variant as arch-agnostic", () => {
    // 'universal' arch constraint must not gate on the concrete target arch.
    expect(matchesRuntimeVariant("darwin-universal", "darwin", "arm64")).toBe(
      true,
    );
    expect(matchesRuntimeVariant("darwin-universal", "darwin", "x64")).toBe(
      true,
    );
  });

  it("gates a linux-glibc variant off for a non-linux target", () => {
    // libc constraints only apply on linux; a glibc variant on darwin cannot
    // match because the libc check requires the target os to be linux.
    expect(matchesRuntimeVariant("linux-glibc-x64", "darwin", "x64")).toBe(
      false,
    );
  });

  it("gates libc-tagged variants against an explicit target libc", () => {
    expect(
      matchesRuntimeVariant("linux-x64-musl", "linux", "x64", "glibc"),
    ).toBe(false);
    expect(
      matchesRuntimeVariant("linux-x64-musl", "linux", "x64", "musl"),
    ).toBe(true);
    expect(
      matchesRuntimeVariant("linux-x64-glibc", "linux", "x64", "musl"),
    ).toBe(false);
  });
});

describe("shouldKeepPackageRelativePath", () => {
  it("keeps the package root and empty relative paths", () => {
    expect(shouldKeepPackageRelativePath("", "linux", "x64")).toBe(true);
    expect(shouldKeepPackageRelativePath(".", "linux", "x64")).toBe(true);
  });

  it("drops llama runtime + templates dirs for node-llama-cpp", () => {
    expect(
      shouldKeepPackageRelativePath(
        "llama/model.bin",
        "linux",
        "x64",
        "node-llama-cpp",
      ),
    ).toBe(false);
    expect(
      shouldKeepPackageRelativePath(
        "templates/foo",
        "linux",
        "x64",
        "node-llama-cpp",
      ),
    ).toBe(false);
  });

  it("drops build/report scratch dirs for @elizaos/app-core", () => {
    expect(
      shouldKeepPackageRelativePath(
        ".tmp/x",
        "linux",
        "x64",
        "@elizaos/app-core",
      ),
    ).toBe(false);
    expect(
      shouldKeepPackageRelativePath(
        "action-benchmark-report/r.json",
        "linux",
        "x64",
        "@elizaos/app-core",
      ),
    ).toBe(false);
  });

  it("drops native android/ios build output for any package", () => {
    expect(
      shouldKeepPackageRelativePath("android/build/out.apk", "linux", "x64"),
    ).toBe(false);
    expect(
      shouldKeepPackageRelativePath("ios/App/build/App", "linux", "x64"),
    ).toBe(false);
  });

  it("gates prebuild dirs on the platform variant", () => {
    expect(
      shouldKeepPackageRelativePath(
        "prebuilds/linux-x64/x.node",
        "linux",
        "x64",
      ),
    ).toBe(true);
    expect(
      shouldKeepPackageRelativePath(
        "prebuilds/darwin-arm64/x.node",
        "linux",
        "x64",
      ),
    ).toBe(false);
  });

  it("gates napi-vN bin dirs on the platform variant", () => {
    expect(
      shouldKeepPackageRelativePath(
        "bin/napi-v6/linux/x64/x.node",
        "linux",
        "x64",
      ),
    ).toBe(true);
    expect(
      shouldKeepPackageRelativePath(
        "bin/napi-v6/darwin/arm64/x.node",
        "linux",
        "x64",
      ),
    ).toBe(false);
  });

  it("gates koffi build variants on the platform", () => {
    expect(
      shouldKeepPackageRelativePath(
        "build/koffi/linux_x64/koffi.node",
        "linux",
        "x64",
      ),
    ).toBe(true);
    expect(
      shouldKeepPackageRelativePath(
        "build/koffi/darwin_arm64/koffi.node",
        "linux",
        "x64",
      ),
    ).toBe(false);
    expect(
      shouldKeepPackageRelativePath(
        "build/koffi/linux_loong64/koffi.node",
        "linux",
        "arm64",
      ),
    ).toBe(false);
    expect(
      shouldKeepPackageRelativePath(
        "build/koffi/linux_riscv64d/koffi.node",
        "linux",
        "arm64",
      ),
    ).toBe(false);
    expect(
      shouldKeepPackageRelativePath(
        "build/koffi/linux_armhf/koffi.node",
        "linux",
        "arm64",
      ),
    ).toBe(false);
  });

  it("gates fb-dotslash embedded executables on the platform", () => {
    expect(
      shouldKeepPackageRelativePath(
        "bin/linux-musl.aarch64/dotslash",
        "linux",
        "arm64",
        "fb-dotslash",
      ),
    ).toBe(true);
    expect(
      shouldKeepPackageRelativePath(
        "bin/linux-musl.x86_64/dotslash",
        "linux",
        "x64",
        "fb-dotslash",
      ),
    ).toBe(true);
    expect(
      shouldKeepPackageRelativePath(
        "bin/linux-musl.x86_64/dotslash",
        "linux",
        "arm64",
        "fb-dotslash",
      ),
    ).toBe(false);
    expect(
      shouldKeepPackageRelativePath(
        "bin/macos/dotslash",
        "linux",
        "arm64",
        "fb-dotslash",
      ),
    ).toBe(false);
  });

  it("gates hermes compiler executables on the platform", () => {
    expect(
      shouldKeepPackageRelativePath(
        "hermesc/linux64-bin/hermesc",
        "linux",
        "x64",
        "hermes-compiler",
      ),
    ).toBe(true);
    expect(
      shouldKeepPackageRelativePath(
        "hermesc/linux64-bin/hermesc",
        "linux",
        "arm64",
        "hermes-compiler",
      ),
    ).toBe(false);
    expect(
      shouldKeepPackageRelativePath(
        "hermesc/osx-bin/hermesc",
        "darwin",
        "arm64",
        "hermes-compiler",
      ),
    ).toBe(true);
  });

  it("gates ffprobe-static bin variants on the platform", () => {
    expect(
      shouldKeepPackageRelativePath(
        "bin/linux/x64/ffprobe",
        "linux",
        "x64",
        "ffprobe-static",
      ),
    ).toBe(true);
    expect(
      shouldKeepPackageRelativePath(
        "bin/darwin/arm64/ffprobe",
        "linux",
        "x64",
        "ffprobe-static",
      ),
    ).toBe(false);
  });

  it("drops dist-mobile output for @elizaos/agent", () => {
    expect(
      shouldKeepPackageRelativePath(
        "dist-mobile/bundle.js",
        "linux",
        "x64",
        "@elizaos/agent",
      ),
    ).toBe(false);
  });

  it("keeps unconstrained 'bins' variant dirs", () => {
    // A bins/<variant> whose variant maps to no os/libc/arch is unconstrained.
    expect(
      shouldKeepPackageRelativePath("bins/generic/tool", "linux", "x64"),
    ).toBe(true);
  });

  it("keeps ordinary source paths untouched", () => {
    expect(
      shouldKeepPackageRelativePath(
        "dist/index.js",
        "linux",
        "x64",
        "some-pkg",
      ),
    ).toBe(true);
  });

  it("filters libc-tagged prebuilds against the target libc (deb glibc shape)", () => {
    // The dh_shlibdeps failure shape: musl-ABI prebuilds shipped into the
    // glibc .deb (utf-8-validate.musl.node, usb node.napi.musl.node).
    expect(
      shouldKeepPackageRelativePath(
        "prebuilds/linux-x64/utf-8-validate.musl.node",
        "linux",
        "x64",
        "utf-8-validate",
        "glibc",
      ),
    ).toBe(false);
    expect(
      shouldKeepPackageRelativePath(
        "prebuilds/linux-x64/node.napi.musl.node",
        "linux",
        "x64",
        "usb",
        "glibc",
      ),
    ).toBe(false);
    // The untagged prebuild is the glibc default and must survive.
    expect(
      shouldKeepPackageRelativePath(
        "prebuilds/linux-x64/utf-8-validate.node",
        "linux",
        "x64",
        "utf-8-validate",
        "glibc",
      ),
    ).toBe(true);
  });

  it("filters glibc-tagged prebuilds off a musl target (vice-versa)", () => {
    expect(
      shouldKeepPackageRelativePath(
        "node.glibc.node",
        "linux",
        "x64",
        "@msgpackr-extract/msgpackr-extract-linux-x64",
        "musl",
      ),
    ).toBe(false);
    expect(
      shouldKeepPackageRelativePath(
        "node.musl.node",
        "linux",
        "x64",
        "@msgpackr-extract/msgpackr-extract-linux-x64",
        "musl",
      ),
    ).toBe(true);
  });

  it("drops libc-tagged prebuilds entirely for non-linux targets", () => {
    expect(
      shouldKeepPackageRelativePath(
        "prebuilds/some-dir/utf-8-validate.musl.node",
        "darwin",
        "arm64",
        "utf-8-validate",
      ),
    ).toBe(false);
  });
});

describe("shouldCopyPackageEntry", () => {
  it("drops nested node_modules and pruned dir names", () => {
    const root = mkdtempSync(path.join(tmpDir, "copy-entry-"));
    expect(
      shouldCopyPackageEntry(path.join(root, "node_modules"), "pkg", root),
    ).toBe(false);
    expect(shouldCopyPackageEntry(path.join(root, ".git"), "pkg", root)).toBe(
      false,
    );
  });

  it("drops pruned file extensions and TypeScript declaration files", () => {
    const root = mkdtempSync(path.join(tmpDir, "copy-entry-"));
    expect(
      shouldCopyPackageEntry(path.join(root, "readme.md"), "pkg", root),
    ).toBe(false);
    expect(
      shouldCopyPackageEntry(path.join(root, "index.d.ts"), "pkg", root),
    ).toBe(false);
    expect(
      shouldCopyPackageEntry(path.join(root, "index.d.ts.map"), "pkg", root),
    ).toBe(false);
  });

  it("returns false for an entry that cannot be stat'd", () => {
    const root = mkdtempSync(path.join(tmpDir, "copy-entry-"));
    expect(
      shouldCopyPackageEntry(path.join(root, "ghost.js"), "pkg", root),
    ).toBe(false);
  });

  it("keeps a real (non-symlink) runtime file", () => {
    const root = mkdtempSync(path.join(tmpDir, "copy-entry-"));
    const file = path.join(root, "index.js");
    writeFileSync(file, "");
    expect(shouldCopyPackageEntry(file, "pkg", root)).toBe(true);
  });
});

describe("readWorkspacePatterns", () => {
  it("reads the array 'workspaces' form", () => {
    const root = mkdtempSync(path.join(tmpDir, "ws-manifest-"));
    const manifest = path.join(root, "package.json");
    writeFileSync(
      manifest,
      JSON.stringify({ workspaces: ["packages/*", "apps/*"] }),
    );
    expect(readWorkspacePatterns(manifest)).toEqual(["packages/*", "apps/*"]);
  });

  it("reads the object 'workspaces.packages' form", () => {
    const root = mkdtempSync(path.join(tmpDir, "ws-manifest-"));
    const manifest = path.join(root, "package.json");
    writeFileSync(
      manifest,
      JSON.stringify({ workspaces: { packages: ["libs/*"] } }),
    );
    expect(readWorkspacePatterns(manifest)).toEqual(["libs/*"]);
  });

  it("returns [] for a manifest with no workspaces field", () => {
    const root = mkdtempSync(path.join(tmpDir, "ws-manifest-"));
    const manifest = path.join(root, "package.json");
    writeFileSync(manifest, JSON.stringify({ name: "solo" }));
    expect(readWorkspacePatterns(manifest)).toEqual([]);
  });

  it("returns [] for an unreadable/missing manifest", () => {
    expect(
      readWorkspacePatterns(path.join(tmpDir, "nope", "package.json")),
    ).toEqual([]);
  });
});

describe("inferVersionFromBunEntryPath", () => {
  it("extracts the version from a .bun store path", () => {
    expect(
      inferVersionFromBunEntryPath(
        "/repo/node_modules/.bun/react@18.3.1/node_modules/react",
      ),
    ).toBe("18.3.1");
  });

  it("strips the peer-hash suffix after '+'", () => {
    expect(
      inferVersionFromBunEntryPath(
        "/repo/node_modules/.bun/@scope+pkg@1.2.3+abc123/node_modules/@scope/pkg",
      ),
    ).toBe("1.2.3");
  });

  it("returns null when there is no .bun marker", () => {
    expect(inferVersionFromBunEntryPath("/repo/node_modules/react")).toBeNull();
  });

  it("returns null when the entry has no '@version' segment", () => {
    expect(
      inferVersionFromBunEntryPath("/repo/node_modules/.bun/loose/x"),
    ).toBeNull();
  });
});

describe("isExactVersionSpecifier", () => {
  it("accepts a plain semver", () => {
    expect(isExactVersionSpecifier("1.2.3")).toBe(true);
  });

  it("accepts semver with prerelease/build metadata", () => {
    expect(isExactVersionSpecifier("1.2.3-rc.1")).toBe(true);
    expect(isExactVersionSpecifier("1.2.3+build.5")).toBe(true);
  });

  it("normalizes npm's legacy numeric-whitespace range without widening it", () => {
    expect(parseRegistryVersionConstraint(">=0.5 0")).toEqual({
      kind: "range",
      range: ">=0.5.0",
    });
    expect(parseRegistryVersionConstraint(">=1 <2")).toEqual({
      kind: "range",
      range: ">=1 <2",
    });
  });

  it("rejects ranges, tags, and empty specs", () => {
    expect(isExactVersionSpecifier("^1.2.3")).toBe(false);
    expect(isExactVersionSpecifier("latest")).toBe(false);
    expect(isExactVersionSpecifier("workspace:*")).toBe(false);
    expect(isExactVersionSpecifier(null)).toBe(false);
    expect(isExactVersionSpecifier(undefined)).toBe(false);
    expect(isExactVersionSpecifier("")).toBe(false);
  });
});

describe("isPackageCompatibleWithCurrentPlatform", () => {
  it("treats an unreadable/missing manifest as compatible (fail-open)", () => {
    expect(
      isPackageCompatibleWithCurrentPlatform(
        path.join(tmpDir, "does-not-exist", "package.json"),
      ),
    ).toBe(true);
  });

  it("treats a manifest with no platform selectors as compatible", () => {
    const manifestPath = writeManifest("plain-pkg");
    expect(isPackageCompatibleWithCurrentPlatform(manifestPath)).toBe(true);
  });

  it("rejects a package whose os selector excludes the current platform", () => {
    // A single 'os' selector that is neither the current platform (matched by
    // allow-list) forces incompatibility on this host.
    const otherOS = process.platform === "linux" ? "darwin" : "linux";
    const manifestPath = writeManifest("os-locked", { os: [otherOS] });
    expect(isPackageCompatibleWithCurrentPlatform(manifestPath)).toBe(false);
  });

  it("accepts a package whose os selector includes the current platform", () => {
    const manifestPath = writeManifest("os-allowed", {
      os: [process.platform],
    });
    expect(isPackageCompatibleWithCurrentPlatform(manifestPath)).toBe(true);
  });

  it("rejects when the current platform is explicitly blocked", () => {
    const manifestPath = writeManifest("os-blocked", {
      os: [`!${process.platform}`],
    });
    expect(isPackageCompatibleWithCurrentPlatform(manifestPath)).toBe(false);
  });
});

describe("getRuntimeDependencyEntries", () => {
  it("merges deps + optionalDeps + non-optional peerDeps, sorted, DEP_SKIP filtered", () => {
    // This mirrors the exact walk that dragged the smithers optional AWS
    // clients into the desktop bundle: optionalDependencies ARE included.
    const manifestPath = writeManifest("walker", {
      dependencies: { beta: "1.0.0", typescript: "5.0.0" },
      optionalDependencies: { alpha: "2.0.0", beta: "9.9.9" },
      peerDependencies: { gamma: "3.0.0", delta: "4.0.0" },
      peerDependenciesMeta: { delta: { optional: true } },
    });

    const entries = getRuntimeDependencyEntries(manifestPath);
    const names = entries.map((e) => e.name);

    // typescript is in DEP_SKIP => dropped.
    expect(names).not.toContain("typescript");
    // delta is an optional peer => dropped.
    expect(names).not.toContain("delta");
    // alpha (optional), beta (dep wins over optional), gamma (required peer).
    expect(names).toEqual(["alpha", "beta", "gamma"]);
    // first-writer wins: beta keeps its dependencies spec, not the optional one.
    expect(entries.find((e) => e.name === "beta")?.spec).toBe("1.0.0");
    // Edge kinds drive version enforcement: only "dependency" edges fail the
    // build on a version mismatch.
    expect(entries.find((e) => e.name === "beta")?.kind).toBe("dependency");
    expect(entries.find((e) => e.name === "alpha")?.kind).toBe("optional");
    expect(entries.find((e) => e.name === "gamma")?.kind).toBe("peer");
  });

  it("returns [] for a manifest with no dependency fields", () => {
    const manifestPath = writeManifest("empty-deps");
    expect(getRuntimeDependencyEntries(manifestPath)).toEqual([]);
  });

  it("getRuntimeDependencies projects entries down to names", () => {
    const manifestPath = writeManifest("names-only", {
      dependencies: { zeta: "1.0.0", alpha: "2.0.0" },
    });
    expect(getRuntimeDependencies(manifestPath)).toEqual(["alpha", "zeta"]);
  });
});

describe("normalizeResolvedPackage", () => {
  it("resolves a real dir with a package.json to a ResolvedPackage", () => {
    const dir = mkdtempSync(path.join(tmpDir, "resolved-"));
    const manifestPath = path.join(dir, "package.json");
    writeFileSync(manifestPath, JSON.stringify({ name: "resolved-pkg" }));

    const resolved = normalizeResolvedPackage(dir);
    expect(resolved).not.toBeNull();
    expect(resolved?.packageJsonPath).toBe(
      path.join(realpathSync.native(dir), "package.json"),
    );
  });

  it("returns null for a directory with no manifest and no tracked workspace match", () => {
    const dir = mkdtempSync(path.join(tmpDir, "no-manifest-"));
    expect(normalizeResolvedPackage(dir)).toBeNull();
  });
});

describe("parseRegistryVersionConstraint", () => {
  it("classifies exact versions, ranges, and unconstrained specs", () => {
    expect(parseRegistryVersionConstraint("1.2.3")).toEqual({
      kind: "exact",
      version: "1.2.3",
    });
    expect(parseRegistryVersionConstraint("^1.9.0")).toEqual({
      kind: "range",
      range: "^1.9.0",
    });
    expect(parseRegistryVersionConstraint(">=2 <3")).toEqual({
      kind: "range",
      range: ">=2 <3",
    });
    expect(parseRegistryVersionConstraint(null)).toEqual({
      kind: "unconstrained",
    });
    expect(parseRegistryVersionConstraint("latest")).toEqual({
      kind: "unconstrained",
    });
    expect(parseRegistryVersionConstraint("workspace:*")).toEqual({
      kind: "unconstrained",
    });
    expect(parseRegistryVersionConstraint("github:foo/bar")).toEqual({
      kind: "unconstrained",
    });
  });

  it("unwraps npm: aliases to their version constraint", () => {
    expect(parseRegistryVersionConstraint("npm:@noble/curves@^1.9.0")).toEqual({
      kind: "range",
      range: "^1.9.0",
    });
    expect(parseRegistryVersionConstraint("npm:foo@2.0.1")).toEqual({
      kind: "exact",
      version: "2.0.1",
    });
    expect(parseRegistryVersionConstraint("npm:foo")).toEqual({
      kind: "unconstrained",
    });
  });
});

describe("selectResolvedCandidate", () => {
  function candidate(name: string, version: string) {
    const dir = mkdtempSync(path.join(tmpDir, "cand-"));
    const manifestPath = path.join(dir, "package.json");
    writeFileSync(manifestPath, JSON.stringify({ name, version }));
    return { sourceDir: dir, packageJsonPath: manifestPath };
  }

  it("reports none when there are no candidates", () => {
    expect(selectResolvedCandidate([], "1.0.0")).toEqual({ kind: "none" });
  });

  it("returns the first candidate for an unconstrained spec", () => {
    const a = candidate("pkg", "1.0.0");
    const b = candidate("pkg", "2.0.0");
    expect(selectResolvedCandidate([a, b], null)).toEqual({
      kind: "selected",
      candidate: a,
    });
    expect(selectResolvedCandidate([a, b], "latest")).toEqual({
      kind: "selected",
      candidate: a,
    });
  });

  it("picks the exact version match when the spec is exact", () => {
    const a = candidate("pkg", "1.0.0");
    const b = candidate("pkg", "2.0.0");
    expect(selectResolvedCandidate([a, b], "2.0.0")).toEqual({
      kind: "selected",
      candidate: b,
    });
  });

  it("reports a mismatch instead of substituting when no exact match exists", () => {
    const a = candidate("pkg", "1.0.0");
    const b = candidate("pkg", "2.0.0");
    expect(selectResolvedCandidate([a, b], "9.9.9")).toEqual({
      kind: "mismatch",
      availableVersions: ["1.0.0", "2.0.0"],
    });
  });

  it("selects the range-satisfying version, not the first candidate (@noble/curves shape)", () => {
    // The Snap-breaking shape: the store holds @noble/curves at 2.x (first in
    // candidate order) and 1.x. An importer pinned to ^1.9.0 must get the 1.x
    // copy — packaging 2.x makes @noble/curves/secp256k1.js throw
    // ERR_PACKAGE_PATH_NOT_EXPORTED at app start.
    const v2 = candidate("@noble/curves", "2.0.1");
    const v1 = candidate("@noble/curves", "1.9.7");
    expect(selectResolvedCandidate([v2, v1], "^1.9.0")).toEqual({
      kind: "selected",
      candidate: v1,
    });
  });

  it("reports a mismatch when only an incompatible version is installed", () => {
    const v2 = candidate("@noble/curves", "2.0.1");
    expect(selectResolvedCandidate([v2], "^1.9.0")).toEqual({
      kind: "mismatch",
      availableVersions: ["2.0.1"],
    });
  });

  it("selects the installed answer for an npm legacy numeric-whitespace range", () => {
    const incompatible = candidate("mkdirp", "0.4.2");
    const compatible = candidate("mkdirp", "1.0.4");
    expect(
      selectResolvedCandidate([incompatible, compatible], ">=0.5 0"),
    ).toEqual({ kind: "selected", candidate: compatible });
    expect(selectResolvedCandidate([incompatible], ">=0.5 0")).toEqual({
      kind: "mismatch",
      availableVersions: ["0.4.2"],
    });
  });

  it("satisfies ranges against prerelease workspace-style versions", () => {
    const beta = candidate("@elizaos/core", "1.6.2-beta.3");
    expect(selectResolvedCandidate([beta], "^1.6.0")).toEqual({
      kind: "selected",
      candidate: beta,
    });
  });

  it("skips versionless manifests when matching a constraint", () => {
    const dir = mkdtempSync(path.join(tmpDir, "cand-"));
    const manifestPath = path.join(dir, "package.json");
    writeFileSync(manifestPath, JSON.stringify({ name: "pkg" }));
    const versionless = { sourceDir: dir, packageJsonPath: manifestPath };
    const good = candidate("pkg", "1.9.7");
    expect(selectResolvedCandidate([versionless, good], "^1.9.0")).toEqual({
      kind: "selected",
      candidate: good,
    });
  });
});

describe("lockfileResolutionError", () => {
  it("names the importer, the specifier, and the versions that were found", () => {
    const error = lockfileResolutionError(
      {
        name: "@noble/curves",
        spec: "^1.9.0",
        kind: "dependency",
        requesterName: "@scure/bip32",
        requesterDir: "/repo/node_modules/@scure/bip32",
      },
      ["2.0.1"],
    );
    expect(error.message).toContain("@scure/bip32");
    expect(error.message).toContain("@noble/curves@^1.9.0");
    expect(error.message).toContain("2.0.1");
    expect(error.message).toContain("Refusing to substitute");
  });
});

describe("parseArgs", () => {
  it("defaults target-dist to the scan-dir when only scan-dir is given", () => {
    const opts = parseArgs(["--scan-dir", "build/out"]);
    expect(opts.scanDir.endsWith(path.join("build", "out"))).toBe(true);
    // target-dist defaults to scan-dir.
    expect(opts.targetDist).toBe(opts.scanDir);
  });

  it("parses inline --key=value form and independent target-dist", () => {
    const opts = parseArgs(["--scan-dir=a/b", "--target-dist=c/d"]);
    expect(opts.scanDir.endsWith(path.join("a", "b"))).toBe(true);
    expect(opts.targetDist.endsWith(path.join("c", "d"))).toBe(true);
  });

  it("ignores stray non-flag tokens and flags without a value", () => {
    // Trailing flag with no value + a bare positional are both ignored; the
    // scan-dir falls back to the 'dist' default.
    const opts = parseArgs(["positional", "--scan-dir"]);
    expect(opts.scanDir.endsWith("dist")).toBe(true);
  });
});

describe("recursiveRemoveErrorDetail", () => {
  it("prefers concatenated stdout/stderr detail", () => {
    const detail = recursiveRemoveErrorDetail({
      message: "boom",
      stdout: "out-line",
      stderr: Buffer.from("err-line"),
    });
    expect(detail).toContain("out-line");
    expect(detail).toContain("err-line");
  });

  it("falls back to message when there is no stream detail", () => {
    expect(recursiveRemoveErrorDetail({ message: "just-a-message" })).toBe(
      "just-a-message",
    );
  });

  it("stringifies a non-object error", () => {
    expect(recursiveRemoveErrorDetail("raw-string-error")).toBe(
      "raw-string-error",
    );
  });
});

describe("expandWorkspacePattern", () => {
  it("expands a single '*' segment to immediate subdirectories", () => {
    const base = mkdtempSync(path.join(tmpDir, "ws-"));
    mkdirSync(path.join(base, "packages", "a"), { recursive: true });
    mkdirSync(path.join(base, "packages", "b"), { recursive: true });
    // A file in the wildcard slot must be ignored (only dirs expand).
    writeFileSync(path.join(base, "packages", "note.txt"), "x");

    const result = expandWorkspacePattern(base, "packages/*").sort();
    expect(result).toEqual(
      [
        path.join(base, "packages", "a"),
        path.join(base, "packages", "b"),
      ].sort(),
    );
  });

  it("honors a partial-wildcard segment via regex matching", () => {
    const base = mkdtempSync(path.join(tmpDir, "ws-"));
    mkdirSync(path.join(base, "plugin-sql"), { recursive: true });
    mkdirSync(path.join(base, "plugin-feed"), { recursive: true });
    mkdirSync(path.join(base, "core"), { recursive: true });

    const result = expandWorkspacePattern(base, "plugin-*").sort();
    expect(result).toEqual(
      [path.join(base, "plugin-feed"), path.join(base, "plugin-sql")].sort(),
    );
  });

  it("resolves a literal (non-wildcard) pattern directly", () => {
    const base = mkdtempSync(path.join(tmpDir, "ws-"));
    mkdirSync(path.join(base, "packages", "core"), { recursive: true });
    expect(expandWorkspacePattern(base, "packages/core")).toEqual([
      path.join(base, "packages", "core"),
    ]);
  });

  it("returns [] when a wildcard base directory is absent", () => {
    const base = mkdtempSync(path.join(tmpDir, "ws-"));
    expect(expandWorkspacePattern(base, "missing/*")).toEqual([]);
  });
});

describe("shouldSkipPackagedAppCoreEntry", () => {
  it("skips packaging + mobile platform + electrobun build/artifact scratch", () => {
    for (const skip of [
      "packaging",
      "packaging/x",
      "dist/packaging/y",
      "platforms/android",
      "platforms/ios/App",
      "platforms/electrobun/build/self-extractor",
      "platforms/electrobun/artifacts/out.zip",
      "platforms/electrobun/src/libMacWindowEffects.dylib",
    ]) {
      expect(shouldSkipPackagedAppCoreEntry(skip)).toBe(true);
    }
  });

  it("keeps ordinary dist source entries", () => {
    expect(shouldSkipPackagedAppCoreEntry("dist/index.js")).toBe(false);
    expect(
      shouldSkipPackagedAppCoreEntry("platforms/electrobun/src/main.ts"),
    ).toBe(false);
  });
});

describe("assertTarSafeRuntimePaths", () => {
  it("passes for a bundle whose relative paths are within the tar-safe limit", () => {
    const dist = mkdtempSync(path.join(tmpDir, "dist-safe-"));
    mkdirSync(path.join(dist, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(dist, "node_modules", "pkg", "index.js"), "");
    expect(() => assertTarSafeRuntimePaths(dist)).not.toThrow();
  });

  it("throws with a tar-unsafe diagnostic when a relative path is too long", () => {
    const dist = mkdtempSync(path.join(tmpDir, "dist-unsafe-"));
    // Build a nested path whose relative length exceeds the 202-char limit
    // (the exact failure mode of the nested aws-sdk credential-provider tree).
    let deep = path.join(dist, "node_modules");
    for (let i = 0; i < 8; i += 1) {
      deep = path.join(deep, `segment-${i}-${"x".repeat(20)}`);
    }
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, "leaf.js"), "");

    expect(() => assertTarSafeRuntimePaths(dist)).toThrowError(
      /tar-unsafe paths for the Electrobun self-extractor/,
    );
  });
});

describe("visitFiles", () => {
  it("visits every file recursively and skips directories", () => {
    const root = mkdtempSync(path.join(tmpDir, "visit-"));
    mkdirSync(path.join(root, "a", "b"), { recursive: true });
    writeFileSync(path.join(root, "top.js"), "");
    writeFileSync(path.join(root, "a", "mid.js"), "");
    writeFileSync(path.join(root, "a", "b", "leaf.js"), "");

    const seen: string[] = [];
    visitFiles(root, (p) => seen.push(path.basename(p)));
    expect(seen.sort()).toEqual(["leaf.js", "mid.js", "top.js"]);
  });

  it("is a no-op when the root does not exist", () => {
    const seen: string[] = [];
    visitFiles(path.join(tmpDir, "nope"), (p) => seen.push(p));
    expect(seen).toEqual([]);
  });
});

describe("patchCopiedElevenLabsTarSafePaths", () => {
  it("leaves tar-safe .js files untouched", () => {
    const pkg = mkdtempSync(path.join(tmpDir, "el-safe-"));
    const file = path.join(pkg, "index.js");
    writeFileSync(file, "export const x = 1;");
    // rootDestDir === pkg so the relative path is just 'index.js' (safe).
    patchCopiedElevenLabsTarSafePaths(pkg, pkg);
    expect(existsSync(file)).toBe(true);
  });

  it("renames a tar-unsafe .js file to a short hashed basename and rewrites importers", () => {
    const pkg = mkdtempSync(path.join(tmpDir, "el-unsafe-"));
    // Deeply-nested dir so the relative-from-root path exceeds the tar limit.
    let deep = pkg;
    for (let i = 0; i < 8; i += 1) {
      deep = path.join(deep, `nested-${i}-${"y".repeat(18)}`);
    }
    mkdirSync(deep, { recursive: true });
    const longName = `${"z".repeat(40)}-module.js`;
    const target = path.join(deep, longName);
    writeFileSync(target, "export const value = 42;\n");
    // An importer at the package ROOT (tar-safe relative path, so it is NOT
    // itself renamed) that references the deep long module by relative path.
    const importerRel = path.relative(pkg, target).split(path.sep).join("/");
    const importer = path.join(pkg, "importer.js");
    writeFileSync(
      importer,
      `import { value } from "./${importerRel.replace(/\.js$/, "")}";\nexport { value };\n`,
    );

    patchCopiedElevenLabsTarSafePaths(pkg, pkg);

    // Original long-named file is gone; a short f_<hash>.js took its place.
    expect(existsSync(target)).toBe(false);
    const remaining = readdirSync(deep).filter((n) => n.endsWith(".js"));
    expect(remaining.some((n) => n.startsWith("f_"))).toBe(true);
    // The root importer was rewritten to reference the new short basename.
    const rewritten = readFileSync(importer, "utf8");
    expect(rewritten).toContain("f_");
  });
});

describe("copyPackageDir", () => {
  it("copies a package's runtime surface into the target node_modules", () => {
    const workspace = mkdtempSync(path.join(tmpDir, "copy-src-"));
    // Source package: keep dist, drop obvious dev-only dirs via the filter.
    mkdirSync(path.join(workspace, "dist"), { recursive: true });
    writeFileSync(
      path.join(workspace, "dist", "index.js"),
      "module.exports={}",
    );
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "@elizaos/example-copy",
        main: "./dist/index.js",
      }),
    );

    const rootDestDir = mkdtempSync(path.join(tmpDir, "copy-dest-"));
    const targetNodeModules = path.join(rootDestDir, "node_modules");
    mkdirSync(targetNodeModules, { recursive: true });

    const copied = copyPackageDir(
      "@elizaos/example-copy",
      workspace,
      targetNodeModules,
      rootDestDir,
    );
    expect(copied).toBe(true);

    const landedManifest = path.join(
      targetNodeModules,
      "@elizaos",
      "example-copy",
      "package.json",
    );
    const landedEntry = path.join(
      targetNodeModules,
      "@elizaos",
      "example-copy",
      "dist",
      "index.js",
    );
    expect(existsSync(landedManifest)).toBe(true);
    expect(existsSync(landedEntry)).toBe(true);
  });
});

describe("workspace publish surface", () => {
  it("derives the runtime top-level entries from files and executable exports", () => {
    const sourceDir = writeWorkspaceManifest("@elizaos/example-workspace", {
      files: ["dist/**", "assets/icons", "!src/private", "*.md"],
      main: "./server/index.js",
      module: "./esm/index.js",
      exports: {
        ".": {
          types: "./types/index.d.ts",
          import: "./dist/index.js",
          default: "./dist/index.js",
          "eliza-source": "./src/index.ts",
        },
        "./feature": [
          { types: "./types/feature.d.ts" },
          { import: "./features/feature.js" },
        ],
      },
    });

    expect(
      [
        ...(getWorkspacePackageRuntimeCopyEntries(
          "@elizaos/example-workspace",
          sourceDir,
        ) ?? []),
      ].sort(),
    ).toEqual(
      [
        "LICENSE",
        "LICENSE.md",
        "LICENSE.txt",
        "README.md",
        "assets",
        "dist",
        "esm",
        "features",
        "package.json",
        "server",
      ].sort(),
    );
  });

  it("keeps the agent source condition because Bun may resolve it at runtime", () => {
    const sourceDir = writeWorkspaceManifest("@elizaos/agent", {
      files: ["dist"],
    });
    mkdirSync(path.join(sourceDir, "src"));

    expect(
      getWorkspacePackageRuntimeCopyEntries("@elizaos/agent", sourceDir),
    ).toContain("src");
  });

  it("declines non-workspace or unbounded manifests", () => {
    expect(
      getWorkspacePackageRuntimeCopyEntries(
        "@elizaos/outside",
        mkdtempSync(path.join(tmpDir, "outside-")),
      ),
    ).toBeNull();

    const missingManifest = mkdtempSync(
      path.join(process.cwd(), ".runtime-copy-workspace-cov-"),
    );
    workspaceFixtureDirs.push(missingManifest);
    expect(
      getWorkspacePackageRuntimeCopyEntries(
        "@elizaos/missing-manifest",
        missingManifest,
      ),
    ).toBeNull();

    const unbounded = writeWorkspaceManifest("@elizaos/unbounded", {
      files: "dist",
    });
    expect(
      getWorkspacePackageRuntimeCopyEntries("@elizaos/unbounded", unbounded),
    ).toBeNull();
  });

  it("copies only the package root and allowed top-level publish entries", () => {
    const sourceDir = writeWorkspaceManifest("@elizaos/example-workspace", {
      files: ["dist"],
    });
    const allowed = new Set(["package.json", "dist"]);

    expect(shouldCopyWorkspacePublishEntry(sourceDir, sourceDir, allowed)).toBe(
      true,
    );
    expect(
      shouldCopyWorkspacePublishEntry(
        path.join(sourceDir, "dist", "index.js"),
        sourceDir,
        allowed,
      ),
    ).toBe(true);
    expect(
      shouldCopyWorkspacePublishEntry(
        path.join(sourceDir, "src", "index.ts"),
        sourceDir,
        allowed,
      ),
    ).toBe(false);
  });
});

describe("shouldSkipPackagedDependency", () => {
  it("drops unused Smithers infrastructure clients from the packaged runtime", () => {
    for (const dependency of [
      "@aws-sdk/client-codebuild",
      "@aws-sdk/client-ecs",
      "@aws-sdk/client-cloudwatch-logs",
    ]) {
      expect(
        shouldSkipPackagedDependency("@smithers-orchestrator/aws", dependency),
      ).toBe(true);
    }
  });

  it("keeps runtime dependencies that are not explicitly excluded", () => {
    expect(
      shouldSkipPackagedDependency(
        "@smithers-orchestrator/aws",
        "@aws-sdk/client-s3",
      ),
    ).toBe(false);
    expect(shouldSkipPackagedDependency("example", "commander")).toBe(false);
  });

  it("rejects a native package for a different architecture", () => {
    const foreignArch = process.arch === "x64" ? "arm64" : "x64";
    expect(
      shouldSkipPackagedDependency(
        "example",
        `@node-llama-cpp/${process.platform}-${foreignArch}`,
      ),
    ).toBe(true);
  });
});

describe("selectCopyTargetNodeModules", () => {
  function makeCopyLayout() {
    const rootDestDir = mkdtempSync(path.join(tmpDir, "copy-layout-"));
    const targetNodeModules = path.join(rootDestDir, "node_modules");
    const requesterDestDir = path.join(
      targetNodeModules,
      "requester",
      "node_modules",
      "child",
    );
    mkdirSync(requesterDestDir, { recursive: true });
    return { rootDestDir, targetNodeModules, requesterDestDir };
  }

  it("places root requests, new packages, and hoisted packages at the root", () => {
    const { rootDestDir, targetNodeModules, requesterDestDir } =
      makeCopyLayout();

    expect(
      selectCopyTargetNodeModules({
        name: "example",
        requesterDestDir: rootDestDir,
        rootDestDir,
        targetNodeModules,
        topLevelVersions: new Map(),
        resolvedVersion: "1.0.0",
      }),
    ).toBe(targetNodeModules);
    expect(
      selectCopyTargetNodeModules({
        name: "new-package",
        requesterDestDir,
        rootDestDir,
        targetNodeModules,
        topLevelVersions: new Map(),
        resolvedVersion: "1.0.0",
      }),
    ).toBe(targetNodeModules);
    expect(
      selectCopyTargetNodeModules({
        name: "@elizaos/core",
        requesterDestDir,
        rootDestDir,
        targetNodeModules,
        topLevelVersions: new Map([["@elizaos/core", "2.0.0"]]),
        resolvedVersion: "1.0.0",
      }),
    ).toBe(targetNodeModules);
  });

  it("reuses compatible top-level versions", () => {
    const { rootDestDir, targetNodeModules, requesterDestDir } =
      makeCopyLayout();

    for (const [name, topLevelVersion, resolvedVersion] of [
      ["ordinary", "1.2.3", "1.2.3"],
      ["@walletconnect/core", "2.7.9", "2.7.1"],
      ["@smithy/core", "3.4.2", "3.3.9"],
    ] as const) {
      expect(
        selectCopyTargetNodeModules({
          name,
          requesterDestDir,
          rootDestDir,
          targetNodeModules,
          topLevelVersions: new Map([[name, topLevelVersion]]),
          resolvedVersion,
        }),
      ).toBe(targetNodeModules);
    }
  });

  it("reuses an exact ancestor and otherwise nests an incompatible version", () => {
    const { rootDestDir, targetNodeModules, requesterDestDir } =
      makeCopyLayout();
    const name = "versioned-package";
    const ancestorNodeModules = path.join(
      rootDestDir,
      "node_modules",
      "requester",
      "node_modules",
    );
    const ancestorPackageDir = path.join(ancestorNodeModules, name);
    mkdirSync(ancestorPackageDir, { recursive: true });
    writeFileSync(
      path.join(ancestorPackageDir, "package.json"),
      JSON.stringify({ name, version: "2.0.0" }),
    );

    expect(
      selectCopyTargetNodeModules({
        name,
        requesterDestDir,
        rootDestDir,
        targetNodeModules,
        topLevelVersions: new Map([[name, "1.0.0"]]),
        resolvedVersion: "2.0.0",
      }),
    ).toBe(ancestorNodeModules);

    expect(
      selectCopyTargetNodeModules({
        name,
        requesterDestDir,
        rootDestDir,
        targetNodeModules,
        topLevelVersions: new Map([[name, "1.0.0"]]),
        resolvedVersion: "3.0.0",
      }),
    ).toBe(path.join(requesterDestDir, "node_modules"));
  });
});

describe("assertRequiredBundledPackagesLanded", () => {
  function writeBundledPackage(
    targetNodeModules: string,
    name: string,
    manifest: Record<string, unknown>,
  ): string {
    const packageDir = path.join(targetNodeModules, ...name.split("/"));
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name, ...manifest }),
    );
    return packageDir;
  }

  it("accepts present packages and executable manifest entrypoints", () => {
    const targetNodeModules = path.join(tmpDir, "required-ok", "node_modules");
    const packageDir = writeBundledPackage(targetNodeModules, "@elizaos/core", {
      main: "./dist/index.js",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
    });
    mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    writeFileSync(path.join(packageDir, "dist", "index.js"), "export {};\n");
    writeBundledPackage(targetNodeModules, "custom-runtime", {});

    expect(() =>
      assertRequiredBundledPackagesLanded(
        targetNodeModules,
        new Set(["@elizaos/core", "custom-runtime"]),
      ),
    ).not.toThrow();
  });

  it("reports both missing packages and missing baseline entrypoints", () => {
    const targetNodeModules = path.join(
      tmpDir,
      "required-fail",
      "node_modules",
    );
    writeBundledPackage(targetNodeModules, "@elizaos/core", {
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
    });

    expect(() =>
      assertRequiredBundledPackagesLanded(
        targetNodeModules,
        new Set(["@elizaos/core", "missing-runtime"]),
      ),
    ).toThrowError(/2 required runtime package check\(s\) failed/);
  });
});
