/**
 * Exercises Cloud AAB policy inspection at the bundletool process boundary
 * with deterministic manifest and DEX payloads.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ElizaError as CoreElizaError } from "../../core/src/errors.ts";

import {
  ANDROID_AAB_AUDIT_TIMEOUT_MS,
  ANDROID_AAB_MAX_DEX_ENTRIES,
  ANDROID_AAB_MAX_MANIFEST_MODULES,
  ANDROID_BUNDLETOOL_JAR_ENV,
  ANDROID_BUNDLETOOL_SHA256,
  ANDROID_BUNDLETOOL_TIMEOUT_MS,
  ANDROID_BUNDLETOOL_URL,
  ANDROID_BUNDLETOOL_VERSION,
  ANDROID_PLAY_FORBIDDEN_DEX_MARKERS,
  ensureAndroidBundletoolJar,
  inspectAndroidAppBundle,
  listAabDexEntries,
  listAabManifestModules,
  resolveAndroidArtifactKind,
  resolveBundletoolInvocation,
  runCheckedBundletool,
} from "./lib/android-cloud-artifact-audit.mjs";
import { ElizaError as ScriptElizaError } from "./lib/eliza-error.mjs";
import {
  assertAndroidArtifactOmitsLp3ManifestMarkers,
  assertAndroidArtifactShipsWebPayload,
  assertAndroidArtifactSnapshotUnchanged,
  auditAndroidArtifactDexLp3Policy,
  auditAndroidCloudArtifact,
  createAndroidBuildEnv,
  dumpAndroidArtifactBadging,
  dumpAndroidArtifactManifest,
  findAndroidCloudAab,
  findAndroidCloudPackagedRuntimeOffenders,
  listAndroidArtifactEntries,
  readAndroidArtifactEntryBuffers,
  resolveAndroidBuildTool,
  snapshotAndroidArtifact,
} from "./run-mobile-build.mjs";

const ARTIFACT = "/artifacts/app-release.aab";
const BUNDLETOOL_JAR = "/tools/bundletool-all.jar";
const JAVA_HOME = "/jdk";
const CLEAN_MANIFEST =
  '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="ai.elizaos.app"><uses-permission android:name="android.permission.INTERNET"/><application/></manifest>';
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
const MOBILE_BUILD_SOURCE = fs.readFileSync(
  new URL("./run-mobile-build.mjs", import.meta.url),
  "utf8",
);
const AAB_AUDIT_SOURCE = fs.readFileSync(
  new URL("./lib/android-cloud-artifact-audit.mjs", import.meta.url),
  "utf8",
);
const ELIZA_ERROR_SOURCE = fs.readFileSync(
  new URL("./lib/eliza-error.mjs", import.meta.url),
  "utf8",
);
const REAL_AAB_FIXTURE = fileURLToPath(
  new URL(
    "../test/fixtures/android/install-time-permanent-modules.aab",
    import.meta.url,
  ),
);
const REAL_AAB_PACKAGE = "com.google.android.samples.dynamicfeatures.ondemand";
const REAL_AAB_MANIFEST_MUTATOR = fileURLToPath(
  new URL(
    "../test/fixtures/android/RelocateAndroidManifestFixture.java",
    import.meta.url,
  ),
);
const RELOCATED_STRIPPED_CLASS = "ElizaAccessibilityService";
const RELOCATED_STRIPPED_COMPONENT =
  "com.feature.relocated.security.component.abc.ElizaAccessibilityService";
const RELOCATED_STRIPPED_DESCRIPTOR =
  "Lcom/feature/relocated/security/component/abc/ElizaAccessibilityService;";
// Generic app-core CI lanes do not all provision a JDK or permit downloads.
// Opt in only after the caller has provisioned the Android/JDK toolchain.
const RUN_REAL_AAB_TEST = process.env.ELIZA_ANDROID_RUN_REAL_AAB_TEST === "1";
const describeRealAab = RUN_REAL_AAB_TEST ? describe : describe.skip;
let realBundletoolJar;

function verifiedToolDeps(overrides = {}) {
  return {
    digestBuffer: () => ANDROID_BUNDLETOOL_SHA256,
    existsSync: () => true,
    platform: "linux",
    readFileSync: () => Buffer.from("checksum-pinned bundletool"),
    resolvePath: (value) => value,
    ...overrides,
  };
}

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
    deps: verifiedToolDeps({ spawnSyncImpl }),
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
  const artifactBytes = fs.readFileSync(artifact);
  return {
    appId: REAL_AAB_PACKAGE,
    artifact,
    entries,
    env: {
      [ANDROID_BUNDLETOOL_JAR_ENV]: realBundletoolJar,
    },
    javaHome: process.env.JAVA_HOME,
    readDexEntries: (dexEntries) =>
      readAndroidArtifactEntryBuffers(
        artifact,
        dexEntries,
        process.env.JAVA_HOME,
        {
          artifactBytes,
          label: "real AAB DEX regression",
        },
      ),
    strippedComponents: [],
    strippedPermissions: [],
  };
}

function findCentralDirectoryEntry(bytes, entryName) {
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const signatureOffset = bytes.indexOf(signature, offset);
    if (signatureOffset === -1) break;
    offset = signatureOffset;
    if (offset + 46 > bytes.byteLength) break;
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > bytes.byteLength) {
      offset += 1;
      continue;
    }
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    if (name === entryName) {
      return {
        centralOffset: offset,
        localOffset: bytes.readUInt32LE(offset + 42),
      };
    }
    offset = nextOffset;
  }
  throw new Error(`Central-directory entry not found: ${entryName}`);
}

function rewriteEntryCrc(bytes, entryName, { rewriteLocal = false } = {}) {
  const mutated = Buffer.from(bytes);
  const { centralOffset, localOffset } = findCentralDirectoryEntry(
    mutated,
    entryName,
  );
  const replacement =
    (mutated.readUInt32LE(centralOffset + 16) ^ 0xffffffff) >>> 0;
  mutated.writeUInt32LE(replacement, centralOffset + 16);
  if (rewriteLocal) {
    mutated.writeUInt32LE(replacement, localOffset + 14);
  }
  return mutated;
}

function rewriteEntryDeclaredSize(bytes, entryName, size) {
  const mutated = Buffer.from(bytes);
  const { centralOffset, localOffset } = findCentralDirectoryEntry(
    mutated,
    entryName,
  );
  mutated.writeUInt32LE(size, centralOffset + 24);
  mutated.writeUInt32LE(size, localOffset + 22);
  return mutated;
}

function useDataDescriptorLocalPlaceholders(bytes, entryName) {
  const mutated = Buffer.from(bytes);
  const { centralOffset, localOffset } = findCentralDirectoryEntry(
    mutated,
    entryName,
  );
  mutated.writeUInt16LE(
    mutated.readUInt16LE(centralOffset + 8) | 0x08,
    centralOffset + 8,
  );
  mutated.writeUInt16LE(
    mutated.readUInt16LE(localOffset + 6) | 0x08,
    localOffset + 6,
  );
  mutated.fill(0, localOffset + 14, localOffset + 26);
  return mutated;
}

function writeSyntheticCloudAab(
  temporaryDir,
  { extraEntries = {}, includeWebPayload = true } = {},
) {
  const entries = {
    "base/dex/classes.dex": Buffer.from("clean synthetic DEX", "utf8"),
    "base/manifest/AndroidManifest.xml": Buffer.from(
      "compiled manifest placeholder",
      "utf8",
    ),
    "base/assets/capacitor.config.json": Buffer.from("{}", "utf8"),
    ...extraEntries,
  };
  if (includeWebPayload) {
    entries["base/assets/public/index.html"] = Buffer.from(
      "<!doctype html>",
      "utf8",
    );
  }
  const artifact = path.join(temporaryDir, "app-release.aab");
  fs.writeFileSync(artifact, zipSync(entries));
  return artifact;
}

function syntheticAabEvidence() {
  return {
    appId: "ai.elizaos.app",
    bundletool: {
      sha256: ANDROID_BUNDLETOOL_SHA256,
      version: ANDROID_BUNDLETOOL_VERSION,
    },
    dexEntries: ["base/dex/classes.dex"],
    dexEvidence: [],
    manifestEvidence: [],
    modules: ["base"],
  };
}

function writeMutatedRealAab(temporaryDir, name, mutate) {
  const archive = readRealAab(REAL_AAB_FIXTURE);
  mutate(archive);
  const artifact = path.join(temporaryDir, name);
  fs.writeFileSync(artifact, zipSync(archive, { level: 6 }));
  return { archive, artifact };
}

function replaceExactBytes(bytes, original, replacement) {
  const source = Buffer.from(original, "utf8");
  const target = Buffer.from(replacement, "utf8");
  if (source.byteLength !== target.byteLength) {
    throw new Error("real AAB fixture replacements must preserve byte length");
  }
  const offset = bytes.indexOf(source);
  if (offset === -1 || bytes.indexOf(source, offset + 1) !== -1) {
    throw new Error(
      `expected exactly one real AAB fixture marker: ${original}`,
    );
  }
  const rewritten = Buffer.from(bytes);
  target.copy(rewritten, offset);
  return rewritten;
}

function rewriteRealFeatureManifest(temporaryDir, archive) {
  const input = path.join(temporaryDir, "feature-manifest.pb");
  const output = path.join(temporaryDir, "relocated-feature-manifest.pb");
  fs.writeFileSync(input, archive["java/manifest/AndroidManifest.xml"]);
  const java = path.join(
    process.env.JAVA_HOME,
    "bin",
    process.platform === "win32" ? "java.exe" : "java",
  );
  const result = spawnSync(
    java,
    [
      "--class-path",
      realBundletoolJar,
      REAL_AAB_MANIFEST_MUTATOR,
      input,
      output,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `real AAB manifest fixture mutation failed: ${result.stderr || result.stdout}`,
    );
  }
  archive["java/manifest/AndroidManifest.xml"] = fs.readFileSync(output);
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

  it("selects stray packaged .dex entries outside module dex dirs for scanning", () => {
    expect(
      listAabDexEntries([
        "base/dex/classes.dex",
        "base/assets/classes.dex",
        "base/assets/plugins/Loader.DEX",
        "base/assets/notes.txt",
      ]),
    ).toEqual([
      "base/assets/classes.dex",
      "base/assets/plugins/Loader.DEX",
      "base/dex/classes.dex",
    ]);
  });

  it("rejects traversal-shaped stray .dex entry paths", () => {
    expect(() =>
      listAabDexEntries(["base/dex/classes.dex", "../evil.dex"]),
    ).toThrow("unsafe DEX entry path");
    expect(() =>
      listAabDexEntries(["base/dex/classes.dex", "base/assets/../evil.dex"]),
    ).toThrow("unsafe DEX entry path");
  });

  it("bounds manifest-module and DEX workloads before process execution", () => {
    expect(ANDROID_AAB_MAX_MANIFEST_MODULES).toBeGreaterThan(1);
    expect(ANDROID_AAB_MAX_DEX_ENTRIES).toBeGreaterThan(1);
    expect(() =>
      listAabManifestModules(MULTI_MODULE_ENTRIES, { maxModules: 1 }),
    ).toThrow(
      expect.objectContaining({
        code: "ANDROID_AAB_WORKLOAD_LIMIT_EXCEEDED",
      }),
    );
    expect(() =>
      listAabDexEntries(MULTI_MODULE_ENTRIES, { maxEntries: 1 }),
    ).toThrow(
      expect.objectContaining({
        code: "ANDROID_AAB_WORKLOAD_LIMIT_EXCEEDED",
      }),
    );
  });
});

describeRealAab("real multi-module bundletool regression", () => {
  beforeAll(async () => {
    realBundletoolJar = await ensureAndroidBundletoolJar({
      env: process.env,
    });
  });

  it("validates and inspects every real module manifest and DEX", async () => {
    expect(
      inspectAndroidAppBundle(realAabInspectionOptions(REAL_AAB_FIXTURE)),
    ).toEqual(
      expect.objectContaining({
        appId: REAL_AAB_PACKAGE,
        bundletool: {
          sha256: ANDROID_BUNDLETOOL_SHA256,
          version: ANDROID_BUNDLETOOL_VERSION,
        },
        dexEntries: [
          "base/dex/classes.dex",
          "initialInstall/dex/classes.dex",
          "java/dex/classes.dex",
        ],
        modules: ["base", "assets", "initialInstall", "java"],
      }),
    );
  });

  it("rejects a stripped component declared by a real dynamic feature", () => {
    const qualifiedComponent = `${REAL_AAB_PACKAGE}.JavaSampleActivity`;
    const escapedComponent = qualifiedComponent.replaceAll(".", String.raw`\.`);
    expect(() =>
      inspectAndroidAppBundle({
        ...realAabInspectionOptions(REAL_AAB_FIXTURE),
        strippedComponents: ["JavaSampleActivity"],
      }),
    ).toThrow(
      // bundletool's base dump is merged, but the audit must keep inspecting
      // and prove the declaration is also rejected in its owning feature.
      new RegExp(
        `module base contains forbidden component: ${escapedComponent}[\\s\\S]*` +
          `module java contains forbidden component: ${escapedComponent}`,
      ),
    );
  });

  it("rejects a relocated non-LP3 service and its privileged binding in a real feature manifest", () => {
    const temporaryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-real-aab-manifest-policy-"),
    );
    try {
      const { archive, artifact } = writeMutatedRealAab(
        temporaryDir,
        "relocated-privileged-service.aab",
        (entries) => rewriteRealFeatureManifest(temporaryDir, entries),
      );

      expect(() =>
        inspectAndroidAppBundle({
          ...realAabInspectionOptions(artifact, archive),
          strippedComponents: [RELOCATED_STRIPPED_CLASS],
          strippedPermissions: ["BIND_ACCESSIBILITY_SERVICE"],
        }),
      ).toThrow(
        new RegExp(
          `module java contains forbidden component permission: android\\.permission\\.BIND_ACCESSIBILITY_SERVICE[\\s\\S]*` +
            `module java contains forbidden component: ${RELOCATED_STRIPPED_COMPONENT.replaceAll(".", String.raw`\.`)}`,
        ),
      );
    } finally {
      fs.rmSync(temporaryDir, { force: true, recursive: true });
    }
  });

  it("rejects a relocated non-LP3 class in a real feature DEX", () => {
    const temporaryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-real-aab-relocated-dex-"),
    );
    try {
      const { archive, artifact } = writeMutatedRealAab(
        temporaryDir,
        "relocated-feature-class.aab",
        (entries) => {
          entries["java/dex/classes.dex"] = replaceExactBytes(
            Buffer.from(entries["java/dex/classes.dex"]),
            "Lcom/google/android/samples/dynamicfeatures/ondemand/JavaSampleActivity;",
            RELOCATED_STRIPPED_DESCRIPTOR,
          );
        },
      );

      expect(() =>
        inspectAndroidAppBundle({
          ...realAabInspectionOptions(artifact, archive),
          strippedComponents: [RELOCATED_STRIPPED_CLASS],
        }),
      ).toThrow(
        "java/dex/classes.dex contains forbidden stripped component class: ElizaAccessibilityService",
      );
    } finally {
      fs.rmSync(temporaryDir, { force: true, recursive: true });
    }
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
      ).toThrow(/validating .* with bundletool failed/);
    } finally {
      fs.rmSync(temporaryDir, { force: true, recursive: true });
    }
  });

  it("rejects real feature DEX central-directory CRC corruption that bundletool accepts", () => {
    const temporaryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-real-aab-crc-"),
    );
    try {
      const artifact = path.join(temporaryDir, "central-crc-corrupt.aab");
      fs.writeFileSync(
        artifact,
        rewriteEntryCrc(
          fs.readFileSync(REAL_AAB_FIXTURE),
          "java/dex/classes.dex",
        ),
      );
      const archive = readRealAab(artifact);

      expect(() =>
        inspectAndroidAppBundle(realAabInspectionOptions(artifact, archive)),
      ).toThrow(
        expect.objectContaining({
          code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
        }),
      );
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

  it("classifies an unreadable configured JAR as an integrity failure", async () => {
    await expect(
      ensureAndroidBundletoolJar(
        {
          env: { [ANDROID_BUNDLETOOL_JAR_ENV]: BUNDLETOOL_JAR },
        },
        {
          existsSync: () => true,
          readFileSync: () => {
            throw new Error("EISDIR: configured path is a directory");
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "ANDROID_BUNDLETOOL_INTEGRITY_FAILED",
      context: expect.objectContaining({
        bundletoolJar: path.resolve(BUNDLETOOL_JAR),
      }),
    });
  });

  it("does not mask an unreadable cache entry with a download", async () => {
    const fetchImpl = vi.fn();
    await expect(
      ensureAndroidBundletoolJar(
        {
          cacheDir: "/cache/bundletool",
          env: {},
        },
        {
          existsSync: () => true,
          fetchImpl,
          readFileSync: () => {
            throw new Error("EACCES: cache entry is unreadable");
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "ANDROID_BUNDLETOOL_INTEGRITY_FAILED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it("re-hashes the configured JAR immediately before execution", () => {
    const temporaryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-bundletool-recheck-"),
    );
    try {
      const jar = path.join(temporaryDir, "bundletool.jar");
      fs.writeFileSync(jar, "official");
      const deps = {
        digestBuffer: (bytes) =>
          bytes.toString("utf8") === "official"
            ? ANDROID_BUNDLETOOL_SHA256
            : "tampered-digest",
        existsSync: () => true,
        platform: "linux",
        readFileSync: fs.readFileSync,
      };
      expect(
        resolveBundletoolInvocation(
          {
            env: { [ANDROID_BUNDLETOOL_JAR_ENV]: jar },
            javaHome: JAVA_HOME,
          },
          deps,
        ).bundletoolDigest,
      ).toBe(ANDROID_BUNDLETOOL_SHA256);

      fs.writeFileSync(jar, "tampered");
      expect(() =>
        resolveBundletoolInvocation(
          {
            env: { [ANDROID_BUNDLETOOL_JAR_ENV]: jar },
            javaHome: JAVA_HOME,
          },
          deps,
        ),
      ).toThrow(`expected ${ANDROID_BUNDLETOOL_SHA256}`);
    } finally {
      fs.rmSync(temporaryDir, { force: true, recursive: true });
    }
  });

  it("re-verifies the pinned JAR before every bundletool command", () => {
    const pinnedBytes = Buffer.from("official");
    const tamperedBytes = Buffer.from("tampered");
    const readFileSync = vi
      .fn()
      .mockReturnValueOnce(pinnedBytes)
      .mockReturnValueOnce(pinnedBytes)
      .mockReturnValueOnce(tamperedBytes);
    const digestBuffer = (bytes) =>
      bytes.equals(pinnedBytes) ? ANDROID_BUNDLETOOL_SHA256 : "tampered-digest";
    const spawnSyncImpl = vi.fn(() => ({
      signal: null,
      status: 0,
      stderr: "",
      stdout: "validated",
    }));
    const readDexEntries = vi.fn();

    expect(() =>
      inspectAndroidAppBundle(inspectOptions({ readDexEntries }), {
        digestBuffer,
        existsSync: () => true,
        platform: "linux",
        readFileSync,
        resolvePath: (value) => value,
        spawnSyncImpl,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "ANDROID_BUNDLETOOL_INTEGRITY_FAILED",
        context: expect.objectContaining({
          actualSha256: "tampered-digest",
          expectedSha256: ANDROID_BUNDLETOOL_SHA256,
        }),
      }),
    );
    expect(readFileSync).toHaveBeenCalledTimes(3);
    expect(spawnSyncImpl).toHaveBeenCalledOnce();
    expect(readDexEntries).not.toHaveBeenCalled();
  });

  it("bounds bundletool execution with a typed timeout failure", () => {
    const timeoutCause = Object.assign(new Error("spawnSync ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    const invocation = {
      argsPrefix: ["-jar", BUNDLETOOL_JAR],
      bundletoolDigest: ANDROID_BUNDLETOOL_SHA256,
      bundletoolJar: BUNDLETOOL_JAR,
      command: "/jdk/bin/java",
    };
    const spawnSyncImpl = vi.fn(() => ({
      error: timeoutCause,
      signal: "SIGKILL",
      status: null,
      stderr: "Java process stopped responding",
      stdout: "",
    }));

    expect(() =>
      runCheckedBundletool(invocation, ["validate"], "bundle validation", {
        digestBuffer: () => ANDROID_BUNDLETOOL_SHA256,
        readFileSync: () => Buffer.from("official"),
        spawnSyncImpl,
      }),
    ).toThrow(
      expect.objectContaining({
        cause: timeoutCause,
        code: "ANDROID_BUNDLETOOL_TIMEOUT",
        context: expect.objectContaining({
          signal: "SIGKILL",
          timeoutMs: ANDROID_BUNDLETOOL_TIMEOUT_MS,
        }),
      }),
    );
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      invocation.command,
      [...invocation.argsPrefix, "validate"],
      expect.objectContaining({
        killSignal: "SIGKILL",
        timeout: ANDROID_BUNDLETOOL_TIMEOUT_MS,
      }),
    );
  });

  it("reports signal termination separately from an ordinary nonzero exit", () => {
    const invocation = {
      argsPrefix: ["-jar", BUNDLETOOL_JAR],
      bundletoolDigest: ANDROID_BUNDLETOOL_SHA256,
      bundletoolJar: BUNDLETOOL_JAR,
      command: "/jdk/bin/java",
    };

    expect(() =>
      runCheckedBundletool(invocation, ["validate"], "bundle validation", {
        digestBuffer: () => ANDROID_BUNDLETOOL_SHA256,
        readFileSync: () => Buffer.from("official"),
        spawnSyncImpl: () => ({
          signal: "SIGKILL",
          status: null,
          stderr: "out of memory",
          stdout: "",
        }),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "ANDROID_BUNDLETOOL_TERMINATED",
        context: expect.objectContaining({ signal: "SIGKILL" }),
      }),
    );
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
    expect(ANDROID_APP_GRADLE).toContain(
      "variant.artifacts.get(SingleArtifact.BUNDLE.INSTANCE)",
    );
    expect(ANDROID_APP_GRADLE).toContain("inputs.file(cloudReleaseAab)");
    expect(ANDROID_APP_GRADLE).toContain(
      "def bundleArtifact = cloudReleaseAab.get().asFile",
    );
    expect(ANDROID_APP_GRADLE).not.toContain(
      ".file('outputs/bundle/release/app-release.aab')",
    );
    expect(ANDROID_APP_GRADLE).toContain("bundleTask.state.executed");
    expect(ANDROID_APP_GRADLE).toContain("bundleTask.state.failure != null");
    expect(ANDROID_APP_GRADLE).toContain(
      "bundleTask.state.skipped && !bundleTask.state.upToDate",
    );
    expect(ANDROID_APP_GRADLE).toContain(
      "refusing stale bundle because bundleRelease outcome was",
    );
    expect(ANDROID_APP_GRADLE).toMatch(
      /onlyIf\('Cloud release build'\) \{\s*project\.findProperty\('elizaCloudBuild'\) == 'true'\s*\}/,
    );
    expect(ANDROID_APP_GRADLE).toContain("providers.exec {");
    expect(ANDROID_APP_GRADLE).not.toContain("project.exec {");
    expect(ANDROID_APP_GRADLE).toContain("bundleArtifact.absolutePath");
    expect(ANDROID_APP_GRADLE).toContain(
      "auditOutput.standardOutput.asText.get()",
    );
    expect(ANDROID_APP_GRADLE).toContain(
      "auditOutput.standardError.asText.get()",
    );
    expect(ANDROID_APP_GRADLE).toContain("'android-cloud-audit'");
    // npm-packages / white-label layouts resolve the audit CLI through the
    // orchestrator-provided override; the repo-root walk stays as the
    // source-checkout fallback. Both paths hard-fail on a missing script.
    expect(ANDROID_APP_GRADLE).toContain(
      "System.getenv('ELIZA_MOBILE_AUDIT_SCRIPT')?.trim()",
    );
    expect(ANDROID_APP_GRADLE).toContain(
      "ELIZA_MOBILE_AUDIT_SCRIPT does not exist",
    );
    expect(ANDROID_APP_GRADLE).toContain(
      "'packages/app-core/scripts/run-mobile-build.mjs'",
    );
    expect(ANDROID_APP_GRADLE).toContain(
      `[cloud-aab-audit] missing \${auditScript}`,
    );
  });

  it("passes an absolute JavaScript runtime to Gradle for the AAB finalizer", () => {
    const target = {
      env: {},
      includeSmsGatewayEnvDefaults: false,
    };
    const defaults = createAndroidBuildEnv(target, {
      androidSdkRoot: "/android-sdk",
      env: { PATH: "/usr/bin" },
      javaHome: "/jdk",
    });
    const overridden = createAndroidBuildEnv(target, {
      androidSdkRoot: "/android-sdk",
      env: {
        ELIZA_MOBILE_AUDIT_SCRIPT: "  /tools/audit.mjs  ",
        NODE_BINARY: "  /tools/node  ",
        PATH: "/usr/bin",
      },
      javaHome: "/jdk",
    });

    expect(path.isAbsolute(defaults.NODE_BINARY)).toBe(true);
    expect(defaults.NODE_BINARY).toBe(process.execPath);
    expect(overridden.NODE_BINARY).toBe("/tools/node");
    expect(path.isAbsolute(defaults.ELIZA_MOBILE_AUDIT_SCRIPT)).toBe(true);
    expect(defaults.ELIZA_MOBILE_AUDIT_SCRIPT).toBe(
      fileURLToPath(new URL("./run-mobile-build.mjs", import.meta.url)),
    );
    expect(fs.existsSync(defaults.ELIZA_MOBILE_AUDIT_SCRIPT)).toBe(true);
    expect(overridden.ELIZA_MOBILE_AUDIT_SCRIPT).toBe("/tools/audit.mjs");
  });
});

describe("Android artifact boundary selection", () => {
  it("keeps script imports local while preserving the canonical core error identity", () => {
    expect(MOBILE_BUILD_SOURCE).toContain('from "./lib/eliza-error.mjs"');
    expect(AAB_AUDIT_SOURCE).toContain('from "./eliza-error.mjs"');
    expect(MOBILE_BUILD_SOURCE).not.toContain('from "@elizaos/core"');
    expect(AAB_AUDIT_SOURCE).not.toContain('from "@elizaos/core"');
    expect(MOBILE_BUILD_SOURCE).not.toContain("/core/src/errors.ts");
    expect(AAB_AUDIT_SOURCE).not.toContain("/core/src/errors.ts");
    expect(ELIZA_ERROR_SOURCE).toContain(
      'import.meta.resolve("@elizaos/core")',
    );
    expect(ELIZA_ERROR_SOURCE).toContain("/core/src/errors.ts");
    expect(ELIZA_ERROR_SOURCE).toContain(
      "export const ElizaError = coreErrors.ElizaError",
    );
    expect(ELIZA_ERROR_SOURCE).not.toContain(
      "export class ElizaError extends Error",
    );
    expect(ScriptElizaError).toBe(CoreElizaError);
  });

  it("rejects every known packaged local-runtime payload family", () => {
    const forbiddenEntries = [
      "base/assets/agent/agent-bundle.js",
      "base/assets/classes.dex",
      "base/assets/libllama.so",
      "base/assets/models/model.GGUF",
      "base/assets/plugins/Loader.DEX",
      "base/assets/runtime/bun",
      "base/assets/runtime/libelizainference.so",
      "base/assets/runtime/llama-cpp-kernels.json",
      "base/lib/arm64-v8a/libelizainference.so",
      "base/lib/arm64-v8a/libeliza_runtime.so",
      "base/lib/arm64-v8a/libelizavoicejni.so",
      "base/lib/arm64-v8a/libggml-base.so",
      "base/lib/arm64-v8a/libllama.so",
      "base/lib/arm64-v8a/libmtmd.so",
      "base/lib/arm64-v8a/libomp.so",
      "base/lib/arm64-v8a/libsigsys-handler.so",
    ];
    expect(
      findAndroidCloudPackagedRuntimeOffenders([
        ...forbiddenEntries,
        "base/assets/public/bun.png",
        "base/assets/public/dexterity.js",
        "base/dex/classes.dex",
        "base/lib/arm64-v8a/libc++_shared.so",
      ]),
    ).toEqual(forbiddenEntries);
  });

  it("lists and extracts only bounded safe entries from immutable ZIP bytes", () => {
    const archive = zipSync({
      "base/dex/classes.dex": Buffer.from("base dex"),
      "feature/dex/classes2.dex": Buffer.from("feature dex"),
    });
    expect(
      listAndroidArtifactEntries("/artifact.aab", JAVA_HOME, {
        artifactBytes: archive,
      }),
    ).toEqual(["base/dex/classes.dex", "feature/dex/classes2.dex"]);
    expect(
      readAndroidArtifactEntryBuffers(
        "/artifact.aab",
        ["feature/dex/classes2.dex"],
        JAVA_HOME,
        { artifactBytes: archive },
      ).map((bytes) => bytes.toString("utf8")),
    ).toEqual(["feature dex"]);
    expect(() =>
      listAndroidArtifactEntries("/artifact.aab", JAVA_HOME, {
        artifactBytes: archive,
        maxEntries: 1,
      }),
    ).toThrow(
      expect.objectContaining({ code: "ANDROID_ARTIFACT_ARCHIVE_INVALID" }),
    );
    expect(() =>
      readAndroidArtifactEntryBuffers(
        "/artifact.aab",
        ["feature/dex/classes2.dex"],
        JAVA_HOME,
        {
          artifactBytes: archive,
          maxEntryBytes: 4,
        },
      ),
    ).toThrow(
      expect.objectContaining({ code: "ANDROID_ARTIFACT_ENTRY_TOO_LARGE" }),
    );

    const crcCorruptArchive = rewriteEntryCrc(archive, "base/dex/classes.dex", {
      rewriteLocal: true,
    });
    expect(() =>
      readAndroidArtifactEntryBuffers(
        "/artifact.aab",
        ["base/dex/classes.dex"],
        JAVA_HOME,
        {
          artifactBytes: crcCorruptArchive,
        },
      ),
    ).toThrow(
      expect.objectContaining({ code: "ANDROID_ARTIFACT_ARCHIVE_INVALID" }),
    );

    const sizeCorruptArchive = rewriteEntryDeclaredSize(
      zipSync(
        {
          "base/dex/classes.dex": Buffer.from("clean marker-after-boundary"),
        },
        { level: 0 },
      ),
      "base/dex/classes.dex",
      5,
    );
    expect(() =>
      readAndroidArtifactEntryBuffers(
        "/artifact.aab",
        ["base/dex/classes.dex"],
        JAVA_HOME,
        { artifactBytes: sizeCorruptArchive },
      ),
    ).toThrow(
      expect.objectContaining({ code: "ANDROID_ARTIFACT_ARCHIVE_INVALID" }),
    );

    const descriptorArchive = useDataDescriptorLocalPlaceholders(
      archive,
      "base/dex/classes.dex",
    );
    expect(
      readAndroidArtifactEntryBuffers(
        "/artifact.aab",
        ["base/dex/classes.dex"],
        JAVA_HOME,
        { artifactBytes: descriptorArchive },
      )[0].toString("utf8"),
    ).toBe("base dex");
  });

  it("parses and bounds the committed multi-module AAB without bundletool", () => {
    const artifactBytes = fs.readFileSync(REAL_AAB_FIXTURE);
    const entries = listAndroidArtifactEntries(REAL_AAB_FIXTURE, JAVA_HOME, {
      artifactBytes,
    });

    expect(entries).toContain("base/manifest/AndroidManifest.xml");
    expect(entries).toContain("base/dex/classes.dex");
    expect(entries).toContain("initialInstall/dex/classes.dex");
    expect(
      readAndroidArtifactEntryBuffers(
        REAL_AAB_FIXTURE,
        ["base/dex/classes.dex"],
        JAVA_HOME,
        { artifactBytes },
      )[0].byteLength,
    ).toBeGreaterThan(0);
  });

  it("rejects attacker-sized declarations before payload decoding", () => {
    const entry = "base/dex/classes.dex";
    const archive = rewriteEntryDeclaredSize(
      zipSync({ [entry]: Buffer.from("bounded payload") }),
      entry,
      0xffffffff,
    );

    expect(() =>
      readAndroidArtifactEntryBuffers("/artifact.aab", [entry], JAVA_HOME, {
        artifactBytes: archive,
      }),
    ).toThrow(
      expect.objectContaining({ code: "ANDROID_ARTIFACT_ENTRY_TOO_LARGE" }),
    );
  });

  it("rejects compressed-byte declarations above the audit limit", () => {
    const archive = zipSync(
      {
        "base/dex/classes.dex": Buffer.from("12345678"),
      },
      { level: 0 },
    );
    expect(() =>
      readAndroidArtifactEntryBuffers(
        "/artifact.aab",
        ["base/dex/classes.dex"],
        JAVA_HOME,
        {
          artifactBytes: archive,
          maxEntryBytes: 4,
        },
      ),
    ).toThrow(
      expect.objectContaining({ code: "ANDROID_ARTIFACT_ENTRY_TOO_LARGE" }),
    );
  });

  it("rejects malformed and traversal-shaped ZIP metadata", () => {
    expect(() =>
      listAndroidArtifactEntries("/artifact.aab", JAVA_HOME, {
        artifactBytes: Buffer.from("not a zip"),
      }),
    ).toThrow(
      expect.objectContaining({ code: "ANDROID_ARTIFACT_ARCHIVE_INVALID" }),
    );
    const traversalArchive = zipSync({
      "../escape.dex": Buffer.from("payload"),
    });
    expect(() =>
      listAndroidArtifactEntries("/artifact.aab", JAVA_HOME, {
        artifactBytes: traversalArchive,
      }),
    ).toThrow("unsafe archive path");
  });

  it("binds audit evidence to a stable artifact snapshot", () => {
    const temporaryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-aab-snapshot-"),
    );
    const artifact = path.join(temporaryDir, "app-release.aab");
    try {
      fs.writeFileSync(artifact, "first artifact");
      const before = snapshotAndroidArtifact(artifact);
      expect(() =>
        assertAndroidArtifactSnapshotUnchanged(
          artifact,
          before,
          snapshotAndroidArtifact(artifact),
        ),
      ).not.toThrow();

      fs.writeFileSync(artifact, "replacement artifact");
      expect(() =>
        assertAndroidArtifactSnapshotUnchanged(
          artifact,
          before,
          snapshotAndroidArtifact(artifact),
        ),
      ).toThrow(
        expect.objectContaining({
          code: "ANDROID_ARTIFACT_CHANGED_DURING_AUDIT",
        }),
      );
      expect(() =>
        snapshotAndroidArtifact(artifact, { maxArtifactBytes: 1 }),
      ).toThrow(
        expect.objectContaining({ code: "ANDROID_ARTIFACT_TOO_LARGE" }),
      );

      let statCall = 0;
      let readCall = 0;
      const closeSync = vi.fn();
      expect(() =>
        snapshotAndroidArtifact("/virtual/growing.aab", {
          closeSync,
          fstatSync: () => ({
            isFile: () => true,
            size: statCall++ === 0 ? 4 : 6,
          }),
          maxArtifactBytes: 4,
          openSync: () => 7,
          readSync: (_descriptor, buffer, offset, length) => {
            const bytesRead = readCall++ === 0 ? Math.min(4, length) : 1;
            buffer.fill(0, offset, offset + bytesRead);
            return bytesRead;
          },
        }),
      ).toThrow(
        expect.objectContaining({
          code: "ANDROID_ARTIFACT_CHANGED_DURING_AUDIT",
        }),
      );
      expect(closeSync).toHaveBeenCalledWith(7);
    } finally {
      fs.rmSync(temporaryDir, { force: true, recursive: true });
    }
  });

  it("selects only the canonical Gradle release AAB", () => {
    const releaseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-aab-selection-"),
    );
    try {
      fs.writeFileSync(path.join(releaseDir, "stale-or-foreign.aab"), "stale");
      expect(findAndroidCloudAab(releaseDir)).toBeNull();

      const canonical = path.join(releaseDir, "app-release.aab");
      fs.writeFileSync(canonical, "current");
      expect(findAndroidCloudAab(releaseDir)).toBe(canonical);
    } finally {
      fs.rmSync(releaseDir, { force: true, recursive: true });
    }
  });

  it("requires Capacitor web assets in the AAB base module", () => {
    const featureOnlyEntries = [
      "base/manifest/AndroidManifest.xml",
      "onDemandFeature/assets/public/index.html",
      "assetPack/assets/capacitor.config.json",
    ];

    expect(() =>
      assertAndroidArtifactShipsWebPayload(ARTIFACT, featureOnlyEntries, {
        label: "android-cloud",
      }),
    ).toThrow("missing required packaged payload");
    expect(() =>
      assertAndroidArtifactShipsWebPayload(ARTIFACT, featureOnlyEntries, {
        label: "android-cloud",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "ANDROID_ARTIFACT_WEB_PAYLOAD_MISSING",
        context: expect.objectContaining({
          artifact: ARTIFACT,
          artifactKind: "aab",
          label: "android-cloud",
        }),
      }),
    );
    expect(() =>
      assertAndroidArtifactShipsWebPayload(
        ARTIFACT,
        [
          ...featureOnlyEntries,
          "base/assets/public/index.html",
          "base/assets/capacitor.config.json",
        ],
        { label: "android-cloud" },
      ),
    ).not.toThrow();
  });

  it("retains the APK asset root without accepting nested module lookalikes", () => {
    expect(() =>
      assertAndroidArtifactShipsWebPayload("/artifacts/app-debug.apk", [
        "feature/assets/public/index.html",
        "feature/assets/capacitor.config.json",
      ]),
    ).toThrow("missing required packaged payload");
    expect(() =>
      assertAndroidArtifactShipsWebPayload("/artifacts/app-debug.apk", [
        "assets/public/index.html",
        "assets/capacitor.config.json",
      ]),
    ).not.toThrow();
  });

  it("resolves Windows AAPT executables from the newest SDK build-tools", () => {
    const sdkRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-aapt-selection-"),
    );
    try {
      const older = path.join(sdkRoot, "build-tools", "34.0.0");
      const newer = path.join(sdkRoot, "build-tools", "35.0.0");
      fs.mkdirSync(older, { recursive: true });
      fs.mkdirSync(newer, { recursive: true });
      fs.writeFileSync(path.join(older, "aapt.exe"), "");
      const expected = path.join(newer, "aapt.exe");
      fs.writeFileSync(expected, "");

      expect(
        resolveAndroidBuildTool(sdkRoot, "aapt", { platform: "win32" }),
      ).toBe(expected);
    } finally {
      fs.rmSync(sdkRoot, { force: true, recursive: true });
    }
  });

  it("retains extensionless Android build-tools on Unix hosts", () => {
    const sdkRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-aapt-selection-"),
    );
    try {
      const buildTools = path.join(sdkRoot, "build-tools", "35.0.0");
      fs.mkdirSync(buildTools, { recursive: true });
      fs.writeFileSync(path.join(buildTools, "aapt.exe"), "");
      expect(
        resolveAndroidBuildTool(sdkRoot, "aapt", { platform: "linux" }),
      ).toBeNull();

      const expected = path.join(buildTools, "aapt");
      fs.writeFileSync(expected, "");
      expect(
        resolveAndroidBuildTool(sdkRoot, "aapt", { platform: "linux" }),
      ).toBe(expected);
    } finally {
      fs.rmSync(sdkRoot, { force: true, recursive: true });
    }
  });
});

describe("Android Cloud outer audit boundary", () => {
  it("uses one immutable archive snapshot and emits attestation only after every gate", () => {
    const temporaryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-outer-aab-audit-"),
    );
    const log = vi.fn();
    try {
      const artifact = writeSyntheticCloudAab(temporaryDir);
      const inspectAndroidAppBundleImpl = vi.fn((options) => {
        expect(
          options.readDexEntries(["base/dex/classes.dex"])[0].toString("utf8"),
        ).toBe("clean synthetic DEX");
        expect(fs.realpathSync(options.artifact)).not.toBe(
          fs.realpathSync(artifact),
        );
        return syntheticAabEvidence();
      });

      expect(
        auditAndroidCloudArtifact(
          { artifact, env: {}, javaHome: JAVA_HOME },
          { inspectAndroidAppBundleImpl, log },
        ),
      ).toBe(path.resolve(artifact));
      expect(inspectAndroidAppBundleImpl).toHaveBeenCalledOnce();
      expect(log.mock.calls.flat().join("\n")).toMatch(
        /android-cloud AAB attestation .*"sha256":"[a-f0-9]{64}"/,
      );
      expect(log.mock.calls.at(-1)?.[0]).toContain("artifact audit passed");
    } finally {
      fs.rmSync(temporaryDir, { force: true, recursive: true });
    }
  });

  it("rejects a cloud AAB smuggling a dex under assets before inspection", () => {
    const temporaryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-outer-aab-assets-dex-"),
    );
    const log = vi.fn();
    const inspectAndroidAppBundleImpl = vi.fn();
    try {
      const artifact = writeSyntheticCloudAab(temporaryDir, {
        extraEntries: {
          "base/assets/classes.dex": Buffer.from(
            "ai.elizaos.app.action.ENABLE_LP3_COLOR_POLICY",
            "utf8",
          ),
        },
      });

      expect(() =>
        auditAndroidCloudArtifact(
          { artifact, env: {}, javaHome: JAVA_HOME },
          { inspectAndroidAppBundleImpl, log },
        ),
      ).toThrow(
        expect.objectContaining({
          code: "ANDROID_CLOUD_RUNTIME_PAYLOAD_PRESENT",
          message: expect.stringContaining("base/assets/classes.dex"),
        }),
      );
      expect(inspectAndroidAppBundleImpl).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(temporaryDir, { force: true, recursive: true });
    }
  });

  it("does not attest an AAB that is missing its packaged web payload", () => {
    const temporaryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-outer-aab-no-web-"),
    );
    const log = vi.fn();
    try {
      const artifact = writeSyntheticCloudAab(temporaryDir, {
        includeWebPayload: false,
      });

      expect(() =>
        auditAndroidCloudArtifact(
          { artifact, env: {}, javaHome: JAVA_HOME },
          {
            inspectAndroidAppBundleImpl: () => syntheticAabEvidence(),
            log,
          },
        ),
      ).toThrow(
        expect.objectContaining({
          code: "ANDROID_ARTIFACT_WEB_PAYLOAD_MISSING",
        }),
      );
      expect(log).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(temporaryDir, { force: true, recursive: true });
    }
  });

  it("does not attest when the original artifact changes during inspection", () => {
    const temporaryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-outer-aab-mutated-"),
    );
    const log = vi.fn();
    try {
      const artifact = writeSyntheticCloudAab(temporaryDir);

      expect(() =>
        auditAndroidCloudArtifact(
          { artifact, env: {}, javaHome: JAVA_HOME },
          {
            inspectAndroidAppBundleImpl: () => {
              fs.writeFileSync(artifact, Buffer.from("replacement", "utf8"));
              return syntheticAabEvidence();
            },
            log,
          },
        ),
      ).toThrow(
        expect.objectContaining({
          code: "ANDROID_ARTIFACT_CHANGED_DURING_AUDIT",
        }),
      );
      expect(log).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(temporaryDir, { force: true, recursive: true });
    }
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
  it("rejects excessive module work before invoking bundletool", () => {
    const spawnSyncImpl = vi.fn();

    expect(() =>
      inspectAndroidAppBundle(
        inspectOptions({ entries: MULTI_MODULE_ENTRIES }),
        {
          ...verifiedToolDeps({ spawnSyncImpl }),
          maxManifestModules: 1,
        },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "ANDROID_AAB_WORKLOAD_LIMIT_EXCEEDED",
      }),
    );
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });

  it("enforces one aggregate deadline across bundletool subprocesses", () => {
    expect(ANDROID_AAB_AUDIT_TIMEOUT_MS).toBe(300_000);
    const harness = successfulToolHarness();
    const now = vi
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(11);

    expect(() =>
      inspectAndroidAppBundle(inspectOptions(), {
        ...harness.deps,
        auditTimeoutMs: 10,
        now,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "ANDROID_AAB_AUDIT_TIMEOUT",
      }),
    );
    expect(harness.spawnSyncImpl).toHaveBeenCalledOnce();
    expect(harness.calls[0].options.timeout).toBe(10);
  });

  it("bounds aggregate decoded manifest output before retaining every module", () => {
    const featureManifest =
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application/></manifest>';
    const harness = successfulToolHarness(
      new Map([
        ["base", CLEAN_MANIFEST],
        ["feature", featureManifest],
      ]),
    );

    expect(() =>
      inspectAndroidAppBundle(
        inspectOptions({ entries: MULTI_MODULE_ENTRIES }),
        {
          ...harness.deps,
          maxManifestBytes: 1_024,
          maxManifestTotalBytes: Buffer.byteLength(CLEAN_MANIFEST, "utf8"),
        },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "ANDROID_AAB_WORKLOAD_LIMIT_EXCEEDED",
      }),
    );
    expect(harness.spawnSyncImpl).toHaveBeenCalledTimes(3);
  });

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

    const evidence = inspectAndroidAppBundle(
      inspectOptions({
        entries: MULTI_MODULE_ENTRIES,
        readDexEntries,
      }),
      harness.deps,
    );
    expect(evidence).toEqual(
      expect.objectContaining({
        appId: "ai.elizaos.app",
        bundletool: {
          sha256: ANDROID_BUNDLETOOL_SHA256,
          version: ANDROID_BUNDLETOOL_VERSION,
        },
        dexEntries: ["base/dex/classes.dex", "feature/dex/classes2.dex"],
        manifestTotalSizeBytes:
          Buffer.byteLength(CLEAN_MANIFEST, "utf8") +
          Buffer.byteLength(manifests.get("feature"), "utf8"),
        modules: ["base", "feature"],
      }),
    );
    expect(evidence.manifestEvidence).toEqual([
      expect.objectContaining({
        actions: [],
        components: [],
        metadataNames: [],
        module: "base",
        packageName: "ai.elizaos.app",
        permissions: ["android.permission.INTERNET"],
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sizeBytes: Buffer.byteLength(CLEAN_MANIFEST, "utf8"),
      }),
      expect.objectContaining({
        actions: [],
        components: [],
        metadataNames: [],
        module: "feature",
        packageName: null,
        permissions: [],
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sizeBytes: Buffer.byteLength(manifests.get("feature"), "utf8"),
      }),
    ]);
    expect(readDexEntries).toHaveBeenCalledOnce();
    expect(harness.calls).toHaveLength(3);
    expect(harness.calls[0]).toMatchObject({
      args: ["-jar", BUNDLETOOL_JAR, "validate", `--bundle=${ARTIFACT}`],
      command: path.join(JAVA_HOME, "bin", "java"),
      options: {
        timeout: 120_000,
      },
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

  it("normalizes alternate Android namespace prefixes in manifest evidence", () => {
    const manifest =
      '<manifest xmlns:a="http://schemas.android.com/apk/res/android" package="ai.elizaos.app">' +
      '<uses-permission a:name="android.permission.INTERNET"/>' +
      '<application><service a:name=".SafeService"><intent-filter>' +
      '<action a:name="ai.elizaos.app.action.SAFE"/></intent-filter></service>' +
      '<meta-data a:name="safe_metadata" a:value="true"/></application></manifest>';
    const harness = successfulToolHarness(new Map([["base", manifest]]));

    const evidence = inspectAndroidAppBundle(inspectOptions(), harness.deps);

    expect(evidence.manifestEvidence).toEqual([
      expect.objectContaining({
        actions: ["ai.elizaos.app.action.SAFE"],
        components: ["service:.SafeService"],
        metadataNames: ["safe_metadata"],
        module: "base",
        packageName: "ai.elizaos.app",
        permissions: ["android.permission.INTERNET"],
      }),
    ]);
  });

  it("rejects a base manifest whose package does not match the expected app", () => {
    const harness = successfulToolHarness(
      new Map([
        [
          "base",
          '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.other"><application><service android:name="com.other.ElizaAgentService"/></application></manifest>',
        ],
      ]),
    );

    expect(() =>
      inspectAndroidAppBundle(inspectOptions(), harness.deps),
    ).toThrow(
      "android-cloud AAB package com.other does not match expected application ID ai.elizaos.app",
    );
  });

  it("does not mistake a namespaced package lookalike for the app identity", () => {
    const harness = successfulToolHarness(
      new Map([
        [
          "base",
          '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:evil="urn:evil" evil:package="ai.elizaos.app" package="com.attacker"><application/></manifest>',
        ],
      ]),
    );

    expect(() =>
      inspectAndroidAppBundle(inspectOptions(), harness.deps),
    ).toThrow(
      "android-cloud AAB package com.attacker does not match expected application ID ai.elizaos.app",
    );
  });

  it("does not read a package lookalike from another attribute's value", () => {
    const harness = successfulToolHarness(
      new Map([
        [
          "base",
          `<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:evil="urn:evil" evil:note=" package='ai.elizaos.app' " package="com.attacker"><application/></manifest>`,
        ],
      ]),
    );

    expect(() =>
      inspectAndroidAppBundle(inspectOptions(), harness.deps),
    ).toThrow(
      "android-cloud AAB package com.attacker does not match expected application ID ai.elizaos.app",
    );
  });

  it("rejects a base manifest without a package identity", () => {
    const harness = successfulToolHarness(
      new Map([
        [
          "base",
          '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application/></manifest>',
        ],
      ]),
    );

    expect(() =>
      inspectAndroidAppBundle(inspectOptions(), harness.deps),
    ).toThrow("base manifest is missing its package identity");
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
      "relocated non-LP3 stripped component",
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><service android:name="com.feature.ElizaAgentService"/></application></manifest>',
      "forbidden component",
    ],
    [
      "relocated private LP3 component",
      '<manifest xmlns:a="http://schemas.android.com/apk/res/android"><application><service a:name="com.attacker.Lp3ColorPolicyService"/></application></manifest>',
      "forbidden LP3 component",
    ],
    [
      "relocated private LP3 initializer",
      '<manifest xmlns:a="http://schemas.android.com/apk/res/android"><application><provider a:name="com.attacker.Lp3ColorPolicyInitializer"/></application></manifest>',
      "forbidden LP3 component",
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

  it.each(["permission", "readPermission", "writePermission"])(
    "rejects a forbidden component android:%s binding in any module",
    (attributeName) => {
      const manifest =
        '<manifest xmlns:a="http://schemas.android.com/apk/res/android"><application>' +
        `<provider a:name="com.feature.ElizaAgentService" a:${attributeName}="android.permission.WRITE_SECURE_SETTINGS"/>` +
        "</application></manifest>";
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
      ).toThrow(
        `module feature contains forbidden component ${attributeName}: android.permission.WRITE_SECURE_SETTINGS`,
      );
    },
  );

  it("does not reject manifest class-name lookalikes", () => {
    const manifest =
      '<manifest xmlns:a="http://schemas.android.com/apk/res/android"><application>' +
      '<service a:name="com.feature.SafeElizaAgentService"/>' +
      '<service a:name="com.feature.ElizaAgentServiceProxy"/>' +
      "</application></manifest>";
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
    ).not.toThrow();
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

  it.each(ANDROID_PLAY_FORBIDDEN_DEX_MARKERS)(
    "rejects Play local-runtime marker %s in any module DEX",
    (forbiddenMarker) => {
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
              ? `dex strings ${forbiddenMarker}`
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
        `feature/dex/classes2.dex contains forbidden Play local-runtime marker: ${forbiddenMarker}`,
      );
    },
  );

  it("rejects an LP3 marker in a dex smuggled outside a module dex dir", () => {
    const harness = successfulToolHarness();
    const readDexEntries = (dexEntries) =>
      dexEntries.map((entry) =>
        Buffer.from(
          entry === "base/assets/classes.dex"
            ? "ai.elizaos.app.action.ENABLE_LP3_COLOR_POLICY"
            : "clean base dex",
          "utf8",
        ),
      );

    expect(() =>
      inspectAndroidAppBundle(
        inspectOptions({
          entries: [...BASE_ENTRIES, "base/assets/classes.dex"],
          readDexEntries,
        }),
        harness.deps,
      ),
    ).toThrow(
      "base/assets/classes.dex contains forbidden LP3 marker: ai.elizaos.app.action.ENABLE_LP3_COLOR_POLICY",
    );
  });

  it.each(["feature/dex/classes2.dex", "base/assets/classes.dex"])(
    "rejects a relocated non-LP3 stripped class in %s",
    (offendingEntry) => {
      const entries = offendingEntry.startsWith("feature/")
        ? MULTI_MODULE_ENTRIES
        : [...BASE_ENTRIES, offendingEntry];
      const manifests = offendingEntry.startsWith("feature/")
        ? new Map([
            ["base", CLEAN_MANIFEST],
            ["feature", CLEAN_MANIFEST],
          ])
        : new Map([["base", CLEAN_MANIFEST]]);
      const harness = successfulToolHarness(manifests);
      const readDexEntries = (dexEntries) =>
        dexEntries.map((entry) =>
          Buffer.from(
            entry === offendingEntry
              ? RELOCATED_STRIPPED_DESCRIPTOR
              : "clean base dex",
            "utf8",
          ),
        );

      expect(() =>
        inspectAndroidAppBundle(
          inspectOptions({
            entries,
            readDexEntries,
            strippedComponents: [RELOCATED_STRIPPED_CLASS],
          }),
          harness.deps,
        ),
      ).toThrow(
        `${offendingEntry} contains forbidden stripped component class: ${RELOCATED_STRIPPED_CLASS}`,
      );
    },
  );

  it("does not reject DEX class-name lookalikes", () => {
    const harness = successfulToolHarness();
    const readDexEntries = () => [
      Buffer.from(
        "Lcom/feature/SafeElizaAgentService;Lcom/feature/ElizaAgentServiceProxy;",
        "utf8",
      ),
    ];

    expect(() =>
      inspectAndroidAppBundle(inspectOptions({ readDexEntries }), harness.deps),
    ).not.toThrow();
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
      "base/dex/classes.dex contains forbidden stripped component class: Lp3ColorPolicyService",
    );
  });

  it("rejects private LP3 class descriptors relocated to another package", () => {
    const harness = successfulToolHarness();
    const readDexEntries = () => [
      Buffer.from("Lcom/attacker/Lp3ColorPolicyService;", "utf8"),
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
      "base/dex/classes.dex contains forbidden stripped component class: Lp3ColorPolicyService",
    );
  });

  it("rejects a relocated LP3 initializer descriptor", () => {
    const harness = successfulToolHarness();
    const readDexEntries = () => [
      Buffer.from("Lcom/attacker/Lp3ColorPolicyInitializer;", "utf8"),
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
      "base/dex/classes.dex contains forbidden stripped component class: Lp3ColorPolicyInitializer",
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
      inspectAndroidAppBundle(
        inspectOptions({ readDexEntries }),
        verifiedToolDeps({ spawnSyncImpl }),
      ),
    ).toThrow("Bundle is not a valid zip file");
    expect(spawnSyncImpl).toHaveBeenCalledOnce();
    expect(readDexEntries).not.toHaveBeenCalled();
  });

  it("fails before spawning when the configured bundletool JAR is missing", () => {
    const spawnSyncImpl = vi.fn();

    expect(() =>
      inspectAndroidAppBundle(
        inspectOptions(),
        verifiedToolDeps({ existsSync: () => false, spawnSyncImpl }),
      ),
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
      inspectAndroidAppBundle(
        inspectOptions(),
        verifiedToolDeps({ spawnSyncImpl }),
      ),
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
      inspectAndroidAppBundle(
        inspectOptions(),
        verifiedToolDeps({ spawnSyncImpl }),
      ),
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
        verifiedToolDeps({ spawnSyncImpl }),
      ),
    ).toThrow("only accepts .aab artifacts");
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });
});
