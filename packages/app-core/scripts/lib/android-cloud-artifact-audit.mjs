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
import { performance } from "node:perf_hooks";
import process from "node:process";
import { SaxesParser } from "saxes";

import { ElizaError } from "./eliza-error.mjs";

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
  "Lp3ColorPolicyInitializer",
  "Lp3ColorPolicyService",
  "Lp3ColorPolicyBootReceiver",
]);

export const ANDROID_LP3_POLICY_PERMISSIONS = Object.freeze([
  "android.permission.WRITE_SECURE_SETTINGS",
  "android.permission.RECEIVE_BOOT_COMPLETED",
  "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
]);

export const ANDROID_LP3_POLICY_MARKERS = Object.freeze(["lp3_color_policy"]);

// Product-specific local-runtime and sideload implementation markers that must
// never survive R8 into the Google Play Cloud artifact. Keep this list narrow:
// generic strings such as "localhost" occur legitimately in AndroidX/vendor
// bytecode and are audited at the renderer/source boundary instead.
export const ANDROID_PLAY_FORBIDDEN_DEX_MARKERS = Object.freeze([
  "10.0.2.2",
  "31337",
  "31338",
  "32437",
  "32438",
  "__ELIZA_ANDROID_IPC_FETCH_BRIDGE__",
  "adb reverse",
  "eliza-local-agent:",
  "eliza_bionic_infer_v1",
  "Landroid/net/LocalSocket;",
  "remote-mac",
  "TalkModePlugin",
]);

const AAB_MANIFEST_ENTRY = /^([^/\\]+)\/manifest\/AndroidManifest\.xml$/;
const AAB_DEX_ENTRY = /^([^/\\]+)\/dex\/classes\d*\.dex$/;
const AAB_STRAY_DEX_ENTRY = /\.dex$/i;
const ANDROID_XML_NAMESPACE = "http://schemas.android.com/apk/res/android";
const MANIFEST_COMPONENT_ELEMENTS = Object.freeze([
  "activity",
  "activity-alias",
  "provider",
  "receiver",
  "service",
]);
const MAX_TOOL_OUTPUT_BYTES = 16 * 1024 * 1024;
export const ANDROID_BUNDLETOOL_TIMEOUT_MS = 120_000;
export const ANDROID_AAB_AUDIT_TIMEOUT_MS = 300_000;
export const ANDROID_AAB_MAX_MANIFEST_MODULES = 128;
export const ANDROID_AAB_MAX_DEX_ENTRIES = 4_096;
export const ANDROID_AAB_MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const ANDROID_AAB_MAX_MANIFEST_TOTAL_BYTES = 16 * 1024 * 1024;

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

