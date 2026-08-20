/**
 * Regression guard for #15106: the android-cloud target must not ship a Java
 * source that still references the removed on-device ElizaAgentService.
 *
 * `auditAndroidCloudSource` fails the pre-gradle audit when any surviving
 * main-sourceset `.java` file references `ElizaAgentService`. The strip step
 * (ANDROID_CLOUD_STRIPPED_JAVA_FILES removal + rewriteCloudJavaSources
 * rewrite/delete of ANDROID_CLOUD_REWRITTEN_JAVA_FILES) is what makes that true.
 * If a new agent-service helper lands in committed source without being added to
 * one of those two lists, the cloud build breaks — exactly the way
 * ElizaAssetExtractionPolicy.java + ElizaBionicInferenceServer.java broke it.
 *
 * This test scans the real committed android source tree (no device, no gradle)
 * and asserts every ElizaAgentService-referencing main source is accounted for.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ANDROID_CLOUD_REWRITTEN_JAVA_FILES,
  ANDROID_CLOUD_STRIPPED_JAVA_FILES,
  ANDROID_CLOUD_STRIPPED_TEST_JAVA_FILES,
} from "./run-mobile-build.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const androidMainJavaRoot = path.resolve(
  scriptsDir,
  "../platforms/android/app/src/main/java/ai/elizaos/app",
);
const androidTestJavaRoot = path.resolve(
  scriptsDir,
  "../platforms/android/app/src/test/java/ai/elizaos/app",
);

/** Every committed main-sourceset .java basename that references ElizaAgentService. */
function collectAgentServiceReferencingSources() {
  const referencing = [];
  const entries = fs.existsSync(androidMainJavaRoot)
    ? fs.readdirSync(androidMainJavaRoot, { withFileTypes: true })
    : [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".java")) continue;
    const source = fs.readFileSync(
      path.join(androidMainJavaRoot, entry.name),
      "utf8",
    );
    if (source.includes("ElizaAgentService")) {
      referencing.push(entry.name);
    }
  }
  return referencing.sort();
}

describe("android-cloud ElizaAgentService strip coverage (#15106)", () => {
  it("keeps the strip and rewrite lists disjoint", () => {
    const stripped = new Set(ANDROID_CLOUD_STRIPPED_JAVA_FILES);
    const overlap = ANDROID_CLOUD_REWRITTEN_JAVA_FILES.filter((file) =>
      stripped.has(file),
    );
    expect(overlap).toEqual([]);
  });

  it("removes the on-device asset-extraction + bionic inference helpers", () => {
    // The exact files whose survival broke `build:android:cloud` in #15106.
    expect(ANDROID_CLOUD_STRIPPED_JAVA_FILES).toContain(
      "ElizaAssetExtractionPolicy.java",
    );
    expect(ANDROID_CLOUD_STRIPPED_JAVA_FILES).toContain(
      "ElizaBionicInferenceServer.java",
    );
  });

  it("accounts for every committed ElizaAgentService-referencing main source", () => {
    expect(fs.existsSync(androidMainJavaRoot)).toBe(true);
    const referencing = collectAgentServiceReferencingSources();

    const stripped = new Set(ANDROID_CLOUD_STRIPPED_JAVA_FILES);
    const rewritten = new Set(ANDROID_CLOUD_REWRITTEN_JAVA_FILES);

    const unaccounted = referencing.filter(
      (file) => !stripped.has(file) && !rewritten.has(file),
    );

    // Every surviving reference to the removed service must be removed (strip)
    // or rewritten to compile without it (rewrite) for the cloud target, or
    // auditAndroidCloudSource rejects the tree.
    expect(unaccounted).toEqual([]);
  });

  it("accounts for every JVM test that references source-stripped runtime code", () => {
    const strippedClassNames = ANDROID_CLOUD_STRIPPED_JAVA_FILES.map((file) =>
      file.replace(/\.java$/, ""),
    );
    const testEntries = fs.existsSync(androidTestJavaRoot)
      ? fs.readdirSync(androidTestJavaRoot, { withFileTypes: true })
      : [];
    const testFiles = testEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".java"))
      .map((entry) => entry.name)
      .sort();
    const referencesStrippedCode = testFiles.filter((file) => {
      const source = fs.readFileSync(
        path.join(androidTestJavaRoot, file),
        "utf8",
      );
      return strippedClassNames.some((className) =>
        new RegExp(`\\b${className}\\b`).test(source),
      );
    });

    const strippedTests = new Set(ANDROID_CLOUD_STRIPPED_TEST_JAVA_FILES);
    const unaccounted = referencesStrippedCode.filter(
      (file) => !strippedTests.has(file),
    );

    // A fully Play-safe committed tree may contain none of these tests, while
    // the strip list must remain ready for a regenerated upstream platform.
    expect(unaccounted).toEqual([]);
  });
});
