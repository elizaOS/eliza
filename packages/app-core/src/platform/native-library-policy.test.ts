/**
 * Unit coverage for `resolveNativeLibraryCandidate`: direct builds accept any
 * existing dylib, store builds accept only the expected-basename library inside
 * the signed `.app` bundle, and symlink / relative / out-of-bundle candidates
 * are rejected (returning null, not throwing). Exercises real temp dirs and
 * symlinks on the local filesystem.
 */
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNativeLibraryCandidate } from "./native-library-policy";

function tempRoot(): string {
  return path.join(
    tmpdir(),
    `native-library-policy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

function touch(filePath: string): string {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "");
  return filePath;
}

describe("resolveNativeLibraryCandidate", () => {
  it("allows arbitrary existing dylib paths in direct builds", () => {
    const root = tempRoot();
    const dylib = touch(path.join(root, "cache", "custom.dylib"));

    expect(
      resolveNativeLibraryCandidate(
        { path: dylib },
        {
          env: { ELIZA_BUILD_VARIANT: "direct" },
          expectedBasename: "libMacWindowEffects.dylib",
          moduleDir: root,
        },
      ),
    ).toBe(realpathSync.native(dylib));
  });

  it("rejects relative candidates without a module directory instead of throwing", () => {
    const warnings: string[] = [];

    expect(
      resolveNativeLibraryCandidate(
        { label: "packaged bridge", path: "../libNative.dylib" },
        {
          env: { ELIZA_BUILD_VARIANT: "direct" },
          expectedBasename: "libNative.dylib",
          moduleDir: undefined,
          warn: (message) => warnings.push(message),
        },
      ),
    ).toBeNull();
    expect(warnings.join("\n")).toContain("without a module directory");
  });

  it("allows the expected dylib inside the trusted app bundle in store builds", () => {
    const root = tempRoot();
    const appRoot = path.join(root, "Eliza.app");
    const dylib = touch(
      path.join(appRoot, "Contents", "Resources", "libMacWindowEffects.dylib"),
    );
    const execPath = touch(path.join(appRoot, "Contents", "MacOS", "Eliza"));

    expect(
      resolveNativeLibraryCandidate(
        { path: dylib },
        {
          env: { ELIZA_BUILD_VARIANT: "store" },
          execPath,
          expectedBasename: "libMacWindowEffects.dylib",
          moduleDir: path.join(appRoot, "Contents", "Resources", "bun"),
        },
      ),
    ).toBe(realpathSync.native(dylib));
  });

  it("rejects home, cache, and plugin dylibs outside the app bundle in store builds", () => {
    const root = tempRoot();
    const appRoot = path.join(root, "Eliza.app");
    const execPath = touch(path.join(appRoot, "Contents", "MacOS", "Eliza"));
    const pluginDylib = touch(
      path.join(
        root,
        "Library",
        "Caches",
        "plugins",
        "libMacWindowEffects.dylib",
      ),
    );
    const warnings: string[] = [];

    expect(
      resolveNativeLibraryCandidate(
        { label: "plugin cache", path: pluginDylib },
        {
          env: { ELIZA_BUILD_VARIANT: "store" },
          execPath,
          expectedBasename: "libMacWindowEffects.dylib",
          moduleDir: path.join(appRoot, "Contents", "Resources", "bun"),
          warn: (message) => warnings.push(message),
        },
      ),
    ).toBeNull();
    expect(warnings.join("\n")).toContain("outside the signed app bundle");
  });

  it("rejects wrong library names in store builds even inside the app bundle", () => {
    const root = tempRoot();
    const appRoot = path.join(root, "Eliza.app");
    const execPath = touch(path.join(appRoot, "Contents", "MacOS", "Eliza"));
    const dylib = touch(
      path.join(appRoot, "Contents", "Resources", "plugin.dylib"),
    );

    expect(
      resolveNativeLibraryCandidate(
        { path: dylib },
        {
          env: { ELIZA_BUILD_VARIANT: "store" },
          execPath,
          expectedBasename: "libMacWindowEffects.dylib",
          moduleDir: path.join(appRoot, "Contents", "Resources", "bun"),
        },
      ),
    ).toBeNull();
  });

  it("rejects expected-name symlinks that resolve outside the app bundle in store builds", () => {
    const root = tempRoot();
    const appRoot = path.join(root, "Eliza.app");
    const execPath = touch(path.join(appRoot, "Contents", "MacOS", "Eliza"));
    const outsideDylib = touch(
      path.join(root, "Library", "Caches", "plugins", "plugin.dylib"),
    );
    const symlinkPath = path.join(
      appRoot,
      "Contents",
      "Resources",
      "libMacWindowEffects.dylib",
    );
    mkdirSync(path.dirname(symlinkPath), { recursive: true });
    symlinkSync(outsideDylib, symlinkPath);

    expect(
      resolveNativeLibraryCandidate(
        { path: symlinkPath },
        {
          env: { ELIZA_BUILD_VARIANT: "store" },
          execPath,
          expectedBasename: "libMacWindowEffects.dylib",
          moduleDir: path.join(appRoot, "Contents", "Resources", "bun"),
        },
      ),
    ).toBeNull();
  });

  it("rejects expected-name symlinks whose realpath basename is unexpected", () => {
    const root = tempRoot();
    const appRoot = path.join(root, "Eliza.app");
    const execPath = touch(path.join(appRoot, "Contents", "MacOS", "Eliza"));
    const targetDylib = touch(
      path.join(appRoot, "Contents", "Resources", "plugin.dylib"),
    );
    const symlinkPath = path.join(
      appRoot,
      "Contents",
      "Resources",
      "libMacWindowEffects.dylib",
    );
    symlinkSync(targetDylib, symlinkPath);

    expect(
      resolveNativeLibraryCandidate(
        { path: symlinkPath },
        {
          env: { ELIZA_BUILD_VARIANT: "store" },
          execPath,
          expectedBasename: "libMacWindowEffects.dylib",
          moduleDir: path.join(appRoot, "Contents", "Resources", "bun"),
        },
      ),
    ).toBeNull();
  });
});
