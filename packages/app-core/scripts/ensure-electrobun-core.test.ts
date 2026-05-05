import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getElectrobunCoreDistDir,
  getElectrobunCoreTarballUrl,
  getRequiredElectrobunCoreRelativePaths,
  normalizeElectrobunCoreTarget,
} from "./ensure-electrobun-core.mjs";

describe("ensure-electrobun-core", () => {
  it.each([
    ["macos-arm64", "macos-arm64"],
    ["macos-x64", "macos-x64"],
    ["linux-x64", "linux-x64"],
    ["linux-arm64", "linux-arm64"],
    ["windows-x64", "win-x64"],
    ["win-x64", "win-x64"],
  ])("normalizes %s to Electrobun core target %s", (input, expected) => {
    expect(normalizeElectrobunCoreTarget(input).id).toBe(expected);
  });

  it("tracks the macOS files that suppress Electrobun lazy core downloads", () => {
    const target = normalizeElectrobunCoreTarget("macos-arm64");

    expect(getRequiredElectrobunCoreRelativePaths(target)).toEqual([
      "bun",
      "bsdiff",
      "bspatch",
      "launcher",
      "libNativeWrapper.dylib",
    ]);
  });

  it("derives the same dist directory and tarball URL shape Electrobun uses", () => {
    const target = normalizeElectrobunCoreTarget("windows-x64");

    expect(getElectrobunCoreDistDir("/deps/electrobun", target)).toBe(
      path.join("/deps/electrobun", "dist-win-x64"),
    );
    expect(getElectrobunCoreTarballUrl("1.16.0", target)).toBe(
      "https://github.com/blackboardsh/electrobun/releases/download/v1.16.0/electrobun-core-win-x64.tar.gz",
    );
  });
});
