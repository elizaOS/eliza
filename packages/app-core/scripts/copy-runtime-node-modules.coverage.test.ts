/**
 * Focused unit coverage for the pure decision helpers in
 * `copy-runtime-node-modules.ts`.
 *
 * These tests exercise the desktop runtime-copy script's platform-variant,
 * version-inference, dependency-walk, and candidate-selection helpers that
 * decide WHICH files/packages land in the packaged bundle. They pass explicit
 * `targetOS`/`targetArch` so the assertions are deterministic on any CI
 * runner, and use tmp fixtures for the manifest-reading helpers.
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
  ensureResolvedWorkspaceRuntimeEntriesBuilt,
  expandWorkspacePattern,
  getRuntimeDependencies,
  getRuntimeDependencyEntries,
  getWorkspacePackageRuntimeCopyEntries,
  inferVersionFromBunEntryPath,
  isExactVersionSpecifier,
  isPackageCompatibleWithCurrentPlatform,
  matchesRuntimeVariant,
  normalizeResolvedPackage,
  parseArgs,
  patchCopiedElevenLabsTarSafePaths,
  readWorkspacePatterns,
  recordMissingRuntimeDependency,
  recursiveRemoveErrorDetail,
  selectCopyTargetNodeModules,
  selectResolvedCandidate,
  shouldCopyPackageEntry,
  shouldCopyWorkspacePublishEntry,
  shouldKeepPackageRelativePath,
  shouldSkipPackagedAppCoreEntry,
  shouldSkipPackagedDependency,
  visitFiles,
  workspacePackageNeedsRuntimeBuild,
} from "./copy-runtime-node-modules";
import {
  isRuntimePluginPackage,
  shouldBundleDiscoveredPackage,
} from "./runtime-package-manifest";

let tmpDir: string;

describe("recordMissingRuntimeDependency", () => {
  it("routes missing hard and optional queue entries to distinct result sets", () => {
    const required = new Set<string>();
    const optional = new Set<string>();

    recordMissingRuntimeDependency(
      { name: "hard-dependency", required: true },
      required,
      optional,
    );
    recordMissingRuntimeDependency(
      { name: "optional-peer", required: false },
      required,
      optional,
    );

    expect([...required]).toEqual(["hard-dependency"]);
    expect([...optional]).toEqual(["optional-peer"]);
  });

  it("keeps required classification regardless of queue traversal order", () => {
    for (const requiredFirst of [true, false]) {
      const required = new Set<string>();
      const optional = new Set<string>();
      const entries = requiredFirst
        ? [
            { name: "shared-dependency", required: true },
            { name: "shared-dependency", required: false },
          ]
        : [
            { name: "shared-dependency", required: false },
            { name: "shared-dependency", required: true },
          ];

      for (const entry of entries) {
        recordMissingRuntimeDependency(entry, required, optional);
      }

      expect([...required]).toEqual(["shared-dependency"]);
      expect([...optional]).toEqual([]);
    }
  });
});

function writeManifest(
  name: string,
  manifest: Record<string, unknown> = {},
): string {
  const dir = mkdtempSync(path.join(tmpDir, "pkg-"));
  const manifestPath = path.join(dir, "package.json");
  writeFileSync(manifestPath, JSON.stringify({ name, ...manifest }, null, 2));
  return manifestPath;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "copy-runtime-cov-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
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
});

describe("workspacePackageNeedsRuntimeBuild", () => {
  it("requires a build when a workspace package's runtime export is missing", () => {
    const packageJsonPath = writeManifest("@elizaos/plugin-wallet", {
      exports: {
        ".": {
          import: "./dist/index.mjs",
          default: "./dist/index.mjs",
        },
        "./*": {
          import: "./dist/*.js",
          default: "./dist/*.js",
        },
      },
      scripts: { build: "bun run build.ts" },
    });

    expect(workspacePackageNeedsRuntimeBuild(packageJsonPath)).toBe(true);
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

  it("drops foreign hermes compiler payloads", () => {
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
        "hermesc/osx-bin/hermesc",
        "linux",
        "x64",
        "hermes-compiler",
      ),
    ).toBe(false);
    expect(
      shouldKeepPackageRelativePath(
        "hermesc/win64-bin/icudt64.dll",
        "linux",
        "x64",
        "hermes-compiler",
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
});

describe("shouldCopyPackageEntry", () => {
  it("drops nested node_modules and pruned dir names", () => {
    const root = mkdtempSync(path.join(tmpDir, "copy-entry-"));
    const imageSnapshots = path.join(root, "src", "__image_snapshots__");
    mkdirSync(imageSnapshots, { recursive: true });
    expect(
      shouldCopyPackageEntry(path.join(root, "node_modules"), "pkg", root),
    ).toBe(false);
    expect(shouldCopyPackageEntry(path.join(root, ".git"), "pkg", root)).toBe(
      false,
    );
    expect(shouldCopyPackageEntry(imageSnapshots, "pkg", root)).toBe(false);
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
    expect(entries.map(({ name, required }) => ({ name, required }))).toEqual([
      { name: "alpha", required: false },
      { name: "beta", required: true },
      { name: "gamma", required: false },
    ]);
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

describe("runtime plugin package classification", () => {
  it("does not filter third-party scoped packages whose basename starts with plugin-", () => {
    const alwaysBundled = new Set<string>();

    expect(isRuntimePluginPackage("@octokit/plugin-request-log")).toBe(false);
    expect(
      shouldBundleDiscoveredPackage(
        "@octokit/plugin-request-log",
        alwaysBundled,
      ),
    ).toBe(true);
    expect(isRuntimePluginPackage("@elizaos/plugin-browser")).toBe(true);
    expect(
      shouldBundleDiscoveredPackage("@elizaos/plugin-browser", alwaysBundled),
    ).toBe(false);
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

describe("selectResolvedCandidate", () => {
  function candidate(name: string, version: string) {
    const dir = mkdtempSync(path.join(tmpDir, "cand-"));
    const manifestPath = path.join(dir, "package.json");
    writeFileSync(manifestPath, JSON.stringify({ name, version }));
    return { sourceDir: dir, packageJsonPath: manifestPath };
  }

  it("returns null when there are no candidates", () => {
    expect(selectResolvedCandidate([], "1.0.0")).toBeNull();
  });

  it("returns the first candidate for a non-exact requested spec", () => {
    const a = candidate("pkg", "1.0.0");
    const b = candidate("pkg", "2.0.0");
    expect(selectResolvedCandidate([a, b], "^1.0.0")).toBe(a);
  });

  it("picks the exact version match when the spec is exact", () => {
    const a = candidate("pkg", "1.0.0");
    const b = candidate("pkg", "2.0.0");
    expect(selectResolvedCandidate([a, b], "2.0.0")).toBe(b);
  });

  it("falls back to the first candidate when no exact match exists", () => {
    const a = candidate("pkg", "1.0.0");
    const b = candidate("pkg", "2.0.0");
    expect(selectResolvedCandidate([a, b], "9.9.9")).toBe(a);
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

describe("getWorkspacePackageRuntimeCopyEntries", () => {
  it("derives the publish surface from files and runtime manifest entries", () => {
    const sourceDir = mkdtempSync(
      path.join(process.cwd(), ".copy-runtime-workspace-"),
    );
    try {
      mkdirSync(path.join(sourceDir, "src"));
      writeFileSync(
        path.join(sourceDir, "package.json"),
        JSON.stringify({
          name: "@elizaos/agent",
          files: ["dist", "assets/schema.json"],
          main: "./dist/index.js",
          module: "./esm/index.js",
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              import: "./dist/index.js",
              default: ["./fallback/index.js", null],
            },
            "./package.json": "./package.json",
          },
        }),
      );

      expect(
        getWorkspacePackageRuntimeCopyEntries("@elizaos/agent", sourceDir),
      ).toEqual(
        new Set([
          "LICENSE",
          "LICENSE.md",
          "LICENSE.txt",
          "README.md",
          "package.json",
          "dist",
          "assets",
          "esm",
          "fallback",
          "src",
        ]),
      );
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it("declines non-workspace and non-publishable manifests", () => {
    expect(
      getWorkspacePackageRuntimeCopyEntries("external", tmpDir),
    ).toBeNull();

    const sourceDir = mkdtempSync(
      path.join(process.cwd(), ".copy-runtime-workspace-"),
    );
    try {
      expect(
        getWorkspacePackageRuntimeCopyEntries("missing", sourceDir),
      ).toBeNull();
      writeFileSync(
        path.join(sourceDir, "package.json"),
        JSON.stringify({ name: "invalid", files: "dist" }),
      );
      expect(
        getWorkspacePackageRuntimeCopyEntries("invalid", sourceDir),
      ).toBeNull();
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});

describe("ensureResolvedWorkspaceRuntimeEntriesBuilt", () => {
  it("builds a source-only workspace package before its runtime export is copied", () => {
    const sourceDir = mkdtempSync(
      path.join(process.cwd(), ".copy-runtime-source-only-"),
    );
    try {
      writeFileSync(
        path.join(sourceDir, "package.json"),
        JSON.stringify({
          name: "@elizaos/source-only-runtime",
          main: "./dist/index.js",
          scripts: { build: "node build.mjs" },
        }),
      );
      writeFileSync(
        path.join(sourceDir, "build.mjs"),
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'mkdirSync("dist", { recursive: true });',
          'writeFileSync("dist/index.js", "export const ready = true;\\n");',
        ].join("\n"),
      );

      const packageJsonPath = path.join(sourceDir, "package.json");
      expect(existsSync(path.join(sourceDir, "dist", "index.js"))).toBe(false);

      ensureResolvedWorkspaceRuntimeEntriesBuilt(
        "@elizaos/source-only-runtime",
        { sourceDir, packageJsonPath },
      );

      expect(existsSync(path.join(sourceDir, "dist", "index.js"))).toBe(true);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it("fails when a workspace build leaves its declared runtime export missing", () => {
    const sourceDir = mkdtempSync(
      path.join(process.cwd(), ".copy-runtime-missing-export-"),
    );
    try {
      writeFileSync(
        path.join(sourceDir, "package.json"),
        JSON.stringify({
          name: "@elizaos/missing-runtime",
          main: "./dist/index.js",
          scripts: { build: 'node -e "process.exit(0)"' },
        }),
      );

      expect(() =>
        ensureResolvedWorkspaceRuntimeEntriesBuilt("@elizaos/missing-runtime", {
          sourceDir,
          packageJsonPath: path.join(sourceDir, "package.json"),
        }),
      ).toThrow(
        /build completed without producing its declared runtime entries/,
      );
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it("fails fast when a workspace build exits non-zero after writing its export", () => {
    const sourceDir = mkdtempSync(
      path.join(process.cwd(), ".copy-runtime-failed-build-"),
    );
    try {
      writeFileSync(
        path.join(sourceDir, "package.json"),
        JSON.stringify({
          name: "@elizaos/failed-runtime",
          main: "./dist/index.js",
          scripts: { build: "node build.mjs" },
        }),
      );
      writeFileSync(
        path.join(sourceDir, "build.mjs"),
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'mkdirSync("dist", { recursive: true });',
          'writeFileSync("dist/index.js", "export const partial = true;\\n");',
          "process.exit(1);",
        ].join("\n"),
      );

      expect(() =>
        ensureResolvedWorkspaceRuntimeEntriesBuilt("@elizaos/failed-runtime", {
          sourceDir,
          packageJsonPath: path.join(sourceDir, "package.json"),
        }),
      ).toThrow();
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});

describe("shouldCopyWorkspacePublishEntry", () => {
  it("keeps the package root and allowed top-level publish entries", () => {
    const sourceDir = path.join(tmpDir, "workspace-package");
    const allowed = new Set(["dist", "package.json"]);
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
        path.join(sourceDir, "test", "index.test.js"),
        sourceDir,
        allowed,
      ),
    ).toBe(false);
  });
});

describe("shouldSkipPackagedDependency", () => {
  it("drops platform-incompatible and explicitly skipped dependencies", () => {
    const incompatibleOS = process.platform === "linux" ? "darwin" : "linux";
    const incompatibleArch = process.arch === "arm64" ? "x64" : "arm64";
    const incompatible = `@node-llama-cpp/${incompatibleOS}-${incompatibleArch}`;
    expect(shouldSkipPackagedDependency("requester", incompatible)).toBe(true);
  });
});

describe("selectCopyTargetNodeModules", () => {
  it("uses the root target for root requesters, hoisted packages, and new names", () => {
    const rootDestDir = path.join(tmpDir, "bundle");
    const targetNodeModules = path.join(rootDestDir, "node_modules");
    const nestedRequester = path.join(
      targetNodeModules,
      "requester",
      "node_modules",
      "child",
    );
    const base = {
      rootDestDir,
      targetNodeModules,
      topLevelVersions: new Map<string, string | null>([["pg", "8.0.0"]]),
      resolvedVersion: "8.0.0",
    };

    expect(
      selectCopyTargetNodeModules({
        ...base,
        name: "pg",
        requesterDestDir: rootDestDir,
      }),
    ).toBe(targetNodeModules);
    expect(
      selectCopyTargetNodeModules({
        ...base,
        name: "pg",
        requesterDestDir: nestedRequester,
      }),
    ).toBe(targetNodeModules);
    expect(
      selectCopyTargetNodeModules({
        ...base,
        name: "new-package",
        requesterDestDir: nestedRequester,
      }),
    ).toBe(targetNodeModules);
  });

  it("reuses compatible roots and matching ancestor package copies", () => {
    const rootDestDir = path.join(tmpDir, "bundle");
    const targetNodeModules = path.join(rootDestDir, "node_modules");
    const requesterDestDir = path.join(
      targetNodeModules,
      "parent",
      "node_modules",
      "requester",
    );
    const topLevelVersions = new Map<string, string | null>([
      ["@walletconnect/core", "2.11.4"],
      ["ordinary", "1.0.0"],
    ]);

    expect(
      selectCopyTargetNodeModules({
        name: "@walletconnect/core",
        requesterDestDir,
        rootDestDir,
        targetNodeModules,
        topLevelVersions,
        resolvedVersion: "2.11.1",
      }),
    ).toBe(targetNodeModules);

    const ancestorNodeModules = path.join(
      targetNodeModules,
      "parent",
      "node_modules",
    );
    const ancestorPackage = path.join(ancestorNodeModules, "ordinary");
    mkdirSync(ancestorPackage, { recursive: true });
    writeFileSync(
      path.join(ancestorPackage, "package.json"),
      JSON.stringify({ name: "ordinary", version: "2.0.0" }),
    );
    expect(
      selectCopyTargetNodeModules({
        name: "ordinary",
        requesterDestDir,
        rootDestDir,
        targetNodeModules,
        topLevelVersions,
        resolvedVersion: "2.0.0",
      }),
    ).toBe(ancestorNodeModules);

    expect(
      selectCopyTargetNodeModules({
        name: "ordinary",
        requesterDestDir,
        rootDestDir,
        targetNodeModules,
        topLevelVersions,
        resolvedVersion: "3.0.0",
      }),
    ).toBe(path.join(requesterDestDir, "node_modules"));
  });
});

describe("assertRequiredBundledPackagesLanded", () => {
  it("reports missing packages and missing baseline runtime entrypoints", () => {
    const targetNodeModules = path.join(tmpDir, "node_modules");
    mkdirSync(targetNodeModules, { recursive: true });
    expect(() =>
      assertRequiredBundledPackagesLanded(
        targetNodeModules,
        new Set(["definitely-missing"]),
      ),
    ).toThrow(/definitely-missing/);

    const coreDir = path.join(targetNodeModules, "@elizaos", "core");
    mkdirSync(coreDir, { recursive: true });
    writeFileSync(
      path.join(coreDir, "package.json"),
      JSON.stringify({
        name: "@elizaos/core",
        main: "./dist/index.js",
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            import: "./dist/index.js",
          },
        },
      }),
    );
    expect(() =>
      assertRequiredBundledPackagesLanded(
        targetNodeModules,
        new Set(["@elizaos/core"]),
      ),
    ).toThrow(/missing runtime entry/);
  });

  it("accepts complete baseline and non-baseline package copies", () => {
    const targetNodeModules = path.join(tmpDir, "node_modules");
    const coreDir = path.join(targetNodeModules, "@elizaos", "core");
    const customDir = path.join(targetNodeModules, "custom-runtime");
    mkdirSync(path.join(coreDir, "dist"), { recursive: true });
    mkdirSync(customDir, { recursive: true });
    writeFileSync(
      path.join(coreDir, "package.json"),
      JSON.stringify({ name: "@elizaos/core", main: "./dist/index.js" }),
    );
    writeFileSync(path.join(coreDir, "dist", "index.js"), "export {};\n");
    writeFileSync(
      path.join(customDir, "package.json"),
      JSON.stringify({ name: "custom-runtime", main: "./missing.js" }),
    );

    expect(() =>
      assertRequiredBundledPackagesLanded(
        targetNodeModules,
        new Set(["@elizaos/core", "custom-runtime"]),
      ),
    ).not.toThrow();
  });
});
