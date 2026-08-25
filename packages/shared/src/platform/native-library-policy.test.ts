/**
 * Unit coverage for native library load-path policy in native-library-policy.ts.
 *
 * Exercises candidate resolution across direct vs store builds, realpath
 * canonicalization, macOS app bundle root detection, path containment,
 * expected basename matching, and security warning emissions.
 */

import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  nativeLibraryPolicyInternalsForTest,
  resolveNativeLibraryCandidate,
} from "./native-library-policy.js";

const { findMacAppBundleRoot, isStoreBuildVariant, isWithinPath } =
  nativeLibraryPolicyInternalsForTest;

describe("native-library-policy", () => {
  describe("isStoreBuildVariant", () => {
    it("identifies store build variant case-insensitively with trimming", () => {
      expect(isStoreBuildVariant({ ELIZA_BUILD_VARIANT: "store" })).toBe(true);
      expect(isStoreBuildVariant({ ELIZA_BUILD_VARIANT: "STORE" })).toBe(true);
      expect(isStoreBuildVariant({ ELIZA_BUILD_VARIANT: "  store  " })).toBe(
        true,
      );
      expect(isStoreBuildVariant({ ELIZA_BUILD_VARIANT: "direct" })).toBe(
        false,
      );
      expect(isStoreBuildVariant({})).toBe(false);
    });
  });

  describe("findMacAppBundleRoot", () => {
    it("extracts root .app path from nested macOS bundle paths", () => {
      const execPath = "/Applications/Eliza.app/Contents/MacOS/eliza";
      expect(findMacAppBundleRoot(execPath)).toBe("/Applications/Eliza.app");

      const deeplyNested =
        "/Users/user/Applications/Eliza.app/Contents/Resources/app.asar/node_modules/lib.dylib";
      expect(findMacAppBundleRoot(deeplyNested)).toBe(
        "/Users/user/Applications/Eliza.app",
      );
    });

    it("returns null for non-bundle paths and undefined", () => {
      expect(findMacAppBundleRoot("/usr/local/bin/node")).toBeNull();
      expect(findMacAppBundleRoot(undefined)).toBeNull();
      expect(findMacAppBundleRoot("")).toBeNull();
    });
  });

  describe("isWithinPath", () => {
    it("returns true when child is within parent path", () => {
      expect(isWithinPath("/app", "/app/lib.dylib")).toBe(true);
      expect(isWithinPath("/app", "/app/sub/nested/lib.dylib")).toBe(true);
      expect(isWithinPath("/app", "/app")).toBe(true);
    });

    it("returns false when child is outside parent path", () => {
      expect(isWithinPath("/app", "/other/lib.dylib")).toBe(false);
      expect(isWithinPath("/app", "/app-other/lib.dylib")).toBe(false);
    });
  });

  describe("resolveNativeLibraryCandidate", () => {
    const existingFile = path.resolve(process.cwd(), "package.json");

    it("returns null for empty or whitespace-only candidate paths", () => {
      expect(
        resolveNativeLibraryCandidate(
          { path: "   " },
          { expectedBasename: "lib.dylib" },
        ),
      ).toBeNull();
    });

    it("warns and returns null for relative path when moduleDir is missing", () => {
      const warn = vi.fn();
      const result = resolveNativeLibraryCandidate(
        { path: "./lib.dylib", label: "test-lib" },
        { expectedBasename: "lib.dylib", warn },
      );

      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "cannot be resolved without a module directory",
        ),
      );
    });

    it("returns null for non-existent candidate file", () => {
      const result = resolveNativeLibraryCandidate(
        { path: "/non/existent/path/lib.dylib" },
        { expectedBasename: "lib.dylib" },
      );
      expect(result).toBeNull();
    });

    it("resolves existing file directly for non-store build variant", () => {
      const result = resolveNativeLibraryCandidate(
        { path: existingFile },
        { expectedBasename: "package.json" },
      );
      expect(result).toBeDefined();
      expect(result).toContain("package.json");
    });

    it("rejects candidate in store build if basename does not match expected", () => {
      const warn = vi.fn();
      const result = resolveNativeLibraryCandidate(
        { path: existingFile },
        {
          expectedBasename: "expected.dylib",
          env: { ELIZA_BUILD_VARIANT: "store" },
          warn,
        },
      );

      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("for store build: expected expected.dylib"),
      );
    });

    it("rejects candidate in store build if no trusted app bundle root is found", () => {
      const warn = vi.fn();
      const result = resolveNativeLibraryCandidate(
        { path: existingFile },
        {
          expectedBasename: "package.json",
          env: { ELIZA_BUILD_VARIANT: "store" },
          execPath: "/usr/local/bin/node",
          warn,
        },
      );

      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("no trusted .app bundle root was found"),
      );
    });
  });
});
