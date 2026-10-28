/**
 * Distribution inspection of a built Android APK for consumer hosts.
 *
 * The generic half of "is this APK fit to distribute": archive facts (package,
 * HOME/LAUNCHER, debuggable, entries, dex markers), signer digests, and a
 * release policy assessment driven by a host-supplied policy object. A host
 * supplies only data (its exported-component allowlist, development class
 * names, forbidden entries); product-specific checks stay with the host.
 *
 * Pure functions take dumps and entry names; the `read*` helpers shell out to
 * aapt, apksigner and unzip, whose paths the caller resolves.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { manifestFacts } from "../../lib/android-manifest-facts.mjs";

/** Capacitor packages the renderer here; its index marks a web payload. */
export const WEB_PAYLOAD_INDEX = "assets/public/index.html";
const DEFAULT_TEST_ONLY_NAME = /mock|fixture/i;
const DEX_ENTRY = /^classes\d*\.dex$/;
const isFalse = (value) => value === "0x0";

// Patterns are matched once per entry name: a global or sticky RegExp keeps
// lastIndex between calls and would skip matches, so those flags are dropped.
function asPattern(value, key) {
  if (value === undefined || value === null) return null;
  if (value instanceof RegExp)
    return new RegExp(value.source, value.flags.replace(/[gy]/g, ""));
  if (typeof value !== "string" || !value)
    throw new TypeError(`APK policy ${key} must be a pattern`);
  return new RegExp(value, "i");
}

/** Validate and normalize a host policy; throws on malformed input. */
export function apkDistributionPolicy(policy = {}) {
  const list = (key) => {
    const value = policy[key] ?? [];
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string" || !item)
    )
      throw new TypeError(`APK policy ${key} must be a list of names`);
    return Object.freeze([...value]);
  };
  const exported = policy.exportedComponents ?? {};
  if (typeof exported !== "object" || Array.isArray(exported))
    throw new TypeError("APK policy exportedComponents must be an object");
  for (const [name, permission] of Object.entries(exported))
    if (permission !== null && (typeof permission !== "string" || !permission))
      throw new TypeError(
        `APK policy exportedComponents.${name} must be a permission or null`,
      );
  return Object.freeze({
    developmentClasses: list("developmentClasses"),
    developmentManifestText: list("developmentManifestText"),
    developmentEntries: Object.freeze(
      (() => {
        const value = policy.developmentEntries ?? [];
        if (!Array.isArray(value))
          throw new TypeError("APK policy developmentEntries must be a list");
        return value.map((item) => asPattern(item, "developmentEntries"));
      })(),
    ),
    exportedComponents: Object.freeze({ ...exported }),
    forbiddenPermissions: list("forbiddenPermissions"),
    forbiddenEntries: asPattern(policy.forbiddenEntries, "forbiddenEntries"),
    forbiddenEntriesLabel:
      policy.forbiddenEntriesLabel ?? "Forbidden entries are packaged",
    forbiddenDexPrefixes: list("forbiddenDexPrefixes"),
    forbiddenDexLabel:
      policy.forbiddenDexLabel ?? "Forbidden classes are packaged",
    requiredEntries: list("requiredEntries"),
    testOnlyName:
      asPattern(policy.testOnlyName, "testOnlyName") ?? DEFAULT_TEST_ONLY_NAME,
    requireReleaseNetworkSecurityConfig:
      policy.requireReleaseNetworkSecurityConfig !== false,
    forbidSourceMaps: policy.forbidSourceMaps !== false,
  });
}

/**
 * Assess one inspected APK against a host policy.
 *
 * `apk` holds `xml` (aapt xmltree), `badging`, `names` (zip entries),
 * `dexClasses` (development class names found in dex) and `forbiddenDex`
 * (forbidden dex prefixes found). Development hooks are tolerated only in a
 * debug build made with test mocks. Returns `{ facts, problems }`.
 */
