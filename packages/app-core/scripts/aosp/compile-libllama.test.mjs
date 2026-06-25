import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  resolveAndroidNdkHostDir,
  resolveHomebrewFormulaIncludeDirs,
} from "./compile-libllama.mjs";

const tmpDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compile-libllama-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe("compile-libllama Android Vulkan host resolution", () => {
  test("uses the current OS host prebuilt instead of hardcoded linux", () => {
    const prebuiltRoot = makeTmpDir();
    fs.mkdirSync(path.join(prebuiltRoot, "darwin-x86_64"));
    fs.mkdirSync(path.join(prebuiltRoot, "linux-x86_64"));

    expect(
      resolveAndroidNdkHostDir(prebuiltRoot, {
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe("darwin-x86_64");
  });

  test("does not select a prebuilt for the wrong host OS", () => {
    const prebuiltRoot = makeTmpDir();
    fs.mkdirSync(path.join(prebuiltRoot, "linux-x86_64"));

    expect(
      resolveAndroidNdkHostDir(prebuiltRoot, {
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBeNull();
  });

  test("expands Homebrew opt and versioned Cellar include roots", () => {
    const prefix = makeTmpDir();
    fs.mkdirSync(path.join(prefix, "Cellar", "vulkan-headers", "1.3.290"), {
      recursive: true,
    });

    expect(
      resolveHomebrewFormulaIncludeDirs("vulkan-headers", [prefix]),
    ).toEqual([
      path.join(prefix, "opt", "vulkan-headers", "include"),
      path.join(prefix, "Cellar", "vulkan-headers", "1.3.290", "include"),
    ]);
  });
});
