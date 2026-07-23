/**
 * Exercises Cloud AAB policy inspection at the bundletool process boundary
 * with deterministic manifest and DEX payloads.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { unzipSync, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import {
  ANDROID_BUNDLETOOL_JAR_ENV,
  ANDROID_BUNDLETOOL_SHA256,
  ANDROID_BUNDLETOOL_URL,
  ANDROID_BUNDLETOOL_VERSION,
  ensureAndroidBundletoolJar,
  inspectAndroidAppBundle,
  listAabDexEntries,
  listAabManifestModules,
  resolveAndroidArtifactKind,
} from "./lib/android-cloud-artifact-audit.mjs";
import {
  assertAndroidArtifactOmitsLp3ManifestMarkers,
  auditAndroidArtifactDexLp3Policy,
  auditAndroidCloudArtifact,
  dumpAndroidArtifactBadging,
  dumpAndroidArtifactManifest,
} from "./run-mobile-build.mjs";

const ARTIFACT = "/artifacts/app-release.aab";
const BUNDLETOOL_JAR = "/tools/bundletool-all.jar";
const JAVA_HOME = "/jdk";
const CLEAN_MANIFEST =
  '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.INTERNET"/><application/></manifest>';
const BASE_ENTRIES = [
  "base/manifest/AndroidManifest.xml",
  "base/dex/classes.dex",
];
const MULTI_MODULE_ENTRIES = [
  "feature/dex/classes2.dex",
  "base/dex/classes.dex",
  "feature/manifest/AndroidManifest.xml",
  "base/manifest/AndroidManifest.xml",
  "BundleConfig.pb",
];
const ANDROID_APP_GRADLE = fs.readFileSync(
  new URL("../platforms/android/app/build.gradle", import.meta.url),
  "utf8",
);
const REAL_AAB_FIXTURE = fileURLToPath(
  new URL(
    "../test/fixtures/android/install-time-permanent-modules.aab",
    import.meta.url,
  ),
);
const REAL_AAB_PACKAGE = "com.google.android.samples.dynamicfeatures.ondemand";
const RUN_REAL_AAB_TEST = process.env.ELIZA_ANDROID_RUN_REAL_AAB_TEST === "1";
const describeRealAab = RUN_REAL_AAB_TEST ? describe : describe.skip;

function successfulToolHarness(
  manifests = new Map([["base", CLEAN_MANIFEST]]),
) {
  const calls = [];
  const spawnSyncImpl = vi.fn((command, args, options) => {
    calls.push({ args, command, options });
    const subcommand = args[2];
    if (subcommand === "validate") {
      return {
        signal: null,
        status: 0,
        stderr: "",
        stdout: "App Bundle information\n",
      };
    }
    if (subcommand === "dump" && args[3] === "manifest") {
      const moduleName = args
        .find((argument) => argument.startsWith("--module="))
        ?.slice("--module=".length);
      return {
        signal: null,
        status: 0,
        stderr: "",
        stdout: manifests.get(moduleName) ?? "",
      };
    }
    throw new Error(`Unexpected bundletool command: ${args.join(" ")}`);
  });

  return {
    calls,
    deps: {
      existsSync: () => true,
      platform: "linux",
      resolvePath: (value) => value,
      spawnSyncImpl,
    },
    spawnSyncImpl,
  };
}

function inspectOptions({
  entries = BASE_ENTRIES,
  env = { [ANDROID_BUNDLETOOL_JAR_ENV]: BUNDLETOOL_JAR },
  readDexEntries = (dexEntries) =>
    dexEntries.map(() => Buffer.from("clean dex", "utf8")),
  strippedComponents = ["ElizaAgentService"],
  strippedPermissions = ["WRITE_SECURE_SETTINGS"],
} = {}) {
  return {
    appId: "ai.elizaos.app",
    artifact: ARTIFACT,
    entries,
    env,
    javaHome: JAVA_HOME,
    readDexEntries,
    strippedComponents,
    strippedPermissions,
  };
}

function readRealAab(artifact) {
  return unzipSync(new Uint8Array(fs.readFileSync(artifact)));
}

function realAabInspectionOptions(artifact, archive = readRealAab(artifact)) {
  const entries = Object.keys(archive);
  return {
    appId: REAL_AAB_PACKAGE,
    artifact,
    entries,
    env: {
      [ANDROID_BUNDLETOOL_JAR_ENV]: process.env[ANDROID_BUNDLETOOL_JAR_ENV],
    },
    javaHome: process.env.JAVA_HOME,
    readDexEntries: (dexEntries) =>
      dexEntries.map((entry) => Buffer.from(archive[entry])),
    strippedComponents: [],
    strippedPermissions: [],
  };
}

function writeMutatedRealAab(temporaryDir, name, mutate) {
  const archive = readRealAab(REAL_AAB_FIXTURE);
  mutate(archive);
  const artifact = path.join(temporaryDir, name);
  fs.writeFileSync(artifact, zipSync(archive, { level: 6 }));
  return { archive, artifact };
}

describe("Android App Bundle entry discovery", () => {
  it("distinguishes APKs and AABs and rejects other artifact types", () => {
    expect(resolveAndroidArtifactKind("/artifacts/app-debug.APK")).toBe("apk");
    expect(resolveAndroidArtifactKind(ARTIFACT)).toBe("aab");
    expect(() =>
      resolveAndroidArtifactKind("/artifacts/app-release.zip"),
    ).toThrow("must end in .apk or .aab");
  });

  it("orders base first and includes every feature manifest and DEX", () => {
    expect(listAabManifestModules(MULTI_MODULE_ENTRIES)).toEqual([
      "base",
      "feature",
    ]);
    expect(listAabDexEntries(MULTI_MODULE_ENTRIES)).toEqual([
      "base/dex/classes.dex",
      "feature/dex/classes2.dex",
    ]);
  });

  it("rejects bundles without a base manifest", () => {
    expect(() =>
      listAabManifestModules([
        "feature/manifest/AndroidManifest.xml",
        "feature/dex/classes.dex",
      ]),
    ).toThrow("missing base/manifest/AndroidManifest.xml");
  });

  it("rejects traversal-shaped module paths selected for inspection", () => {
    expect(() =>
      listAabManifestModules([
        "../manifest/AndroidManifest.xml",
        "base/manifest/AndroidManifest.xml",
      ]),
    ).toThrow("unsafe module name");
  });
});

describeRealAab("real multi-module bundletool regression", () => {
  it("validates and inspects every real module manifest and DEX", async () => {
    const bundletoolJar = await ensureAndroidBundletoolJar({
      env: process.env,
    });
    expect(bundletoolJar).toBe(
      path.resolve(process.env[ANDROID_BUNDLETOOL_JAR_ENV]),
    );

    expect(
      inspectAndroidAppBundle(realAabInspectionOptions(REAL_AAB_FIXTURE)),
    ).toEqual({
      dexEntries: [
        "base/dex/classes.dex",
        "initialInstall/dex/classes.dex",
        "java/dex/classes.dex",
      ],
      modules: ["base", "assets", "initialInstall", "java"],
    });
  });

  it("rejects a stripped component declared by a real dynamic feature", () => {
    expect(() =>
      inspectAndroidAppBundle({
        ...realAabInspectionOptions(REAL_AAB_FIXTURE),
        strippedComponents: ["JavaSampleActivity"],
      }),
    ).toThrow(
      // bundletool's base dump is merged and identifies this declaration with
      // android:splitName="java"; the java module dump contains it as well.
      `module base contains forbidden component: ${REAL_AAB_PACKAGE}.JavaSampleActivity`,
    );
  });

  it("rejects a forbidden marker found only in a real feature DEX", () => {
    const temporaryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-real-aab-dex-"),
    );
    try {
      const { archive, artifact } = writeMutatedRealAab(
        temporaryDir,
        "feature-dex-marker.aab",
        (entries) => {
          const dexEntry = "java/dex/classes.dex";
          entries[dexEntry] = Buffer.concat([
            Buffer.from(entries[dexEntry]),
            Buffer.from("lp3_color_policy", "utf8"),
          ]);
        },
      );

      expect(() =>
        inspectAndroidAppBundle(realAabInspectionOptions(artifact, archive)),
      ).toThrow(
        "java/dex/classes.dex contains forbidden LP3 marker: lp3_color_policy",
      );
    } finally {
      fs.rmSync(temporaryDir, { force: true, recursive: true });
    }
  });

  it("rejects a truncated real bundle before policy inspection", () => {
    const temporaryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-real-aab-truncated-"),
    );
    try {
      const bytes = fs.readFileSync(REAL_AAB_FIXTURE);
      const artifact = path.join(temporaryDir, "truncated.aab");
      fs.writeFileSync(artifact, bytes.subarray(0, bytes.length / 2));

      expect(() =>
        inspectAndroidAppBundle({
          ...realAabInspectionOptions(REAL_AAB_FIXTURE),
          artifact,
        }),
      ).toThrow(/Could not validate .* with bundletool failed/);
    } finally {
      fs.rmSync(temporaryDir, { force: true, recursive: true });
    }
  });
});

describe("pinned bundletool provisioning", () => {
  it("preserves an explicitly configured checksum-pinned official JAR", async () => {
    const fetchImpl = vi.fn();

    await expect(
      ensureAndroidBundletoolJar(
        {
          env: { [ANDROID_BUNDLETOOL_JAR_ENV]: BUNDLETOOL_JAR },
        },
        {
          digestBuffer: () => ANDROID_BUNDLETOOL_SHA256,
          existsSync: () => true,
          fetchImpl,
          readFileSync: () => Buffer.from("official bundletool fixture"),
        },
      ),
    ).resolves.toBe(path.resolve(BUNDLETOOL_JAR));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an explicitly configured JAR with the wrong checksum", async () => {
    await expect(
      ensureAndroidBundletoolJar(
        {
          env: { [ANDROID_BUNDLETOOL_JAR_ENV]: BUNDLETOOL_JAR },
        },
        {
          digestBuffer: () => "bad-digest",
          existsSync: () => true,
          readFileSync: () => Buffer.from("tampered"),
        },
      ),
    ).rejects.toThrow(`expected ${ANDROID_BUNDLETOOL_SHA256}`);
  });

  it("downloads and atomically caches the checksum-pinned official JAR", async () => {
    const bytes = Buffer.from("official bundletool fixture", "utf8");
    const fetchImpl = vi.fn(async () => ({
      arrayBuffer: async () => bytes,
      ok: true,
      status: 200,
      statusText: "OK",
    }));
    const mkdirSync = vi.fn();
    const writeFileSync = vi.fn();
    const renameSync = vi.fn();
    const rmSync = vi.fn();
    const cacheDir = "/cache/bundletool";
    const target = path.join(
      cacheDir,
      `bundletool-all-${ANDROID_BUNDLETOOL_VERSION}-${ANDROID_BUNDLETOOL_SHA256}.jar`,
    );

    await expect(
      ensureAndroidBundletoolJar(
        { cacheDir, env: {} },
        {
          digestBuffer: () => ANDROID_BUNDLETOOL_SHA256,
          existsSync: () => false,
          fetchImpl,
          mkdirSync,
          renameSync,
          rmSync,
          writeFileSync,
        },
      ),
    ).resolves.toBe(target);
    expect(fetchImpl).toHaveBeenCalledWith(ANDROID_BUNDLETOOL_URL, {
      redirect: "follow",
      signal: expect.any(AbortSignal),
    });
    expect(mkdirSync).toHaveBeenCalledWith(cacheDir, { recursive: true });
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(`${target}.`),
      bytes,
      { flag: "wx" },
    );
    expect(renameSync).toHaveBeenCalledWith(
      expect.stringContaining(`${target}.`),
      target,
    );
  });

  it("rejects downloaded bytes that do not match the pinned checksum", async () => {
    const fetchImpl = vi.fn(async () => ({
      arrayBuffer: async () => Buffer.from("tampered"),
      ok: true,
      status: 200,
      statusText: "OK",
    }));

    await expect(
      ensureAndroidBundletoolJar(
        { cacheDir: "/cache/bundletool", env: {} },
        {
          digestBuffer: () => "bad-digest",
          existsSync: () => false,
          fetchImpl,
        },
      ),
    ).rejects.toThrow(`expected ${ANDROID_BUNDLETOOL_SHA256}`);
  });

  it("wires every Cloud bundleRelease output through the audit-only command", () => {
    expect(ANDROID_APP_GRADLE).toContain(
      "project.findProperty('elizaCloudBuild') == 'true'",
    );
    expect(ANDROID_APP_GRADLE).toMatch(
      /tasks\.matching \{ it\.name == 'bundleRelease' \}[\s\S]*tasks\.register\('auditCloudReleaseAab'\)/,
    );
    expect(ANDROID_APP_GRADLE).toContain("outputs.upToDateWhen { false }");
    expect(ANDROID_APP_GRADLE).toContain(
      "bundleTask.finalizedBy(auditCloudReleaseAab)",
    );
    expect(ANDROID_APP_GRADLE).not.toContain("bundleTask.doLast");
    expect(ANDROID_APP_GRADLE).toContain("bundleTask.state.executed");
    expect(ANDROID_APP_GRADLE).toContain("bundleTask.state.failure == null");
    expect(ANDROID_APP_GRADLE).toContain("providers.exec {");
    expect(ANDROID_APP_GRADLE).not.toContain("project.exec {");
    expect(ANDROID_APP_GRADLE).toContain(
      ".file('outputs/bundle/release/app-release.aab')",
    );
    expect(ANDROID_APP_GRADLE).toContain("bundleArtifact.absolutePath");
    expect(ANDROID_APP_GRADLE).toContain(
      "auditOutput.standardOutput.asText.get()",
    );
    expect(ANDROID_APP_GRADLE).toContain(
      "auditOutput.standardError.asText.get()",
    );
    expect(ANDROID_APP_GRADLE).toContain("'android-cloud-audit'");
  });
});

describe("Android APK audit regression contract", () => {
  it("fails on the exact explicitly requested release artifact path", () => {
    const requestedArtifact = "/artifacts/requested-does-not-exist.aab";

    expect(() =>
      auditAndroidCloudArtifact({ artifact: requestedArtifact }),
    ).toThrow(
      `requested android-cloud artifact does not exist: ${path.resolve(requestedArtifact)}`,
    );
  });

  it("keeps the exact AAPT badging and manifest commands for APKs", () => {
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stderr: "",
        stdout: "package: name='ai.elizaos.app'",
      })
      .mockReturnValueOnce({
        status: 0,
        stderr: "",
        stdout: "E: manifest",
      });
    const apk = "/artifacts/app-debug.apk";

    expect(
      dumpAndroidArtifactBadging("/sdk/aapt", apk, { spawnSyncImpl }),
    ).toContain("ai.elizaos.app");
    expect(
      dumpAndroidArtifactManifest("/sdk/aapt", apk, { spawnSyncImpl }),
    ).toBe("E: manifest");
    expect(spawnSyncImpl.mock.calls).toEqual([
      [
        "/sdk/aapt",
        ["dump", "badging", apk],
        {
          encoding: "utf8",
        },
      ],
      [
        "/sdk/aapt",
        ["dump", "xmltree", apk, "AndroidManifest.xml"],
        {
          encoding: "utf8",
        },
      ],
    ]);
  });

  it("keeps scanning APK DEX and rejects private LP3 markers", () => {
    const readEntryBuffers = vi.fn(() => [
      Buffer.from("ai.elizaos.app.action.ENABLE_LP3_COLOR_POLICY", "utf8"),
    ]);

    expect(() =>
      auditAndroidArtifactDexLp3Policy(
        "/artifacts/app-debug.apk",
        ["classes.dex"],
        JAVA_HOME,
        {
          debug: true,
          expectedPresent: false,
        },
        { readEntryBuffers },
      ),
    ).toThrow("artifact DEX still contains LP3 policy markers");
    expect(readEntryBuffers).toHaveBeenCalledWith(
      "/artifacts/app-debug.apk",
      ["classes.dex"],
      JAVA_HOME,
      { label: "LP3 policy DEX audit" },
    );
  });

  it("keeps ordinary AOSP shared permissions while rejecting its LP3-only delta", () => {
    const sharedPermissions = [
      "android.permission.RECEIVE_BOOT_COMPLETED",
      "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
    ].join("\n");
    const options = {
      label: "ordinary AOSP",
      permissions: ["WRITE_SECURE_SETTINGS"],
    };

    expect(() =>
      assertAndroidArtifactOmitsLp3ManifestMarkers(sharedPermissions, options),
    ).not.toThrow();
    expect(() =>
      assertAndroidArtifactOmitsLp3ManifestMarkers(
        `${sharedPermissions}\nandroid.permission.WRITE_SECURE_SETTINGS`,
        options,
      ),
    ).toThrow("ordinary AOSP artifact manifest still contains LP3");
  });

  it.each([
    "ai.elizaos.app.Lp3ColorPolicyService",
    "ai.elizaos.app.action.SYNC_LP3_COLOR_POLICY",
    "lp3_color_policy",
  ])("rejects the AOSP manifest LP3 marker %s", (marker) => {
    expect(() =>
      assertAndroidArtifactOmitsLp3ManifestMarkers(marker, {
        label: "ordinary AOSP",
        permissions: ["WRITE_SECURE_SETTINGS"],
      }),
    ).toThrow(marker);
  });
});

describe("inspectAndroidAppBundle", () => {
  it("validates a clean bundle and inspects every module manifest and DEX", () => {
    const manifests = new Map([
      ["base", CLEAN_MANIFEST],
      [
        "feature",
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application/></manifest>',
      ],
    ]);
    const harness = successfulToolHarness(manifests);
    const readDexEntries = vi.fn((dexEntries, context) => {
      expect(context).toEqual({
        artifact: ARTIFACT,
        javaHome: JAVA_HOME,
      });
      return dexEntries.map((entry) =>
        Buffer.from(`clean dex payload ${entry}`, "utf8"),
      );
    });

    expect(
      inspectAndroidAppBundle(
        inspectOptions({
          entries: MULTI_MODULE_ENTRIES,
          readDexEntries,
        }),
        harness.deps,
      ),
    ).toEqual({
      dexEntries: ["base/dex/classes.dex", "feature/dex/classes2.dex"],
      modules: ["base", "feature"],
    });
    expect(readDexEntries).toHaveBeenCalledOnce();
    expect(harness.calls).toHaveLength(3);
    expect(harness.calls[0]).toMatchObject({
      args: ["-jar", BUNDLETOOL_JAR, "validate", `--bundle=${ARTIFACT}`],
      command: path.join(JAVA_HOME, "bin", "java"),
    });
    expect(harness.calls.slice(1).map((call) => call.args)).toEqual([
      [
        "-jar",
        BUNDLETOOL_JAR,
        "dump",
        "manifest",
        `--bundle=${ARTIFACT}`,
        "--module=base",
      ],
      [
        "-jar",
        BUNDLETOOL_JAR,
        "dump",
        "manifest",
        `--bundle=${ARTIFACT}`,
        "--module=feature",
      ],
    ]);
  });

  it.each([
    [
      "stripped permission",
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.WRITE_SECURE_SETTINGS"/></manifest>',
      "forbidden permission",
    ],
    [
      "stripped component",
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><service android:name="ai.elizaos.app.ElizaAgentService"/></application></manifest>',
      "forbidden component",
    ],
    [
      "private LP3 action",
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><receiver android:name="ai.elizaos.app.SafeReceiver"><intent-filter><action android:name="ai.elizaos.app.action.ENABLE_LP3_COLOR_POLICY"/></intent-filter></receiver></application></manifest>',
      "forbidden LP3 action",
    ],
    [
      "private LP3 preference marker",
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><meta-data android:name="lp3_color_policy" android:value="true"/></application></manifest>',
      "forbidden LP3 policy marker",
    ],
  ])("rejects a %s in any module manifest", (_name, manifest, message) => {
    const harness = successfulToolHarness(
      new Map([
        ["base", CLEAN_MANIFEST],
        ["feature", manifest],
      ]),
    );

    expect(() =>
      inspectAndroidAppBundle(
        inspectOptions({ entries: MULTI_MODULE_ENTRIES }),
        harness.deps,
      ),
    ).toThrow(new RegExp(`module feature contains ${message}`));
  });

  it("rejects an LP3 marker found only in a feature module DEX", () => {
    const harness = successfulToolHarness(
      new Map([
        ["base", CLEAN_MANIFEST],
        ["feature", CLEAN_MANIFEST],
      ]),
    );
    const readDexEntries = (dexEntries) =>
      dexEntries.map((entry) =>
        Buffer.from(
          entry.startsWith("feature/")
            ? "dex strings lp3_color_policy"
            : "clean base dex",
          "utf8",
        ),
      );

    expect(() =>
      inspectAndroidAppBundle(
        inspectOptions({
          entries: MULTI_MODULE_ENTRIES,
          readDexEntries,
        }),
        harness.deps,
      ),
    ).toThrow(
      "feature/dex/classes2.dex contains forbidden LP3 marker: lp3_color_policy",
    );
  });

  it("rejects LP3 class descriptors even when the caller omits LP3 strip entries", () => {
    const harness = successfulToolHarness();
    const readDexEntries = () => [
      Buffer.from("Lai/elizaos/app/Lp3ColorPolicyService;", "utf8"),
    ];

    expect(() =>
      inspectAndroidAppBundle(
        inspectOptions({
          readDexEntries,
          strippedComponents: [],
          strippedPermissions: [],
        }),
        harness.deps,
      ),
    ).toThrow(
      "base/dex/classes.dex contains forbidden LP3 marker: ai/elizaos/app/Lp3ColorPolicyService",
    );
  });

  it("fails when bundletool rejects a malformed bundle", () => {
    const spawnSyncImpl = vi.fn(() => ({
      signal: null,
      status: 1,
      stderr: "[BT:1.18.3] Error: Bundle is not a valid zip file.",
      stdout: "",
    }));
    const readDexEntries = vi.fn();

    expect(() =>
      inspectAndroidAppBundle(inspectOptions({ readDexEntries }), {
        existsSync: () => true,
        platform: "linux",
        resolvePath: (value) => value,
        spawnSyncImpl,
      }),
    ).toThrow("Bundle is not a valid zip file");
    expect(spawnSyncImpl).toHaveBeenCalledOnce();
    expect(readDexEntries).not.toHaveBeenCalled();
  });

  it("fails before spawning when the configured bundletool JAR is missing", () => {
    const spawnSyncImpl = vi.fn();

    expect(() =>
      inspectAndroidAppBundle(inspectOptions(), {
        existsSync: () => false,
        platform: "linux",
        resolvePath: (value) => value,
        spawnSyncImpl,
      }),
    ).toThrow(`bundletool JAR not found at ${BUNDLETOOL_JAR}`);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });

  it("fails with the child-process cause when bundletool cannot start", () => {
    const childError = Object.assign(new Error("spawn EACCES"), {
      code: "EACCES",
    });
    const spawnSyncImpl = vi.fn(() => ({
      error: childError,
      signal: null,
      status: null,
      stderr: "",
      stdout: "",
    }));

    expect(() =>
      inspectAndroidAppBundle(inspectOptions(), {
        existsSync: () => true,
        platform: "linux",
        resolvePath: (value) => value,
        spawnSyncImpl,
      }),
    ).toThrow(
      expect.objectContaining({
        cause: childError,
        message: expect.stringContaining("failed to start: spawn EACCES"),
      }),
    );
  });

  it("fails with signal context when bundletool is terminated", () => {
    const spawnSyncImpl = vi.fn(() => ({
      signal: "SIGTERM",
      status: null,
      stderr: "",
      stdout: "",
    }));

    expect(() =>
      inspectAndroidAppBundle(inspectOptions(), {
        existsSync: () => true,
        platform: "linux",
        resolvePath: (value) => value,
        spawnSyncImpl,
      }),
    ).toThrow("terminated by signal SIGTERM");
  });

  it("fails when a decoded module manifest is empty", () => {
    const harness = successfulToolHarness(new Map([["base", ""]]));

    expect(() =>
      inspectAndroidAppBundle(inspectOptions(), harness.deps),
    ).toThrow("empty manifest for AAB module base");
  });

  it("fails when the bundle contains no DEX payload", () => {
    const harness = successfulToolHarness();

    expect(() =>
      inspectAndroidAppBundle(
        inspectOptions({
          entries: ["base/manifest/AndroidManifest.xml"],
        }),
        harness.deps,
      ),
    ).toThrow("has no module dex/classes*.dex entries");
  });

  it("fails when the DEX reader does not return one buffer per entry", () => {
    const harness = successfulToolHarness(
      new Map([
        ["base", CLEAN_MANIFEST],
        ["feature", CLEAN_MANIFEST],
      ]),
    );

    expect(() =>
      inspectAndroidAppBundle(
        inspectOptions({
          entries: MULTI_MODULE_ENTRIES,
          readDexEntries: () => [Buffer.from("only one")],
        }),
        harness.deps,
      ),
    ).toThrow("returned 1 buffers for 2 DEX entries");
  });

  it("does not accept APKs into the bundletool path", () => {
    const spawnSyncImpl = vi.fn();

    expect(() =>
      inspectAndroidAppBundle(
        {
          ...inspectOptions(),
          artifact: "/artifacts/app-debug.apk",
        },
        {
          existsSync: () => true,
          platform: "linux",
          resolvePath: (value) => value,
          spawnSyncImpl,
        },
      ),
    ).toThrow("only accepts .aab artifacts");
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });
});