function requirePositiveLimit(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw androidAabAuditError(
      `[mobile-build] ${label} must be a positive safe integer.`,
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

function androidClassBasename(className) {
  let normalized = requireNonEmptyString(
    className,
    "stripped Android class name",
  ).replace(/\.java$/, "");
  if (normalized.startsWith("L") && normalized.endsWith(";")) {
    normalized = normalized.slice(1, -1);
  }
  const separatorIndex = Math.max(
    normalized.lastIndexOf("."),
    normalized.lastIndexOf("/"),
  );
  return normalized.slice(separatorIndex + 1);
}

function matchesAndroidClassBasename(candidate, classBasename) {
  return (
    candidate === classBasename ||
    candidate.endsWith(`.${classBasename}`) ||
    candidate.endsWith(`/${classBasename}`)
  );
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

function verifyPinnedBundletoolJar(
  bundletoolJar,
  { digestBuffer = sha256, readFileSync = fs.readFileSync } = {},
) {
  let bytes;
  try {
    bytes = readFileSync(bundletoolJar);
  } catch (error) {
    // error-policy:J2 identify the pinned executable that could not be verified
    throw androidAabAuditError(
      `[mobile-build] Could not read bundletool JAR for SHA-256 verification: ${bundletoolJar}`,
      {
        cause: error,
        code: "ANDROID_BUNDLETOOL_INTEGRITY_FAILED",
        context: { bundletoolJar },
      },
    );
  }

  let digest;
  try {
    digest = digestBuffer(bytes);
  } catch (error) {
    // error-policy:J2 identify the pinned executable whose digest could not be computed
    throw androidAabAuditError(
      `[mobile-build] Could not compute bundletool JAR SHA-256: ${bundletoolJar}`,
      {
        cause: error,
        code: "ANDROID_BUNDLETOOL_INTEGRITY_FAILED",
        context: { bundletoolJar },
      },
    );
  }
  if (digest !== ANDROID_BUNDLETOOL_SHA256) {
    throw androidAabAuditError(
      `[mobile-build] Refusing bundletool with SHA-256 ${digest}; expected ${ANDROID_BUNDLETOOL_SHA256}: ${bundletoolJar}`,
      {
        code: "ANDROID_BUNDLETOOL_INTEGRITY_FAILED",
        context: {
          actualSha256: digest,
          bundletoolJar,
          expectedSha256: ANDROID_BUNDLETOOL_SHA256,
        },
      },
    );
  }
  return digest;
}

function isVerifiedBundletoolCacheEntry(bundletoolJar, dependencies) {
  try {
    verifyPinnedBundletoolJar(bundletoolJar, dependencies);
    return true;
  } catch (error) {
    // error-policy:J4 a checksum-mismatched cache entry is replaced by the pinned download
    if (
      error instanceof ElizaError &&
      error.code === "ANDROID_BUNDLETOOL_INTEGRITY_FAILED" &&
      typeof error.context?.actualSha256 === "string"
    ) {
      return false;
    }
    throw error;
  }
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
    verifyPinnedBundletoolJar(resolvedJar, {
      digestBuffer,
      readFileSync,
    });
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
    isVerifiedBundletoolCacheEntry(target, {
      digestBuffer,
      readFileSync,
    })
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
  let digest;
  try {
    digest = digestBuffer(bytes);
  } catch (error) {
    // error-policy:J2 preserve download provenance when checksum computation fails
    throw androidAabAuditError(
      `[mobile-build] Could not compute downloaded bundletool ${ANDROID_BUNDLETOOL_VERSION} SHA-256.`,
      {
        cause: error,
        code: "ANDROID_BUNDLETOOL_INTEGRITY_FAILED",
        context: { source: ANDROID_BUNDLETOOL_URL },
      },
    );
  }
  if (digest !== ANDROID_BUNDLETOOL_SHA256) {
    throw androidAabAuditError(
      `[mobile-build] Refusing bundletool ${ANDROID_BUNDLETOOL_VERSION} with SHA-256 ${digest}; expected ${ANDROID_BUNDLETOOL_SHA256}.`,
      {
        code: "ANDROID_BUNDLETOOL_INTEGRITY_FAILED",
        context: {
          actualSha256: digest,
          expectedSha256: ANDROID_BUNDLETOOL_SHA256,
          source: ANDROID_BUNDLETOOL_URL,
        },
      },
    );
  }

  mkdirSync(cacheDir, { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    if (
      existsSync(target) &&
      isVerifiedBundletoolCacheEntry(target, {
        digestBuffer,
        readFileSync,
      })
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
export function listAabManifestModules(
  entries,
  { maxModules = ANDROID_AAB_MAX_MANIFEST_MODULES } = {},
) {
  requireStringArray(entries, "Android App Bundle entries");
  requirePositiveLimit(maxModules, "Android App Bundle manifest module limit");
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
  if (sorted.length > maxModules) {
    throw androidAabAuditError(
      `[mobile-build] Android App Bundle exceeds the ${maxModules}-module manifest audit limit.`,
      {
        code: "ANDROID_AAB_WORKLOAD_LIMIT_EXCEEDED",
        context: { maxModules, moduleCount: sorted.length },
      },
    );
  }
  return sorted;
}

/**
 * Selects code entries from every module while rejecting extraction paths that
 * could escape the caller's temporary directory. Any other packaged `.dex`
 * (for example one smuggled under `base/assets/` for runtime DexClassLoader
 * use) is selected too, so the marker policy covers every loadable code path —
 * the retained APK contract scans `classes*.dex` at any depth for the same
 * reason.
 */
export function listAabDexEntries(
  entries,
  { maxEntries = ANDROID_AAB_MAX_DEX_ENTRIES } = {},
) {
  requireStringArray(entries, "Android App Bundle entries");
  requirePositiveLimit(maxEntries, "Android App Bundle DEX entry limit");
  const dexEntries = [];
  for (const entry of entries) {
    const match = entry.match(AAB_DEX_ENTRY);
    if (match) {
      if (!isSafeModuleName(match[1])) {
        throw androidAabAuditError(
          `[mobile-build] Android App Bundle contains an unsafe DEX module name: ${match[1]}`,
        );
      }
      dexEntries.push(entry);
      continue;
    }
    if (AAB_STRAY_DEX_ENTRY.test(entry)) {
      const segments = entry.split("/");
      if (
        entry.includes("\\") ||
        entry.includes("\0") ||
        segments.some(
          (segment) => segment === "" || segment === "." || segment === "..",
        )
      ) {
        throw androidAabAuditError(
          `[mobile-build] Android App Bundle contains an unsafe DEX entry path: ${entry}`,
        );
      }
      dexEntries.push(entry);
    }
  }
  const sorted = uniqueSorted(dexEntries);
  if (sorted.length > maxEntries) {
    throw androidAabAuditError(
      `[mobile-build] Android App Bundle exceeds the ${maxEntries}-entry DEX audit limit.`,
      {
        code: "ANDROID_AAB_WORKLOAD_LIMIT_EXCEEDED",
        context: { dexEntryCount: sorted.length, maxEntries },
      },
    );
  }
  return sorted;
}

/**
 * Resolves the official bundletool fat JAR and the JDK executable used to run
 * it. The environment override names a location, not a trust bypass: its bytes
 * must match the pinned digest here and again immediately before each command.
 */
export function resolveBundletoolInvocation(
  { env = process.env, javaHome } = {},
  {
    digestBuffer = sha256,
    existsSync = fs.existsSync,
    platform = process.platform,
    readFileSync = fs.readFileSync,
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
  const bundletoolDigest = verifyPinnedBundletoolJar(bundletoolJar, {
    digestBuffer,
    readFileSync,
  });

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
    bundletoolDigest,
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
  {
    digestBuffer = sha256,
    readFileSync = fs.readFileSync,
    spawnSyncImpl = spawnSync,
    timeoutMs = ANDROID_BUNDLETOOL_TIMEOUT_MS,
  } = {},
) {
  requirePositiveLimit(timeoutMs, "bundletool command timeout");
  verifyPinnedBundletoolJar(invocation.bundletoolJar, {
    digestBuffer,
    readFileSync,
  });
  const result = spawnSyncImpl(
    invocation.command,
    [...invocation.argsPrefix, ...args],
    {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: MAX_TOOL_OUTPUT_BYTES,
      timeout: timeoutMs,
      windowsHide: true,
    },
  );
  if (result?.error?.code === "ETIMEDOUT") {
    const stderr = String(result.stderr ?? "").trim();
    const stdout = String(result.stdout ?? "").trim();
    const diagnostics = [stderr, stdout].filter(Boolean);
    const diagnosticSuffix =
      diagnostics.length > 0 ? ` Diagnostics: ${diagnostics.join(" | ")}` : "";
    throw androidAabAuditError(
      `[mobile-build] ${label} timed out after ${timeoutMs} ms and was terminated. Verify JAVA_HOME points to a responsive JDK 21, check host resources, and retry.${diagnosticSuffix}`,
      {
        cause: result.error,
        code: "ANDROID_BUNDLETOOL_TIMEOUT",
        context: {
          bundletoolJar: invocation.bundletoolJar,
          label,
          signal: result.signal ?? null,
          timeoutMs,
        },
      },
    );
  }
  if (result?.signal) {
    const stderr = String(result.stderr ?? "").trim();
    const stdout = String(result.stdout ?? "").trim();
    const diagnostics = [stderr, stdout].filter(Boolean);
    const diagnosticSuffix =
      diagnostics.length > 0 ? ` Diagnostics: ${diagnostics.join(" | ")}` : "";
    throw androidAabAuditError(
      `[mobile-build] ${label} was terminated by signal ${result.signal}. Check host resource limits and Java diagnostics, then retry.${diagnosticSuffix}`,
      {
        ...(result.error ? { cause: result.error } : {}),
        code: "ANDROID_BUNDLETOOL_TERMINATED",
        context: {
          bundletoolJar: invocation.bundletoolJar,
          label,
          signal: result.signal,
        },
      },
    );
  }
  if (result?.error) {
    const diagnostics = [
      result.error.message,
      String(result.stderr ?? "").trim(),
      String(result.stdout ?? "").trim(),
    ].filter(Boolean);
    throw androidAabAuditError(
      `[mobile-build] ${label} failed to start: ${diagnostics.join(" | ")}`,
      { cause: result.error },
    );
  }
  if (result?.status !== 0) {
    const stdout = String(result?.stdout ?? "").trim();
    const stderr = String(result?.stderr ?? "").trim();
    const termination = `exited with ${String(result?.status)}`;
    const diagnostics = [termination, stderr, stdout].filter(Boolean);
    throw androidAabAuditError(
      `[mobile-build] ${label} failed: ${diagnostics.join(" | ")}`,
    );
  }
  return String(result.stdout ?? "");
}

function parseXmlOpeningTags(xml) {
  const tags = [];
  const ancestors = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => {
    tags.push({
      ancestors: [...ancestors],
      attributes: Object.values(tag.attributes).map((attribute) => ({
        localName: attribute.local,
        name: attribute.name,
        namespaceUri: attribute.uri,
        value: attribute.value,
      })),
      name: tag.local,
      namespaceUri: tag.uri,
      qualifiedName: tag.name,
    });
    ancestors.push(tag.local);
  });
  parser.on("closetag", () => {
    ancestors.pop();
  });
  try {
    parser.write(xml).close();
  } catch (cause) {
    // error-policy:J2 retain the manifest parser failure as the audit cause
    throw androidAabAuditError(
      `[mobile-build] bundletool returned malformed manifest XML: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
        code: "ANDROID_AAB_MANIFEST_INVALID",
      },
    );
  }
  return tags;
}

function readXmlAttribute(tag, namespaceUri, localName) {
  return (
    tag.attributes.find(
      (attribute) =>
        attribute.namespaceUri === namespaceUri &&
        attribute.localName === localName,
    )?.value ?? null
  );
}

function readManifestPackageName(manifestText) {
  return (
    parseXmlOpeningTags(manifestText)
      .find((tag) => tag.name === "manifest")
      ?.attributes.find(
        (attribute) =>
          attribute.namespaceUri === "" && attribute.localName === "package",
      )?.value ?? null
  );
}

function manifestPolicyEvidence(moduleName, manifestText) {
  const tags = parseXmlOpeningTags(manifestText);
  const androidAttributeValues = (elementNames, localName) =>
    uniqueSorted(
      tags
        .filter((tag) => elementNames.includes(tag.name))
        .map((tag) => readXmlAttribute(tag, ANDROID_XML_NAMESPACE, localName))
        .filter(Boolean),
    );
  const application = tags.find((tag) => tag.name === "application");
  const usesSdk = tags.find((tag) => tag.name === "uses-sdk");
  const isInsideQueries = (tag) => tag.ancestors.includes("queries");
  return {
    actions: androidAttributeValues(["action"], "name"),
    application: {
      allowBackup: application
        ? readXmlAttribute(application, ANDROID_XML_NAMESPACE, "allowBackup")
        : null,
      debuggable: application
        ? (readXmlAttribute(application, ANDROID_XML_NAMESPACE, "debuggable") ??
          "false")
        : "false",
      usesCleartextTraffic: application
        ? readXmlAttribute(
            application,
            ANDROID_XML_NAMESPACE,
            "usesCleartextTraffic",
          )
        : null,
    },
    components: uniqueSorted(
      tags
        .filter((tag) => MANIFEST_COMPONENT_ELEMENTS.includes(tag.name))
        .map((tag) => {
          const componentName = readXmlAttribute(
            tag,
            ANDROID_XML_NAMESPACE,
            "name",
          );
          return componentName ? `${tag.name}:${componentName}` : null;
        })
        .filter(Boolean),
    ),
    metadataNames: androidAttributeValues(["meta-data"], "name"),
    module: moduleName,
    packageName: readManifestPackageName(manifestText),
    permissions: androidAttributeValues(
      ["uses-permission", "uses-permission-sdk-23"],
      "name",
    ),
    queryActions: uniqueSorted(
      tags
        .filter((tag) => tag.name === "action" && isInsideQueries(tag))
        .map((tag) => readXmlAttribute(tag, ANDROID_XML_NAMESPACE, "name"))
        .filter(Boolean),
    ),
    queryPackages: uniqueSorted(
      tags
        .filter((tag) => tag.name === "package" && isInsideQueries(tag))
        .map((tag) => readXmlAttribute(tag, ANDROID_XML_NAMESPACE, "name"))
        .filter(Boolean),
    ),
    sha256: sha256(Buffer.from(manifestText, "utf8")),
    sizeBytes: Buffer.byteLength(manifestText, "utf8"),
    targetSdkVersion: usesSdk
      ? readXmlAttribute(usesSdk, ANDROID_XML_NAMESPACE, "targetSdkVersion")
      : null,
  };
}

function appendExactSetFindings(findings, actual, expected, label) {
  const actualValues = uniqueSorted(actual);
  const expectedValues = uniqueSorted(expected);
  for (const value of actualValues.filter(
    (candidate) => !expectedValues.includes(candidate),
  )) {
    findings.push(
      `android-cloud manifest contains unexpected ${label}: ${value}`,
    );
  }
  for (const value of expectedValues.filter(
    (candidate) => !actualValues.includes(candidate),
  )) {
    findings.push(
      `android-cloud manifest is missing required ${label}: ${value}`,
    );
  }
}

/**
 * Enforces the deliberately small Play-client manifest as a positive contract.
 * Every field is exact so dependency-manifest expansion fails closed.
 */
export function assertAndroidPlayManifestPolicyEvidence(evidence, policy) {
  if (!evidence || typeof evidence !== "object") {
    throw androidAabAuditError(
      "[mobile-build] Android Play manifest evidence must be an object.",
    );
  }
  if (!policy || typeof policy !== "object") {
    throw androidAabAuditError(
      "[mobile-build] Android Play manifest policy must be an object.",
    );
  }
  const findings = [];
  for (const [field, label] of [
    ["permissions", "permission"],
    ["components", "component"],
    ["actions", "action"],
    ["metadataNames", "metadata entry"],
    ["queryActions", "query action"],
    ["queryPackages", "query package"],
  ]) {
    requireStringArray(evidence[field], `Android Play manifest ${field}`);
    requireStringArray(policy[field], `allowed Android Play manifest ${field}`);
    appendExactSetFindings(findings, evidence[field], policy[field], label);
  }

  if (String(evidence.targetSdkVersion) !== String(policy.targetSdkVersion)) {
    findings.push(
      `android-cloud manifest targetSdkVersion ${String(evidence.targetSdkVersion)} does not equal ${String(policy.targetSdkVersion)}`,
    );
  }
  for (const field of ["allowBackup", "usesCleartextTraffic"]) {
    if (
      String(evidence.application?.[field]) !==
      String(policy.application?.[field])
    ) {
      findings.push(
        `android-cloud manifest application ${field}=${String(evidence.application?.[field])} does not equal ${String(policy.application?.[field])}`,
      );
    }
  }
  if (
    policy.application?.debuggable !== undefined &&
    String(evidence.application?.debuggable) !==
      String(policy.application.debuggable)
  ) {
    findings.push(
      `android-cloud manifest application debuggable=${String(evidence.application?.debuggable)} does not equal ${String(policy.application.debuggable)}`,
    );
  }

  if (findings.length > 0) {
    const uniqueFindings = uniqueSorted(findings);
    throw androidAabAuditError(
      `[mobile-build] Android Play manifest allowlist failed:\n${uniqueFindings
        .map((finding) => `  - ${finding}`)
        .join("\n")}`,
      {
        code: "ANDROID_PLAY_MANIFEST_ALLOWLIST_FAILED",
        context: { findings: uniqueFindings },
      },
    );
  }
}

function collectManifestPolicyFinding(
  findings,
  moduleName,
  manifestText,
  marker,
  description,
) {
  if (manifestText.includes(marker)) {
    findings.push(
      `android-cloud AAB module ${moduleName} contains forbidden ${description}: ${marker}`,
    );
  }
}

/**
 * Applies Cloud strip policy to decoded manifests from every bundle module.
 */
export function assertAabManifestPolicy({
  manifests,
  appId,
  playPolicy,
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

  const forbiddenComponentClasses = uniqueSorted(
    strippedComponents.map(androidClassBasename),
  );
  const forbiddenPermissions = uniqueSorted([
    ...strippedPermissions.map(qualifyPermission),
    ...ANDROID_LP3_POLICY_PERMISSIONS,
  ]);
  const baseManifest = manifests.get("base");
  if (typeof baseManifest !== "string" || baseManifest.trim() === "") {
    throw androidAabAuditError(
      "[mobile-build] decoded Android App Bundle manifests must include a non-empty base manifest.",
    );
  }
  const manifestPackage = readManifestPackageName(baseManifest);
  if (!manifestPackage) {
    throw androidAabAuditError(
      "[mobile-build] android-cloud AAB base manifest is missing its package identity.",
    );
  }
  if (manifestPackage !== resolvedAppId) {
    throw androidAabAuditError(
      `[mobile-build] android-cloud AAB package ${manifestPackage} does not match expected application ID ${resolvedAppId}.`,
    );
  }

  const findings = [];
  for (const [moduleName, manifestText] of manifests) {
    if (typeof manifestText !== "string" || manifestText.trim() === "") {
      throw androidAabAuditError(
        `[mobile-build] bundletool returned an empty manifest for AAB module ${moduleName}.`,
      );
    }
    const tags = parseXmlOpeningTags(manifestText);
    const androidAttributeValues = (elementNames, localName) =>
      uniqueSorted(
        tags
          .filter((tag) => elementNames.includes(tag.name))
          .map((tag) => readXmlAttribute(tag, ANDROID_XML_NAMESPACE, localName))
          .filter(Boolean),
      );
    const manifestPermissions = androidAttributeValues(
      ["uses-permission", "uses-permission-sdk-23"],
      "name",
    );
    for (const permission of forbiddenPermissions) {
      if (manifestPermissions.includes(permission)) {
        findings.push(
          `android-cloud AAB module ${moduleName} contains forbidden permission: ${permission}`,
        );
      }
    }
    const componentTags = tags.filter((tag) =>
      MANIFEST_COMPONENT_ELEMENTS.includes(tag.name),
    );
    for (const tag of componentTags) {
      for (const attributeName of [
        "permission",
        "readPermission",
        "writePermission",
      ]) {
        const permission = readXmlAttribute(
          tag,
          ANDROID_XML_NAMESPACE,
          attributeName,
        );
        if (permission && forbiddenPermissions.includes(permission)) {
          findings.push(
            `android-cloud AAB module ${moduleName} contains forbidden component ${attributeName}: ${permission}`,
          );
        }
      }
    }
    const manifestComponents = componentTags
      .map((tag) => readXmlAttribute(tag, ANDROID_XML_NAMESPACE, "name"))
      .filter(Boolean);
    for (const component of manifestComponents) {
      const forbiddenClass = forbiddenComponentClasses.find((className) =>
        matchesAndroidClassBasename(component, className),
      );
      if (forbiddenClass) {
        findings.push(
          `android-cloud AAB module ${moduleName} contains forbidden component: ${component}`,
        );
      }
      const privateClass = ANDROID_LP3_POLICY_CLASSES.find((className) =>
        matchesAndroidClassBasename(component, className),
      );
      if (!forbiddenClass && privateClass) {
        findings.push(
          `android-cloud AAB module ${moduleName} contains forbidden LP3 component: ${component}`,
        );
      }
    }
    const manifestActions = androidAttributeValues(["action"], "name");
    for (const action of ANDROID_LP3_PRIVATE_ACTIONS) {
      if (manifestActions.includes(action)) {
        findings.push(
          `android-cloud AAB module ${moduleName} contains forbidden LP3 action: ${action}`,
        );
      }
    }
    for (const marker of ANDROID_LP3_POLICY_MARKERS) {
      collectManifestPolicyFinding(
        findings,
        moduleName,
        manifestText,
        marker,
        "LP3 policy marker",
      );
    }
  }
  if (findings.length > 0) {
    const uniqueFindings = uniqueSorted(findings);
    throw androidAabAuditError(
      `[mobile-build] Android App Bundle manifest policy failed:\n${uniqueFindings
        .map((finding) => `  - ${finding}`)
        .join("\n")}`,
      {
        context: {
          findings: uniqueFindings,
          modules: [...manifests.keys()],
        },
      },
    );
  }
  if (playPolicy) {
    const manifestEvidence = [...manifests.entries()].map(
      ([moduleName, manifestText]) =>
        manifestPolicyEvidence(moduleName, manifestText),
    );
    const baseEvidence = manifestEvidence.find(
      (moduleEvidence) => moduleEvidence.module === "base",
    );
    assertAndroidPlayManifestPolicyEvidence(
      {
        actions: uniqueSorted(
          manifestEvidence.flatMap((moduleEvidence) => moduleEvidence.actions),
        ),
        application: baseEvidence.application,
        components: uniqueSorted(
          manifestEvidence.flatMap(
            (moduleEvidence) => moduleEvidence.components,
          ),
        ),
        metadataNames: uniqueSorted(
          manifestEvidence.flatMap(
            (moduleEvidence) => moduleEvidence.metadataNames,
          ),
        ),
        permissions: uniqueSorted(
          manifestEvidence.flatMap(
            (moduleEvidence) => moduleEvidence.permissions,
          ),
        ),
        queryActions: uniqueSorted(
          manifestEvidence.flatMap(
            (moduleEvidence) => moduleEvidence.queryActions,
          ),
        ),
        queryPackages: uniqueSorted(
          manifestEvidence.flatMap(
            (moduleEvidence) => moduleEvidence.queryPackages,
          ),
        ),
        targetSdkVersion: baseEvidence.targetSdkVersion,
      },
      playPolicy,
    );
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
 * Scans every DEX payload for stripped repo-owned classes, private LP3
 * control-plane markers, and sideload/local-runtime implementation markers,
 * including features that a universal APK can omit.
 */
export function assertAabDexPolicy({
  appId,
  dexEntries,
  dexBuffers,
  strippedComponents,
}) {
  requireNonEmptyString(appId, "Android application ID");
  requireStringArray(dexEntries, "Android App Bundle DEX entries");
  requireStringArray(strippedComponents, "stripped Android components");
  const buffers = normalizeDexBuffers(dexEntries, dexBuffers);
  const forbiddenClasses = uniqueSorted(
    [...strippedComponents, ...ANDROID_LP3_POLICY_CLASSES].map(
      androidClassBasename,
    ),
  );
  const forbiddenClassDescriptors = forbiddenClasses.flatMap((className) => [
    { className, marker: Buffer.from(`/${className};`, "utf8") },
    { className, marker: Buffer.from(`L${className};`, "utf8") },
  ]);
  const forbiddenLp3Markers = uniqueSorted([
    ...ANDROID_LP3_PRIVATE_ACTIONS,
    ...ANDROID_LP3_POLICY_MARKERS,
  ]).map((marker) => ({
    marker,
    payload: Buffer.from(marker, "utf8"),
  }));
  const forbiddenPlayMarkers = ANDROID_PLAY_FORBIDDEN_DEX_MARKERS.map(
    (marker) => ({ marker, payload: Buffer.from(marker, "utf8") }),
  );

  for (let index = 0; index < buffers.length; index += 1) {
    for (const { className, marker } of forbiddenClassDescriptors) {
      if (buffers[index].includes(marker)) {
        throw androidAabAuditError(
          `[mobile-build] android-cloud AAB DEX ${dexEntries[index]} contains forbidden stripped component class: ${className}`,
        );
      }
    }
    for (const { marker, payload } of forbiddenLp3Markers) {
      if (buffers[index].includes(payload)) {
        throw androidAabAuditError(
          `[mobile-build] android-cloud AAB DEX ${dexEntries[index]} contains forbidden LP3 marker: ${marker}`,
        );
      }
    }
    for (const { marker, payload } of forbiddenPlayMarkers) {
      if (buffers[index].includes(payload)) {
        throw androidAabAuditError(
          `[mobile-build] android-cloud AAB DEX ${dexEntries[index]} contains forbidden Play local-runtime marker: ${marker}`,
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
    playPolicy,
    env = process.env,
    readDexEntries,
  },
  {
    auditTimeoutMs = ANDROID_AAB_AUDIT_TIMEOUT_MS,
    digestBuffer = sha256,
    existsSync = fs.existsSync,
    maxDexEntries = ANDROID_AAB_MAX_DEX_ENTRIES,
    maxManifestBytes = ANDROID_AAB_MAX_MANIFEST_BYTES,
    maxManifestModules = ANDROID_AAB_MAX_MANIFEST_MODULES,
    maxManifestTotalBytes = ANDROID_AAB_MAX_MANIFEST_TOTAL_BYTES,
    now = () => performance.now(),
    platform = process.platform,
    readFileSync = fs.readFileSync,
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
  requirePositiveLimit(auditTimeoutMs, "Android App Bundle audit timeout");
  requirePositiveLimit(
    maxManifestBytes,
    "Android App Bundle per-manifest byte limit",
  );
  requirePositiveLimit(
    maxManifestTotalBytes,
    "Android App Bundle aggregate manifest byte limit",
  );
  if (typeof readDexEntries !== "function") {
    throw androidAabAuditError(
      "[mobile-build] inspectAndroidAppBundle requires a readDexEntries function.",
    );
  }
  const modules = listAabManifestModules(entries, {
    maxModules: maxManifestModules,
  });
  const dexEntries = listAabDexEntries(entries, {
    maxEntries: maxDexEntries,
  });
  // Stray .dex entries widen the scan but can never satisfy the positive
  // must-ship-code assertion: a real app always carries a module classes.dex.
  if (!dexEntries.some((entry) => AAB_DEX_ENTRY.test(entry))) {
    throw androidAabAuditError(
      `[mobile-build] Android App Bundle has no module dex/classes*.dex entries: ${resolvedArtifact}`,
    );
  }

  const invocation = resolveBundletoolInvocation(
    { env, javaHome },
    {
      digestBuffer,
      existsSync,
      platform,
      readFileSync,
      resolvePath,
    },
  );
  const auditStartedAt = now();
  const runWithinAuditDeadline = (args, label) => {
    const remainingMs = Math.floor(auditTimeoutMs - (now() - auditStartedAt));
    if (remainingMs <= 0) {
      throw androidAabAuditError(
        `[mobile-build] Android App Bundle audit exceeded its ${auditTimeoutMs} ms aggregate bundletool deadline while ${label}.`,
        {
          code: "ANDROID_AAB_AUDIT_TIMEOUT",
          context: { auditTimeoutMs, label },
        },
      );
    }
    const output = runCheckedBundletool(invocation, args, label, {
      digestBuffer,
      readFileSync,
      spawnSyncImpl,
      timeoutMs: Math.min(ANDROID_BUNDLETOOL_TIMEOUT_MS, remainingMs),
    });
    if (now() - auditStartedAt > auditTimeoutMs) {
      throw androidAabAuditError(
        `[mobile-build] Android App Bundle audit exceeded its ${auditTimeoutMs} ms aggregate bundletool deadline while ${label}.`,
        {
          code: "ANDROID_AAB_AUDIT_TIMEOUT",
          context: { auditTimeoutMs, label },
        },
      );
    }
    return output;
  };
  runWithinAuditDeadline(
    ["validate", `--bundle=${resolvedArtifact}`],
    `validating ${resolvedArtifact} with bundletool`,
  );

  const manifests = new Map();
  let manifestTotalSizeBytes = 0;
  for (const moduleName of modules) {
    const manifestText = runWithinAuditDeadline(
      [
        "dump",
        "manifest",
        `--bundle=${resolvedArtifact}`,
        `--module=${moduleName}`,
      ],
      `inspecting ${resolvedArtifact} module ${moduleName} manifest with bundletool`,
    );
    if (manifestText.trim() === "") {
      throw androidAabAuditError(
        `[mobile-build] bundletool returned an empty manifest for AAB module ${moduleName}.`,
      );
    }
    const manifestSizeBytes = Buffer.byteLength(manifestText, "utf8");
    manifestTotalSizeBytes += manifestSizeBytes;
    if (
      manifestSizeBytes > maxManifestBytes ||
      manifestTotalSizeBytes > maxManifestTotalBytes
    ) {
      throw androidAabAuditError(
        `[mobile-build] Android App Bundle manifest output exceeds the bounded audit size while inspecting module ${moduleName}.`,
        {
          code: "ANDROID_AAB_WORKLOAD_LIMIT_EXCEEDED",
          context: {
            manifestSizeBytes,
            manifestTotalSizeBytes,
            maxManifestBytes,
            maxManifestTotalBytes,
            moduleName,
          },
        },
      );
    }
    manifests.set(moduleName, manifestText);
  }

  assertAabManifestPolicy({
    manifests,
    appId,
    playPolicy,
    strippedComponents,
    strippedPermissions,
  });

  const dexBuffers = readDexEntries(dexEntries, {
    artifact: resolvedArtifact,
    javaHome,
  });
  assertAabDexPolicy({
    appId,
    dexEntries,
    dexBuffers,
    strippedComponents,
  });

  return {
    appId: requireNonEmptyString(appId, "Android application ID"),
    bundletool: {
      sha256: invocation.bundletoolDigest,
      version: ANDROID_BUNDLETOOL_VERSION,
    },
    dexEntries,
    dexEvidence: dexEntries.map((entry, index) => ({
      entry,
      sha256: sha256(Buffer.from(dexBuffers[index])),
      sizeBytes: Buffer.from(dexBuffers[index]).byteLength,
    })),
    manifestEvidence: modules.map((moduleName) =>
      manifestPolicyEvidence(moduleName, manifests.get(moduleName)),
    ),
    manifestTotalSizeBytes,
    modules,
  };
}
