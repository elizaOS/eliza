/**
 * Tests for native library loading policy, app bundle resolution, and sandboxing checks.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type NativeLibraryCandidate,
  type NativeLibraryPolicyOptions,
  nativeLibraryPolicyInternalsForTest,
  resolveNativeLibraryCandidate,
} from "./native-library-policy.ts";

const { findMacAppBundleRoot, isStoreBuildVariant, isWithinPath } =
  nativeLibraryPolicyInternalsForTest;

describe("native library policy internal helpers", () => {
  it("detects store build variant case-insensitively", () => {
    expect(isStoreBuildVariant({ ELIZA_BUILD_VARIANT: "store" })).toBe(true);
    expect(isStoreBuildVariant({ ELIZA_BUILD_VARIANT: " STORE " })).toBe(true);
    expect(isStoreBuildVariant({ ELIZA_BUILD_VARIANT: "direct" })).toBe(false);
    expect(isStoreBuildVariant({})).toBe(false);
  });

  it("finds Mac app bundle root from path components", () => {
    expect(
      findMacAppBundleRoot("/Applications/Eliza.app/Contents/MacOS/eliza"),
    ).toBe("/Applications/Eliza.app");
    expect(
      findMacAppBundleRoot(
        "/Users/dev/dist/mac-arm64/Eliza.app/Contents/Frameworks/bridge.dylib",
      ),
    ).toBe("/Users/dev/dist/mac-arm64/Eliza.app");
    expect(findMacAppBundleRoot("/usr/local/lib/bridge.dylib")).toBeNull();
    expect(findMacAppBundleRoot(undefined)).toBeNull();
  });

  it("evaluates path containment accurately", () => {
    expect(isWithinPath("/app", "/app/lib/bridge.dylib")).toBe(true);
    expect(isWithinPath("/app", "/app")).toBe(true);
    expect(isWithinPath("/app", "/other/bridge.dylib")).toBe(false);
  });
});

describe("resolveNativeLibraryCandidate", () => {
  let tempDir: string;
  let testDylibPath: string;
  let bundleDir: string;
  let bundleDylibPath: string;

  beforeAll(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "eliza-dylib-test-"));
    testDylibPath = path.join(tempDir, "libbridge.dylib");
    await fsp.writeFile(testDylibPath, "mock binary");

    bundleDir = path.join(tempDir, "Eliza.app", "Contents", "Frameworks");
    await fsp.mkdir(bundleDir, { recursive: true });
    bundleDylibPath = path.join(bundleDir, "libbridge.dylib");
    await fsp.writeFile(bundleDylibPath, "mock binary in bundle");
  });

  afterAll(async () => {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("resolves existing library path for direct builds", () => {
    const candidate: NativeLibraryCandidate = {
      path: testDylibPath,
    };
    const opts: NativeLibraryPolicyOptions = {
      expectedBasename: "libbridge.dylib",
      env: { ELIZA_BUILD_VARIANT: "direct" },
    };

    const resolved = resolveNativeLibraryCandidate(candidate, opts);
    expect(resolved).toBe(testDylibPath);
  });

  it("resolves relative path using moduleDir for direct builds", () => {
    const candidate: NativeLibraryCandidate = {
      path: "libbridge.dylib",
    };
    const opts: NativeLibraryPolicyOptions = {
      expectedBasename: "libbridge.dylib",
      moduleDir: tempDir,
      env: {},
    };

    const resolved = resolveNativeLibraryCandidate(candidate, opts);
    expect(resolved).toBe(testDylibPath);
  });

  it("warns and returns null when relative path lacks moduleDir", () => {
    const warn = vi.fn();
    const candidate: NativeLibraryCandidate = {
      path: "relative/libbridge.dylib",
    };
    const opts: NativeLibraryPolicyOptions = {
      expectedBasename: "libbridge.dylib",
      warn,
    };

    const resolved = resolveNativeLibraryCandidate(candidate, opts);
    expect(resolved).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cannot be resolved without a module directory"),
    );
  });

  it("returns null when candidate file does not exist on disk", () => {
    const candidate: NativeLibraryCandidate = {
      path: path.join(tempDir, "missing.dylib"),
    };
    const opts: NativeLibraryPolicyOptions = {
      expectedBasename: "libbridge.dylib",
    };

    expect(resolveNativeLibraryCandidate(candidate, opts)).toBeNull();
  });

  it("enforces store build requirements: expected basename and bundle root", () => {
    const warn = vi.fn();
    // 1. Basename mismatch
    const badBasenameCandidate: NativeLibraryCandidate = {
      path: testDylibPath,
    };
    const badOpts: NativeLibraryPolicyOptions = {
      expectedBasename: "other.dylib",
      env: { ELIZA_BUILD_VARIANT: "store" },
      warn,
    };
    expect(
      resolveNativeLibraryCandidate(badBasenameCandidate, badOpts),
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("expected other.dylib"),
    );

    // 2. Outside bundle root
    const outsideCandidate: NativeLibraryCandidate = {
      path: testDylibPath,
    };
    const outsideOpts: NativeLibraryPolicyOptions = {
      expectedBasename: "libbridge.dylib",
      execPath: path.join(tempDir, "Eliza.app", "Contents", "MacOS", "eliza"),
      env: { ELIZA_BUILD_VARIANT: "store" },
      warn,
    };
    expect(
      resolveNativeLibraryCandidate(outsideCandidate, outsideOpts),
    ).toBeNull();

    // 3. Valid inside bundle root
    const insideCandidate: NativeLibraryCandidate = {
      path: bundleDylibPath,
    };
    const insideOpts: NativeLibraryPolicyOptions = {
      expectedBasename: "libbridge.dylib",
      execPath: path.join(tempDir, "Eliza.app", "Contents", "MacOS", "eliza"),
      env: { ELIZA_BUILD_VARIANT: "store" },
    };
    expect(resolveNativeLibraryCandidate(insideCandidate, insideOpts)).toBe(
      bundleDylibPath,
    );
  });

  it("guards against nullish or invalid arguments", () => {
    expect(
      resolveNativeLibraryCandidate(null, {} as NativeLibraryPolicyOptions),
    ).toBeNull();
    expect(
      resolveNativeLibraryCandidate(
        { path: testDylibPath },
        null as unknown as NativeLibraryPolicyOptions,
      ),
    ).toBeNull();
    expect(
      resolveNativeLibraryCandidate(
        { path: "" },
        { expectedBasename: "libbridge.dylib" },
      ),
    ).toBeNull();
  });
});