export function apkDistributionProblems(
  apk,
  policy,
  { mode, testMocks = false } = {},
) {
  const rules = apkDistributionPolicy(policy);
  const facts = manifestFacts(apk.xml, apk.badging);
  const problems = [];
  const debugHooksAllowed = testMocks === true && mode === "debug";
  if (!debugHooksAllowed) {
    for (const name of rules.developmentClasses)
      if (apk.xml.includes(name) || apk.dexClasses?.includes(name))
        problems.push(`Development class ${name} is packaged`);
    for (const text of rules.developmentManifestText)
      if (apk.xml.includes(text))
        problems.push(`${text} permission or package query is packaged`);
    for (const pattern of rules.developmentEntries)
      for (const name of apk.names.filter((entry) => pattern.test(entry)))
        problems.push(`Development entry ${name} is packaged`);
    if (!isFalse(facts.application.usesCleartextTraffic))
      problems.push(
        `usesCleartextTraffic must be false (found ${facts.application.usesCleartextTraffic ?? "unset"})`,
      );
  }
  if (
    mode === "release" &&
    rules.requireReleaseNetworkSecurityConfig &&
    !facts.application.networkSecurityConfig
  )
    problems.push("Release manifest has no networkSecurityConfig");
  if (!isFalse(facts.application.allowBackup))
    problems.push(
      `allowBackup must be false (found ${facts.application.allowBackup ?? "unset"})`,
    );
  for (const component of facts.exported) {
    if (
      debugHooksAllowed &&
      rules.developmentClasses.some((name) =>
        component.name.endsWith(`.${name}`),
      )
    )
      continue;
    if (!Object.hasOwn(rules.exportedComponents, component.name)) {
      problems.push(`Unexpected exported ${component.tag} ${component.name}`);
      continue;
    }
    const required = rules.exportedComponents[component.name];
    if (required && component.permission !== required)
      problems.push(`Exported ${component.name} must require ${required}`);
  }
  if (!debugHooksAllowed) {
    const named = [
      ...facts.components.map((component) => component.name),
      ...facts.permissions,
      ...facts.queriedPackages,
    ];
    for (const name of named.filter((value) => rules.testOnlyName.test(value)))
      problems.push(`Test-only manifest entry ${name}`);
  }
  for (const permission of rules.forbiddenPermissions)
    if (facts.permissions.includes(permission))
      problems.push(`${permission.split(".").pop()} is requested`);
  if (rules.forbidSourceMaps) {
    const maps = apk.names.filter(
      (name) => name.startsWith("assets/") && name.endsWith(".map"),
    );
    if (maps.length)
      problems.push(`Source maps are packaged: ${maps.slice(0, 3).join(", ")}`);
  }
  if (rules.forbiddenEntries) {
    const found = apk.names.filter((name) => rules.forbiddenEntries.test(name));
    if (found.length)
      problems.push(
        `${rules.forbiddenEntriesLabel}: ${found.slice(0, 3).join(", ")}`,
      );
  }
  if (apk.forbiddenDex?.length)
    problems.push(`${rules.forbiddenDexLabel}: ${apk.forbiddenDex.join(", ")}`);
  for (const entry of rules.requiredEntries)
    if (!apk.names.includes(entry)) problems.push(`${entry} is missing`);
  if (facts.versionCode === null)
    problems.push(
      `versionCode must be a positive integer (found ${facts.versionCodeText ?? "none"})`,
    );
  if (!facts.versionName || facts.versionName === "0")
    problems.push(
      `versionName must be set (found ${facts.versionName ?? "none"})`,
    );
  return { facts, problems };
}

/** Which development class names and forbidden prefixes occur in dex bytes. */
export function dexMarkers(dexFiles, policy) {
  const rules = apkDistributionPolicy(policy);
  const development = new Set();
  const forbidden = new Set();
  for (const bytes of dexFiles) {
    for (const name of rules.developmentClasses)
      if (bytes.includes(`/${name};`)) development.add(name);
    for (const prefix of rules.forbiddenDexPrefixes)
      if (bytes.includes(prefix)) forbidden.add(prefix);
  }
  return { development: [...development], forbidden: [...forbidden] };
}

