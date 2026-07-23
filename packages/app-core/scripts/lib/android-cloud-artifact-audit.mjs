/**
 * Inspects Android App Bundles with Google's bundletool before Cloud artifacts
 * are accepted. APK inspection remains in the mobile build orchestrator because
 * its AAPT contract differs from the bundle-aware manifest and DEX layout here.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ElizaError } from "@elizaos/core/errors";

export const ANDROID_BUNDLETOOL_JAR_ENV = "ELIZA_ANDROID_BUNDLETOOL_JAR";
export const ANDROID_BUNDLETOOL_VERSION = "1.18.3";
export const ANDROID_BUNDLETOOL_SHA256 =
  "a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29";
export const ANDROID_BUNDLETOOL_URL = `https://github.com/google/bundletool/releases/download/${ANDROID_BUNDLETOOL_VERSION}/bundletool-all-${ANDROID_BUNDLETOOL_VERSION}.jar`;

export const ANDROID_LP3_PRIVATE_ACTIONS = Object.freeze([
  "ai.elizaos.app.action.ENABLE_LP3_COLOR_POLICY",
  "ai.elizaos.app.action.DISABLE_LP3_COLOR_POLICY",
  "ai.elizaos.app.action.SYNC_LP3_COLOR_POLICY",
]);

export const ANDROID_LP3_POLICY_CLASSES = Object.freeze([
  "Lp3ColorPolicy",
  "Lp3ColorPolicyService",
  "Lp3ColorPolicyBootReceiver",
]);

export const ANDROID_LP3_POLICY_PERMISSIONS = Object.freeze([
  "android.permission.WRITE_SECURE_SETTINGS",
  "android.permission.RECEIVE_BOOT_COMPLETED",
  "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
]);

export const ANDROID_LP3_POLICY_MARKERS = Object.freeze(["lp3_color_policy"]);

const AAB_MANIFEST_ENTRY = /^([^/\\]+)\/manifest\/AndroidManifest\.xml$/;
const AAB_DEX_ENTRY = /^([^/\\]+)\/dex\/classes\d*\.dex$/;
const MAX_TOOL_OUTPUT_BYTES = 16 * 1024 * 1024;

function androidAabAuditError(
  message,
  {
    cause,
    code = "ANDROID_AAB_AUDIT_FAILED",
    context,
    severity = "fatal",
  } = {},
) {
  return new ElizaError(message, {
    cause,
    code,
    context: {
      subsystem: "android-cloud-aab-audit",
      ...context,
    },
    severity,
  });
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw androidAabAuditError(
      `[mobile-build] ${label} must be a non-empty string.`,
    );
  }
  return value.trim();
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw androidAabAuditError(
      `[mobile-build] ${label} must be an array of strings.`,
    );
  }
  return value;
}

function isSafeModuleName(moduleName) {
  return (
    moduleName !== "." &&
    moduleName !== ".." &&
    !moduleName.includes("\0") &&
    !moduleName.includes("/")
  );
}

function qualifyComponent(appId, component) {
  const normalized = component.replace(/\.java$/, "");
  if (normalized.startsWith(".")) return `${appId}${normalized}`;
  if (normalized.includes(".")) return normalized;
  return `${appId}.${normalized}`;
}

function qualifyPermission(permission) {
  return permission.startsWith("android.permission.")
    ? permission
    : `android.permission.${permission}`;
}

function uniqueSorted(values, compare = (a, b) => a.localeCompare(b)) {
  return [...new Set(values)].sort(compare);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Makes the pinned official bundletool available to canonical builds.
 *
 * An explicitly configured JAR must match the same pinned digest. With no
 * override, download once into a content-verified temporary cache. The audit
 * never falls back to AAPT or an unpinned Gradle-cache artifact.
 */
