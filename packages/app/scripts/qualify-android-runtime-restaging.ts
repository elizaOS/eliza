#!/usr/bin/env node
/** Exercises real pinned runtime restaging and AGP asset merging in an isolated host. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import {
  selectAndroidRuntimeTargets,
  stageAndroidAgentRuntime,
} from "./lib/stage-android-agent.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
const platform = path.join(repo, "packages/app/platforms/android");
const output = testOutputPath("android-runtime-restaging", String(Date.now()));
const androidDir = path.join(output, "android");
const assets = path.join(androidDir, "app/src/main/assets");
const agent = path.join(assets, "agent");
const knownAbis = selectAndroidRuntimeTargets(undefined).map(
  (t) => t.androidAbi,
);
const stages: Array<{
  selection: string;
  stagedAbis: string[];
  excludedAbis: string[];
  modelSha256: string;
}> = [];
const sha = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const report = {
  status: "failed",
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim(),
  sourceFiles: [
    "packages/app/scripts/lib/stage-android-agent.ts",
    "packages/app/platforms/android/runtime-abis.gradle",
  ].map((file) => ({ file, sha256: sha(path.join(repo, file)) })),
  deviceExecuted: false,
  stages,
};
const write = (name: string, text: string) => {
  const target = path.join(androidDir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
};

console.log(`Runtime restaging evidence: ${output}`);
// This lane needs the built mobile bundle, pinned runtime caches, Android SDK
// and Java. It runs no app build and never touches the product's staged assets.
write(
  "settings.gradle",
  "rootProject.name = 'runtime-restaging'\ninclude ':app'\n",
);
write(
  "build.gradle",
  `buildscript {
    repositories { google(); mavenCentral() }
    dependencies { classpath 'com.android.tools.build:gradle:8.13.0' }
}
`,
);
write(
  "app/build.gradle",
  `apply plugin: 'com.android.application'
android {
    namespace 'ai.elizaos.runtime.restaging'
    compileSdk 36
    defaultConfig { minSdk 26 }
}
apply from: ${JSON.stringify(path.join(platform, "runtime-abis.gradle"))}
tasks.register('assertRuntimeSelection') {
    doLast {
        def configured = System.getenv('ELIZA_ANDROID_TARGET_ABIS')
        def expected = configured == null ? [] : configured.split(',').toList()
        assert android.defaultConfig.ndk.abiFilters == expected.toSet()
    }
}
`,
);
write(
  "app/src/main/AndroidManifest.xml",
  '<manifest xmlns:android="http://schemas.android.com/apk/res/android"/>\n',
);
write("app/src/main/assets/unrelated/x86_64/keep.txt", "host-owned asset\n");
write("app/src/main/jniLibs/x86_64/host-owned.so", "host-owned library\n");
const hostAsset = path.join(assets, "unrelated/x86_64/keep.txt");
const hostLibrary = path.join(
  androidDir,
  "app/src/main/jniLibs/x86_64/host-owned.so",
);
const expectedHostAsset = sha(hostAsset);
const expectedHostLibrary = sha(hostLibrary);
let expectedModel: string | undefined;

try {
  for (const [index, selection] of [
    "arm64-v8a,x86_64",
    "arm64-v8a",
    "x86_64",
    "arm64-v8a,x86_64",
    undefined,
  ].entries()) {
    if (selection === undefined) delete process.env.ELIZA_ANDROID_TARGET_ABIS;
    else process.env.ELIZA_ANDROID_TARGET_ABIS = selection;
    await stageAndroidAgentRuntime({
      androidDir,
      spikeDir: path.join(repo, "packages/app/scripts/aosp"),
    });
    const expected = selectAndroidRuntimeTargets(selection).map(
      (t) => t.androidAbi,
    );
    const actual = knownAbis.filter((abi) =>
      fs.existsSync(path.join(agent, abi, "bun")),
    );
    for (const abi of knownAbis.filter((abi) => !expected.includes(abi))) {
      assert(!fs.existsSync(path.join(agent, abi)));
    }
    for (const abi of expected.filter((abi) => abi !== "riscv64")) {
      assert(fs.statSync(path.join(agent, abi, "bun")).size > 0);
    }
    assert.equal(sha(hostAsset), expectedHostAsset);
    assert.equal(sha(hostLibrary), expectedHostLibrary);
    const model = path.join(agent, "models/bge-small-en-v1.5-f16.gguf");
    expectedModel ??= sha(model);
    assert.equal(sha(model), expectedModel);

    const provenancePath = path.join(
      agent,
      "android-agent-runtime-provenance.json",
    );
    const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
    fs.copyFileSync(
      provenancePath,
      path.join(output, `runtime-provenance-${index}.json`),
    );
    for (const file of provenance.files) {
      const stagedPath = file.path.replace(/^lib\//, "jniLibs/");
      assert.equal(
        sha(path.join(androidDir, "app/src/main", stagedPath)),
        file.sha256,
      );
    }

    // Reintroduce stale assets after staging to independently test the Gradle
    // filter. Keep them in the source tree until the next real staging pass.
    const excluded = knownAbis.filter((abi) => !expected.includes(abi));
    for (const abi of excluded)
      write(`app/src/main/assets/agent/${abi}/stale-payload`, "excluded ABI\n");
    const result = spawnSync(
      path.join(platform, "gradlew"),
      [
        "-p",
        androidDir,
        "--offline",
        "--no-daemon",
        "--max-workers=1",
        "-Dorg.gradle.jvmargs=-Xmx1g",
        ":app:mergeDebugAssets",
        ":app:assertRuntimeSelection",
      ],
      { env: process.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    fs.writeFileSync(
      path.join(output, `gradle-${index}.log`),
      `${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
    if (result.error) throw result.error;
    assert.equal(
      result.status,
      0,
      `Gradle failed; see ${output}/gradle-${index}.log`,
    );
    const merged = path.join(
      androidDir,
      "app/build/intermediates/assets/debug/mergeDebugAssets",
    );
    for (const abi of excluded) {
      assert(!fs.existsSync(path.join(merged, "agent", abi)));
      assert(fs.existsSync(path.join(agent, abi, "stale-payload")));
    }
    for (const abi of actual)
      assert.equal(
        sha(path.join(merged, "agent", abi, "bun")),
        sha(path.join(agent, abi, "bun")),
      );
    // Default selection retains all ABI directories, including an unavailable
    // RISC-V slice left from a prior stage; it must not introduce filtering.
    if (selection === undefined) {
      assert(fs.existsSync(path.join(merged, "agent/riscv64/stale-payload")));
    }
    assert.equal(
      sha(path.join(merged, "agent/models/bge-small-en-v1.5-f16.gguf")),
      expectedModel,
    );
    assert.equal(
      sha(path.join(merged, "unrelated/x86_64/keep.txt")),
      expectedHostAsset,
    );
    report.stages.push({
      selection: selection ?? "default",
      stagedAbis: actual,
      excludedAbis: excluded,
      modelSha256: expectedModel,
    });
  }
  report.status = "passed";
} finally {
  fs.writeFileSync(
    path.join(output, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
