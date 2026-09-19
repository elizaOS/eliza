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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
    const referencing = collectAgentServiceReferencingSources();

    // Sanity: the source tree really does have such files (guards against a
    // silently-empty scan, e.g. a moved android path, turning this green).
    expect(referencing.length).toBeGreaterThan(0);
    expect(referencing).toContain("ElizaAgentService.java");

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
    const testRoots = [
      androidTestJavaRoot,
      path.resolve(
        scriptsDir,
        "../platforms/android/app/src/androidTest/java/ai/elizaos/app",
      ),
    ];
    const referencesStrippedCode = testRoots
      .flatMap((root) =>
        fs
          .readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".java"))
          .filter((entry) => {
            const source = fs.readFileSync(path.join(root, entry.name), "utf8");
            return strippedClassNames.some((name) =>
              new RegExp(`\\b${name}\\b`).test(source),
            );
          })
          .map((entry) => entry.name),
      )
      .sort();

    expect([...ANDROID_CLOUD_STRIPPED_TEST_JAVA_FILES].sort()).toEqual(
      referencesStrippedCode,
    );
  });
});

it("removes BGE runtime and its instrumented tests from an actual cloud source tree while retaining local source", () => {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-cloud-bge-strip-"),
  );
  try {
    const app = path.join(fixture, "packages", "app");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(
      path.join(app, "package.json"),
      '{"name":"fixture","type":"module"}',
    );
    fs.writeFileSync(
      path.join(app, "app.config.ts"),
      'export default { appId: "ai.elizaos.app", appName: "Fixture" };',
    );
    const local = path.join(fixture, "local");
    const cloud = path.join(app, "android");
    const configPath = path.join(
      cloud,
      "app/src/main/assets/capacitor.config.json",
    );
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        appId: "ai.elizaos.app",
        appName: "Fixture",
        webDir: "dist",
      }),
    );

    const files = [
      ["main", "BgeEmbeddingSession.java"],
      ["main", "ElizaVoiceNative.java"],
      ["main", "ElizaBionicInferenceServer.java"],
      ["test", "BgeEmbeddingSessionTest.java"],
      ["androidTest", "BionicEmbeddingInstrumentedTest.java"],
    ];
    for (const [sourceSet, name] of files) {
      const relative = path.join(
        "app",
        "src",
        sourceSet,
        "java",
        "ai",
        "elizaos",
        "app",
        name,
      );
      const original = path.resolve(
        scriptsDir,
        "../platforms/android",
        relative,
      );
      for (const target of [local, cloud]) {
        fs.mkdirSync(path.dirname(path.join(target, relative)), {
          recursive: true,
        });
        fs.copyFileSync(original, path.join(target, relative));
      }
    }
    const keep = path.join(
      cloud,
      "app/src/androidTest/java/ai/elizaos/app/CloudIndependentTest.java",
    );
    fs.writeFileSync(keep, "final class CloudIndependentTest {}\n");
    const module = new URL("./mobile/android/strip.mjs", import.meta.url).href;
    const context = new URL("./mobile/context.mjs", import.meta.url).href;
    execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
      import { androidDir } from ${JSON.stringify(context)};
      import { stripAndroidForCloud } from ${JSON.stringify(module)};
      if (androidDir !== ${JSON.stringify(cloud)}) throw new Error("Unsafe fixture path");
      stripAndroidForCloud();
    `,
      ],
      {
        env: {
          ...process.env,
          ELIZA_MOBILE_REPO_ROOT: fixture,
          ELIZA_ANDROID_USE_APP_DIR: "1",
        },
        timeout: 30000,
      },
    );
    for (const [sourceSet, name] of files) {
      const relative = path.join(
        "app",
        "src",
        sourceSet,
        "java",
        "ai",
        "elizaos",
        "app",
        name,
      );
      expect(fs.existsSync(path.join(cloud, relative))).toBe(false);
      expect(fs.readFileSync(path.join(local, relative), "utf8")).toBe(
        fs.readFileSync(
          path.resolve(scriptsDir, "../platforms/android", relative),
          "utf8",
        ),
      );
    }
    expect(fs.readFileSync(keep, "utf8")).toContain("CloudIndependentTest");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