export async function ensureAndroidBundletoolJar(
  {
    cacheDir = path.join(os.tmpdir(), "elizaos-bundletool"),
    env = process.env,
  } = {},
  {
    digestBuffer = sha256,
    existsSync = fs.existsSync,
    fetchImpl = globalThis.fetch,
    mkdirSync = fs.mkdirSync,
    readFileSync = fs.readFileSync,
    renameSync = fs.renameSync,
    rmSync = fs.rmSync,
    writeFileSync = fs.writeFileSync,
  } = {},
) {
  const configuredJar = env?.[ANDROID_BUNDLETOOL_JAR_ENV];
  if (typeof configuredJar === "string" && configuredJar.trim() !== "") {
    const resolvedJar = path.resolve(configuredJar.trim());
    if (!existsSync(resolvedJar)) {
      throw androidAabAuditError(
        `[mobile-build] ${ANDROID_BUNDLETOOL_JAR_ENV} does not exist: ${resolvedJar}`,
      );
    }
    const configuredDigest = digestBuffer(readFileSync(resolvedJar));
    if (configuredDigest !== ANDROID_BUNDLETOOL_SHA256) {
      throw androidAabAuditError(
        `[mobile-build] Refusing configured bundletool with SHA-256 ${configuredDigest}; expected ${ANDROID_BUNDLETOOL_SHA256}: ${resolvedJar}`,
      );
    }
    return resolvedJar;
  }
  if (typeof fetchImpl !== "function") {
    throw androidAabAuditError(
      "[mobile-build] global fetch is unavailable; set ELIZA_ANDROID_BUNDLETOOL_JAR explicitly.",
    );
  }

  const target = path.join(
    cacheDir,
    `bundletool-all-${ANDROID_BUNDLETOOL_VERSION}-${ANDROID_BUNDLETOOL_SHA256}.jar`,
  );
  if (
    existsSync(target) &&
    digestBuffer(readFileSync(target)) === ANDROID_BUNDLETOOL_SHA256
  ) {
    return target;
  }

  let response;
  try {
    response = await fetchImpl(ANDROID_BUNDLETOOL_URL, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    // error-policy:J2 identify the pinned dependency that could not be fetched
    throw androidAabAuditError(
      `[mobile-build] Could not download pinned bundletool ${ANDROID_BUNDLETOOL_VERSION}: ${error.message}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw androidAabAuditError(
      `[mobile-build] Could not download pinned bundletool ${ANDROID_BUNDLETOOL_VERSION}: HTTP ${response.status} ${response.statusText}`.trim(),
    );
  }

  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    // error-policy:J2 identify the pinned dependency whose response was unreadable
    throw androidAabAuditError(
      `[mobile-build] Could not read pinned bundletool ${ANDROID_BUNDLETOOL_VERSION} download: ${error.message}`,
      { cause: error },
    );
  }
  const digest = digestBuffer(bytes);
  if (digest !== ANDROID_BUNDLETOOL_SHA256) {
    throw androidAabAuditError(
      `[mobile-build] Refusing bundletool ${ANDROID_BUNDLETOOL_VERSION} with SHA-256 ${digest}; expected ${ANDROID_BUNDLETOOL_SHA256}.`,
    );
  }

  mkdirSync(cacheDir, { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    if (
      existsSync(target) &&
      digestBuffer(readFileSync(target)) === ANDROID_BUNDLETOOL_SHA256
    ) {
      return target;
    }
    rmSync(target, { force: true });
    renameSync(temporary, target);
    return target;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function resolveAndroidArtifactKind(artifact) {
  const resolvedArtifact = requireNonEmptyString(
    artifact,
    "Android artifact path",
  );
  const extension = path.extname(resolvedArtifact).toLowerCase();
  if (extension === ".apk") return "apk";
  if (extension === ".aab") return "aab";
  throw androidAabAuditError(
    `[mobile-build] Android artifact must end in .apk or .aab: ${resolvedArtifact}`,
  );
}

/**
 * Finds each module whose compiled manifest bundletool can decode.
 */
export function listAabManifestModules(entries) {
  requireStringArray(entries, "Android App Bundle entries");
  const modules = [];
  for (const entry of entries) {
    const match = entry.match(AAB_MANIFEST_ENTRY);
    if (!match) continue;
    const moduleName = match[1];
    if (!isSafeModuleName(moduleName)) {
      throw androidAabAuditError(
        `[mobile-build] Android App Bundle contains an unsafe module name: ${moduleName}`,
      );
    }
    modules.push(moduleName);
  }

  const sorted = uniqueSorted(modules, (left, right) => {
    if (left === "base") return -1;
    if (right === "base") return 1;
    return left.localeCompare(right);
  });
  if (!sorted.includes("base")) {
    throw androidAabAuditError(
      "[mobile-build] Android App Bundle is missing base/manifest/AndroidManifest.xml.",
    );
  }
  return sorted;
}

/**
 * Selects code entries from every module while rejecting extraction paths that
 * could escape the caller's temporary directory.
 */
export function listAabDexEntries(entries) {
  requireStringArray(entries, "Android App Bundle entries");
  const dexEntries = [];
  for (const entry of entries) {
    const match = entry.match(AAB_DEX_ENTRY);
    if (!match) continue;
    if (!isSafeModuleName(match[1])) {
      throw androidAabAuditError(
        `[mobile-build] Android App Bundle contains an unsafe DEX module name: ${match[1]}`,
      );
    }
    dexEntries.push(entry);
  }
  return uniqueSorted(dexEntries);
}

/**
 * Resolves the official bundletool fat JAR and the JDK executable used to run
 * it. An explicit JAR keeps local and CI audits on the same trusted tool.
 */
export function resolveBundletoolInvocation(
  { env = process.env, javaHome } = {},
  {
    existsSync = fs.existsSync,
    platform = process.platform,
    resolvePath = path.resolve,
  } = {},
) {
  const configuredJar = env?.[ANDROID_BUNDLETOOL_JAR_ENV];
  if (typeof configuredJar !== "string" || configuredJar.trim() === "") {
    throw androidAabAuditError(
      `[mobile-build] ${ANDROID_BUNDLETOOL_JAR_ENV} must point to an official bundletool-all JAR for Android App Bundle inspection.`,
    );
  }
  const bundletoolJar = resolvePath(configuredJar.trim());
  if (!existsSync(bundletoolJar)) {
    throw androidAabAuditError(
      `[mobile-build] bundletool JAR not found at ${bundletoolJar} (${ANDROID_BUNDLETOOL_JAR_ENV}).`,
    );
  }

  const resolvedJavaHome = requireNonEmptyString(
    javaHome,
    "JAVA_HOME for bundletool",
  );
  const javaExecutable = path.join(
    resolvedJavaHome,
    "bin",
    platform === "win32" ? "java.exe" : "java",
  );
  if (!existsSync(javaExecutable)) {
    throw androidAabAuditError(
      `[mobile-build] Java executable for bundletool not found at ${javaExecutable}.`,
    );
  }

  return {
    command: javaExecutable,
    argsPrefix: ["-jar", bundletoolJar],
    bundletoolJar,
  };
}

/**
 * Runs a bundletool command and converts every process-level failure into an
 * observable build failure with the tool's diagnostics intact.
 */
export function runCheckedBundletool(
  invocation,
  args,
  label,
  { spawnSyncImpl = spawnSync } = {},
) {
  const result = spawnSyncImpl(
    invocation.command,
    [...invocation.argsPrefix, ...args],
    {
      encoding: "utf8",
      maxBuffer: MAX_TOOL_OUTPUT_BYTES,
      windowsHide: true,
    },
  );
  if (result?.error) {
    throw androidAabAuditError(
      `[mobile-build] ${label} failed to start: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result?.status !== 0) {
    const stdout = String(result?.stdout ?? "").trim();
    const stderr = String(result?.stderr ?? "").trim();
    const termination = result?.signal
      ? `terminated by signal ${result.signal}`
      : `exited with ${String(result?.status)}`;
    throw androidAabAuditError(
      `[mobile-build] ${label} failed: ${stderr || stdout || termination}`,
    );
  }
  return String(result.stdout ?? "");
}

function assertManifestDoesNotContain(
  moduleName,
  manifestText,
  marker,
  description,
) {
  if (manifestText.includes(marker)) {
    throw androidAabAuditError(
      `[mobile-build] android-cloud AAB module ${moduleName} contains forbidden ${description}: ${marker}`,
    );
  }
}

/**
 * Applies Cloud strip policy to decoded manifests from every bundle module.
 */
export function assertAabManifestPolicy({
  manifests,
  appId,
  strippedComponents,
  strippedPermissions,
}) {
  const resolvedAppId = requireNonEmptyString(appId, "Android application ID");
  requireStringArray(strippedComponents, "stripped Android components");
  requireStringArray(strippedPermissions, "stripped Android permissions");
  if (!(manifests instanceof Map) || manifests.size === 0) {
    throw androidAabAuditError(
      "[mobile-build] decoded Android App Bundle manifests must be a non-empty Map.",
    );
  }

  const forbiddenComponents = uniqueSorted([
    ...strippedComponents.map((component) =>
      qualifyComponent(resolvedAppId, component),
    ),
    ...ANDROID_LP3_POLICY_CLASSES.map(
      (className) => `${resolvedAppId}.${className}`,
    ),
  ]);
  const forbiddenPermissions = uniqueSorted([
    ...strippedPermissions.map(qualifyPermission),
    ...ANDROID_LP3_POLICY_PERMISSIONS,
  ]);

  for (const [moduleName, manifestText] of manifests) {
    if (typeof manifestText !== "string" || manifestText.trim() === "") {
      throw androidAabAuditError(
        `[mobile-build] bundletool returned an empty manifest for AAB module ${moduleName}.`,
      );
    }
    for (const permission of forbiddenPermissions) {
      assertManifestDoesNotContain(
        moduleName,
        manifestText,
        permission,
        "permission",
      );
    }
    for (const component of forbiddenComponents) {
      assertManifestDoesNotContain(
        moduleName,
        manifestText,
        component,
        "component",
      );
    }
    for (const action of ANDROID_LP3_PRIVATE_ACTIONS) {
      assertManifestDoesNotContain(
        moduleName,
        manifestText,
        action,
        "LP3 action",
      );
    }
    for (const marker of ANDROID_LP3_POLICY_MARKERS) {
      assertManifestDoesNotContain(
        moduleName,
        manifestText,
        marker,
        "LP3 policy marker",
      );
    }
  }
}

function normalizeDexBuffers(dexEntries, dexBuffers) {
  if (!Array.isArray(dexBuffers)) {
    throw androidAabAuditError(
      "[mobile-build] readDexEntries must return one Buffer or Uint8Array per DEX entry.",
    );
  }
  if (dexBuffers.length !== dexEntries.length) {
    throw androidAabAuditError(
      `[mobile-build] readDexEntries returned ${dexBuffers.length} buffers for ${dexEntries.length} DEX entries.`,
    );
  }
  return dexBuffers.map((buffer, index) => {
    if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
      throw androidAabAuditError(
        `[mobile-build] readDexEntries returned an invalid buffer for ${dexEntries[index]}.`,
      );
    }
    return Buffer.from(buffer);
  });
}

/**
 * Scans all module DEX files for private LP3 implementation and control-plane
 * markers, including features that a universal APK can omit.
 */
export function assertAabDexPolicy({ appId, dexEntries, dexBuffers }) {
  const resolvedAppId = requireNonEmptyString(appId, "Android application ID");
  requireStringArray(dexEntries, "Android App Bundle DEX entries");
  const buffers = normalizeDexBuffers(dexEntries, dexBuffers);
  const packagePath = resolvedAppId.replaceAll(".", "/");
  const forbiddenMarkers = uniqueSorted(
    [
      ...ANDROID_LP3_POLICY_CLASSES.flatMap((className) => [
        `${packagePath}/${className}`,
        `${resolvedAppId}.${className}`,
      ]),
      ...ANDROID_LP3_PRIVATE_ACTIONS,
      ...ANDROID_LP3_POLICY_MARKERS,
    ],
    (left, right) => right.length - left.length || left.localeCompare(right),
  );

  for (let index = 0; index < buffers.length; index += 1) {
    for (const marker of forbiddenMarkers) {
      if (buffers[index].includes(Buffer.from(marker, "utf8"))) {
        throw androidAabAuditError(
          `[mobile-build] android-cloud AAB DEX ${dexEntries[index]} contains forbidden LP3 marker: ${marker}`,
        );
      }
    }
  }
}

/**
 * Validates an AAB, decodes every module manifest, and scans every module DEX.
 *
 * `readDexEntries` receives `(dexEntries, { artifact, javaHome })` and must
 * return buffers in the same order. Extraction stays with the orchestrator so
 * its existing JDK `jar` behavior can be reused without coupling it here.
 */
export function inspectAndroidAppBundle(
  {
    artifact,
    entries,
    appId,
    strippedComponents,
    strippedPermissions,
    javaHome,
    env = process.env,
    readDexEntries,
  },
  {
    existsSync = fs.existsSync,
    platform = process.platform,
    resolvePath = path.resolve,
    spawnSyncImpl = spawnSync,
  } = {},
) {
  const resolvedArtifact = requireNonEmptyString(
    artifact,
    "Android App Bundle path",
  );
  if (resolveAndroidArtifactKind(resolvedArtifact) !== "aab") {
    throw androidAabAuditError(
      `[mobile-build] inspectAndroidAppBundle only accepts .aab artifacts: ${resolvedArtifact}`,
    );
  }
  requireStringArray(entries, "Android App Bundle entries");
  if (typeof readDexEntries !== "function") {
    throw androidAabAuditError(
      "[mobile-build] inspectAndroidAppBundle requires a readDexEntries function.",
    );
  }

  const invocation = resolveBundletoolInvocation(
    { env, javaHome },
    { existsSync, platform, resolvePath },
  );
  runCheckedBundletool(
    invocation,
    ["validate", `--bundle=${resolvedArtifact}`],
    `Could not validate ${resolvedArtifact} with bundletool`,
    { spawnSyncImpl },
  );

  const modules = listAabManifestModules(entries);
  const manifests = new Map();
  for (const moduleName of modules) {
    const manifestText = runCheckedBundletool(
      invocation,
      [
        "dump",
        "manifest",
        `--bundle=${resolvedArtifact}`,
        `--module=${moduleName}`,
      ],
      `Could not inspect ${resolvedArtifact} module ${moduleName} manifest with bundletool`,
      { spawnSyncImpl },
    );
    if (manifestText.trim() === "") {
      throw androidAabAuditError(
        `[mobile-build] bundletool returned an empty manifest for AAB module ${moduleName}.`,
      );
    }
    manifests.set(moduleName, manifestText);
  }

  assertAabManifestPolicy({
    manifests,
    appId,
    strippedComponents,
    strippedPermissions,
  });

  const dexEntries = listAabDexEntries(entries);
  if (dexEntries.length === 0) {
    throw androidAabAuditError(
      `[mobile-build] Android App Bundle has no module dex/classes*.dex entries: ${resolvedArtifact}`,
    );
  }
  const dexBuffers = readDexEntries(dexEntries, {
    artifact: resolvedArtifact,
    javaHome,
  });
  assertAabDexPolicy({ appId, dexEntries, dexBuffers });

  return { modules, dexEntries };
}
