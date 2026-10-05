import { describe, expect, test } from "bun:test";
import { shouldKeepPackageRelativePath } from "./copy-runtime-node-modules";

describe("Capacitor Android runtime packaging", () => {
  test("excludes generated Gradle outputs but retains shipped source and metadata", () => {
    const keep = (path: string) =>
      shouldKeepPackageRelativePath(path, "linux", "x64", "@capacitor/android");
    expect(keep("capacitor/build")).toBe(false);
    expect(
      keep("capacitor/build/.transforms/abc/transformed/classes.dex"),
    ).toBe(false);
    for (const path of [
      "package.json",
      "LICENSE",
      "capacitor/build.gradle",
      "capacitor/src/main/java/com/getcapacitor/Bridge.java",
    ]) {
      expect(keep(path)).toBe(true);
    }
  });
  test("does not exclude unrelated runtime build directories", () => {
    expect(
      shouldKeepPackageRelativePath(
        "capacitor/build/runtime.js",
        "linux",
        "x64",
        "another-package",
      ),
    ).toBe(true);
    expect(
      shouldKeepPackageRelativePath(
        "build/index.js",
        "linux",
        "x64",
        "@capacitor/android",
      ),
    ).toBe(true);
  });
});