/** Archive facts from aapt dumps and entry names (pure). */
export function apkArchiveFacts({ badging, xml, names }) {
  return {
    packageName: /package: name='([^']+)'/.exec(badging)?.[1],
    home: xml.includes("android.intent.category.HOME"),
    launcher: xml.includes("android.intent.category.LAUNCHER"),
    debuggable: /android:debuggable[^\n]*0xffffffff/.test(xml),
    webPayload: names.includes(WEB_PAYLOAD_INDEX),
  };
}

/** Zip entry names of an archive. */
export function readApkEntries(file) {
  return execFileSync("unzip", ["-Z1", file], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
}

/** Inspect an APK with aapt and unzip for {@link apkDistributionProblems}. */
export function readApk(file, { aapt, policy } = {}) {
  if (!aapt) throw new TypeError("readApk needs the aapt path");
  const badging = execFileSync(aapt, ["dump", "badging", file], {
    encoding: "utf8",
  });
  const xml = execFileSync(
    aapt,
    ["dump", "xmltree", file, "AndroidManifest.xml"],
    { encoding: "utf8" },
  );
  const names = readApkEntries(file);
  const dex = names
    .filter((name) => DEX_ENTRY.test(name))
    .map((entry) =>
      execFileSync("unzip", ["-p", file, entry], {
        maxBuffer: 512 * 1024 * 1024,
      }),
    );
  const markers = dexMarkers(dex, policy);
  return {
    file,
    ...apkArchiveFacts({ badging, xml, names }),
    sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    badging,
    xml,
    names,
    dexClasses: markers.development,
    forbiddenDex: markers.forbidden,
  };
}

/** Extract the Capacitor web payload into a fresh temporary directory; caller removes `root`. */
export function extractApkWebPayload(file, { prefix = "apk-public-" } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    execFileSync("unzip", ["-q", file, "assets/public/*", "-d", directory]);
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { root: directory, public: path.join(directory, "assets/public") };
}

/**
 * The first signer's certificate SHA-256 from `apksigner verify --print-certs`.
 * Rotated (ranged) output needs an explicit API level and must name exactly
 * one signer for it; ambiguous or multi-signer output is refused.
 */
export function parseApkSignerDigest(output, { apiLevel } = {}) {
  const legacy = [
    ...output.matchAll(
      /Signer #([0-9]+) certificate SHA-256 digest:\s*([a-fA-F0-9]{64})/g,
    ),
  ];
  const ranged = [
    ...output.matchAll(
      /Signer \(minSdkVersion=([0-9]+), maxSdkVersion=([0-9]+)\) certificate SHA-256 digest:\s*([a-fA-F0-9]{64})/g,
    ),
  ];
  if (legacy.length && ranged.length)
    throw new Error("Ambiguous APK signer output");
  if (legacy.length === 1 && legacy[0][1] === "1")
    return legacy[0][2].toLowerCase();
  if (legacy.length)
    throw new Error("Multiple or unrecognized APK signers are not supported");
  if (!ranged.length)
    throw new Error("apksigner reported no SHA-256 signer digest");
  if (!Number.isInteger(apiLevel) || apiLevel < 1)
    throw new Error(
      "Rotated APK signer requires an explicit Android API level",
    );
  const matches = ranged.filter(
    (row) => Number(row[1]) <= apiLevel && apiLevel <= Number(row[2]),
  );
  if (matches.length !== 1)
    throw new Error("No unique APK signer for the requested Android API level");
  return matches[0][3].toLowerCase();
}

/** Run apksigner and return {@link parseApkSignerDigest} of its output. */
export function readApkSignerDigest(file, { apksigner, apiLevel, env } = {}) {
  if (!apksigner)
    throw new TypeError("readApkSignerDigest needs the apksigner path");
  if (apiLevel !== undefined && (!Number.isInteger(apiLevel) || apiLevel < 1))
    throw new Error("Invalid Android API level");
  const scope =
    apiLevel === undefined
      ? []
      : [
          "--min-sdk-version",
          String(apiLevel),
          "--max-sdk-version",
          String(apiLevel),
        ];
  const output = execFileSync(
    apksigner,
    ["verify", "--print-certs", ...scope, file],
    { encoding: "utf8", ...(env ? { env } : {}) },
  );
  return parseApkSignerDigest(output, { apiLevel });
}
