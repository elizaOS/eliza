#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appCoreRoot = path.resolve(__dirname, "..", "..");
const manifestPath = path.join(
  appCoreRoot,
  "platforms",
  "apple-store-entitlements.reviewed.json",
);

const REVIEW_SENSITIVE_ENTITLEMENTS = new Set([
  "com.apple.security.automation.apple-events",
  "com.apple.security.network.server",
  "com.apple.security.files.downloads.read-write",
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.developer.family-controls",
  "com.apple.developer.healthkit",
  "com.apple.developer.healthkit.background-delivery",
  "com.apple.developer.kernel.increased-memory-limit",
  "com.apple.developer.kernel.extended-virtual-addressing",
]);

const MAS_RUNTIME_EXCEPTION_ENTITLEMENTS = new Set([
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
]);

const MAS_JIT_MEMORY_ENTITLEMENTS = new Set([
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
]);

const MACHO_MAGIC = new Set([
  0xfeedface,
  0xfeedfacf,
  0xcefaedfe,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafed00d,
  0x0dd0feca,
]);

const JIT_NATIVE_SYMBOL_PATTERNS = [
  /_pthread_jit_write_protect_np\b/,
  /_mprotect\b/,
  /_mmap\b/,
  /_vm_protect\b/,
  /MAP_JIT\b/,
  /PROT_EXEC\b/,
  /JavaScriptCore/,
  /Bun\.unsafe/,
];

const DYNAMIC_LIBRARY_SYMBOL_PATTERNS = [
  /_dlopen\b/,
  /_NSCreateObjectFileImageFromFile\b/,
  /_NSCreateObjectFileImageFromMemory\b/,
  /_CFBundleLoadExecutable\b/,
  /@rpath\//,
  /\.dylib\b/,
  /\.framework\b/,
  /\.node\b/,
  /\.so\b/,
];

function decodeXmlText(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function extractFirstDictBody(plistXml, label) {
  const withoutComments = plistXml.replace(/<!--[\s\S]*?-->/g, "");
  const match = withoutComments.match(/<dict\b[^>]*>([\s\S]*?)<\/dict>/i);
  if (!match) {
    throw new Error(`${label}: missing top-level <dict> in entitlements plist`);
  }
  return match[1];
}

export function parseEntitlementsPlist(plistXml, label = "entitlements") {
  const body = extractFirstDictBody(plistXml, label);
  const entitlements = {};
  const keyPattern = /<key>([\s\S]*?)<\/key>/g;
  let keyMatch;
  while ((keyMatch = keyPattern.exec(body))) {
    const key = decodeXmlText(keyMatch[1].trim());
    const valueStart = keyPattern.lastIndex;
    const rest = body.slice(valueStart);
    const leadingWhitespace = rest.match(/^\s*/)?.[0].length ?? 0;
    const value = rest.slice(leadingWhitespace);
    if (value.startsWith("<true/>") || value.startsWith("<true />")) {
      entitlements[key] = true;
      continue;
    }
    if (value.startsWith("<false/>") || value.startsWith("<false />")) {
      entitlements[key] = false;
      continue;
    }
    const stringMatch = value.match(/^<string>([\s\S]*?)<\/string>/);
    if (stringMatch) {
      entitlements[key] = decodeXmlText(stringMatch[1]);
      continue;
    }
    const arrayMatch = value.match(/^<array\b[^>]*>([\s\S]*?)<\/array>/);
    if (arrayMatch) {
      entitlements[key] = [
        ...arrayMatch[1].matchAll(/<string>([\s\S]*?)<\/string>/g),
      ].map((match) => decodeXmlText(match[1]));
      continue;
    }
    throw new Error(`${label}: unsupported plist value for entitlement ${key}`);
  }
  return entitlements;
}

export function loadEntitlementReviewManifest() {
  if (!existsSync(manifestPath)) {
    throw new Error(`missing entitlement review manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.targets)) {
    throw new Error(`${manifestPath}: targets must be an array`);
  }
  return manifest;
}

function findTarget(manifest, targetId) {
  const target = manifest.targets.find((entry) => entry.id === targetId);
  if (!target) {
    throw new Error(`${manifestPath}: missing target ${targetId}`);
  }
  return target;
}

function valuesEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function valueMatchesPolicy(actual, policy) {
  if (Object.hasOwn(policy, "value")) {
    return valuesEqual(actual, policy.value);
  }
  if (typeof policy.stringPattern === "string") {
    return (
      typeof actual === "string" && new RegExp(policy.stringPattern).test(actual)
    );
  }
  if (Array.isArray(policy.arrayStringPatterns)) {
    return (
      Array.isArray(actual) &&
      actual.length === policy.arrayStringPatterns.length &&
      actual.every((value, index) => {
        const pattern = policy.arrayStringPatterns[index];
        return typeof value === "string" && new RegExp(pattern).test(value);
      })
    );
  }
  return false;
}

function describePolicy(policy) {
  if (Object.hasOwn(policy, "value")) {
    return JSON.stringify(policy.value);
  }
  if (policy.stringPattern) {
    return `string matching /${policy.stringPattern}/`;
  }
  if (policy.arrayStringPatterns) {
    return `array matching ${JSON.stringify(policy.arrayStringPatterns)}`;
  }
  return "<unrecognized policy>";
}

function validateEvidenceEntry({ target, key, evidence, index, root }) {
  const errors = [];
  const prefix = `${target.id}: ${key} currentEvidence[${index}]`;
  if (!evidence || typeof evidence !== "object") {
    return [`${prefix} must be an object`];
  }
  if (typeof evidence.summary !== "string" || evidence.summary.trim().length < 16) {
    errors.push(`${prefix} needs a concrete summary`);
  }
  if (typeof evidence.path !== "string" || evidence.path.trim() === "") {
    errors.push(`${prefix} needs a repo-relative path`);
    return errors;
  }
  const evidencePath = path.resolve(root, evidence.path);
  if (!isPathInside(root, evidencePath)) {
    errors.push(`${prefix} path must stay inside packages/app-core`);
    return errors;
  }
  if (!existsSync(evidencePath)) {
    errors.push(`${prefix} path does not exist: ${evidence.path}`);
    return errors;
  }
  if (
    typeof evidence.contains === "string" ||
    typeof evidence.regex === "string"
  ) {
    const text = readFileSync(evidencePath, "utf8");
    if (
      typeof evidence.contains === "string" &&
      !text.includes(evidence.contains)
    ) {
      errors.push(`${prefix} path does not contain ${JSON.stringify(evidence.contains)}`);
    }
    if (
      typeof evidence.regex === "string" &&
      !new RegExp(evidence.regex).test(text)
    ) {
      errors.push(`${prefix} path does not match /${evidence.regex}/`);
    }
  }
  return errors;
}

function validateTargetPolicy(target, { root = appCoreRoot } = {}) {
  const errors = [];
  if (!target.allowedEntitlements || typeof target.allowedEntitlements !== "object") {
    errors.push(`${target.id}: allowedEntitlements must be an object`);
    return errors;
  }

  for (const [key, policy] of Object.entries(target.allowedEntitlements)) {
    const reviewedJustification =
      typeof policy.justification === "string"
        ? policy.justification
        : policy.appReviewJustification;
    if (
      typeof reviewedJustification !== "string" ||
      reviewedJustification.trim().length < 12
    ) {
      errors.push(`${target.id}: ${key} needs a reviewed justification`);
    }
    if (REVIEW_SENSITIVE_ENTITLEMENTS.has(key)) {
      if (policy.reviewSensitive !== true) {
        errors.push(`${target.id}: ${key} must be marked reviewSensitive`);
      }
      if (
        typeof policy.appReviewJustification !== "string" ||
        policy.appReviewJustification.trim().length < 24
      ) {
        errors.push(`${target.id}: ${key} needs appReviewJustification`);
      }
    }
    if (
      target.distribution === "mac-app-store" &&
      MAS_RUNTIME_EXCEPTION_ENTITLEMENTS.has(key)
    ) {
      if (!Array.isArray(policy.currentEvidence) || policy.currentEvidence.length === 0) {
        errors.push(
          `${target.id}: ${key} needs currentEvidence tied to files in this checkout`,
        );
        continue;
      }
      policy.currentEvidence.forEach((evidence, index) => {
        errors.push(
          ...validateEvidenceEntry({ target, key, evidence, index, root }),
        );
      });
    }
  }
  return errors;
}

export function validateEntitlementsAgainstTarget({
  entitlements,
  targetId,
  manifest = loadEntitlementReviewManifest(),
  label = targetId,
}) {
  const target = findTarget(manifest, targetId);
  const allowed = target.allowedEntitlements;
  const errors = validateTargetPolicy(target);
  const actualKeys = Object.keys(entitlements).sort();
  const allowedKeys = Object.keys(allowed).sort();

  for (const key of actualKeys) {
    if (!Object.hasOwn(allowed, key)) {
      const sensitive = REVIEW_SENSITIVE_ENTITLEMENTS.has(key)
        ? " (review-sensitive)"
        : "";
      errors.push(`${label}: unexpected entitlement ${key}${sensitive}`);
    }
  }

  for (const key of allowedKeys) {
    if (!Object.hasOwn(entitlements, key)) {
      errors.push(`${label}: missing reviewed entitlement ${key}`);
      continue;
    }
    const policy = allowed[key];
    if (!valueMatchesPolicy(entitlements[key], policy)) {
      errors.push(
        `${label}: ${key} is ${JSON.stringify(
          entitlements[key],
        )}, expected ${describePolicy(policy)}`,
      );
    }
  }

  return errors;
}

export function assertReviewedEntitlementsText({
  plistXml,
  targetId,
  manifest,
  label = targetId,
}) {
  const entitlements = parseEntitlementsPlist(plistXml, label);
  const errors = validateEntitlementsAgainstTarget({
    entitlements,
    targetId,
    manifest,
    label,
  });
  if (errors.length > 0) {
    throw new Error(
      [
        `apple entitlement audit failed for ${label}`,
        ...errors.map((error) => `  - ${error}`),
      ].join("\n"),
    );
  }
  return entitlements;
}

export function assertReviewedEntitlementsFile({
  filePath,
  targetId,
  manifest,
  label = filePath,
}) {
  if (!existsSync(filePath)) {
    throw new Error(`missing entitlements file: ${filePath}`);
  }
  return assertReviewedEntitlementsText({
    plistXml: readFileSync(filePath, "utf8"),
    targetId,
    manifest,
    label,
  });
}

export function assertReviewedAppleStoreEntitlements() {
  const manifest = loadEntitlementReviewManifest();
  const errors = [];
  for (const target of manifest.targets) {
    try {
      assertReviewedEntitlementsFile({
        filePath: path.join(appCoreRoot, target.source),
        targetId: target.id,
        manifest,
        label: target.source,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

function isPathInside(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function safeStat(filePath) {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function isMachO(filePath) {
  const st = safeStat(filePath);
  if (!st?.isFile() || st.size < 4) return false;
  let fd = null;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    if (readSync(fd, buf, 0, 4, 0) !== 4) return false;
    return MACHO_MAGIC.has(buf.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function walkFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = safeStat(full);
      if (!st) continue;
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function runText(command, args, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer,
  });
  if (result.status !== 0 || result.error) {
    return null;
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function binaryTextEvidence(filePath) {
  return (
    runText("nm", ["-u", filePath], { maxBuffer: 32 * 1024 * 1024 }) ??
    runText("strings", ["-a", filePath], { maxBuffer: 32 * 1024 * 1024 }) ??
    ""
  );
}

function matchedPatterns(text, patterns) {
  return patterns
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source.replaceAll("\\b", ""));
}

function extensionSignals(filePath) {
  const normalized = filePath.replaceAll(path.sep, "/");
  return DYNAMIC_LIBRARY_SYMBOL_PATTERNS.filter((pattern) =>
    pattern.test(normalized),
  ).map((pattern) => pattern.source.replaceAll("\\b", ""));
}

export function scanAppleAppBundleForNativeRuntimeSignals(appPath) {
  if (!existsSync(appPath) || !appPath.endsWith(".app")) {
    throw new Error(`expected .app bundle for native symbol scan: ${appPath}`);
  }

  const findings = {
    appPath,
    machOCount: 0,
    jitExecutableMemory: [],
    dynamicLibraryLoading: [],
  };

  for (const filePath of walkFiles(appPath)) {
    const rel = path.relative(appPath, filePath);
    const extSignals = extensionSignals(rel);
    if (extSignals.length > 0) {
      findings.dynamicLibraryLoading.push({
        path: rel,
        signals: [...new Set(extSignals)].sort(),
      });
    }

    if (!isMachO(filePath)) continue;
    findings.machOCount += 1;
    const text = binaryTextEvidence(filePath);
    const jitSignals = matchedPatterns(text, JIT_NATIVE_SYMBOL_PATTERNS);
    if (jitSignals.length > 0) {
      findings.jitExecutableMemory.push({
        path: rel,
        signals: [...new Set(jitSignals)].sort(),
      });
    }
    const dylibSignals = matchedPatterns(text, DYNAMIC_LIBRARY_SYMBOL_PATTERNS);
    if (dylibSignals.length > 0) {
      findings.dynamicLibraryLoading.push({
        path: rel,
        signals: [...new Set(dylibSignals)].sort(),
      });
    }
  }

  findings.jitExecutableMemory.sort((a, b) => a.path.localeCompare(b.path));
  findings.dynamicLibraryLoading.sort((a, b) => a.path.localeCompare(b.path));
  return findings;
}

export function validateMasEntitlementRuntimeEvidence({
  entitlements,
  scan,
  label = "macOS MAS app",
}) {
  const errors = [];
  const hasJitEntitlement = [...MAS_JIT_MEMORY_ENTITLEMENTS].some(
    (key) => entitlements[key] === true,
  );
  if (hasJitEntitlement && scan.jitExecutableMemory.length === 0) {
    errors.push(
      `${label}: JIT/executable-memory entitlement is enabled, but the built app scan found no JIT or executable-memory native-symbol evidence`,
    );
  }
  if (
    entitlements["com.apple.security.cs.allow-unsigned-executable-memory"] ===
      true &&
    scan.jitExecutableMemory.length === 0
  ) {
    errors.push(
      `${label}: com.apple.security.cs.allow-unsigned-executable-memory requires current built-app evidence`,
    );
  }
  if (
    entitlements["com.apple.security.cs.disable-library-validation"] === true &&
    scan.dynamicLibraryLoading.length === 0
  ) {
    errors.push(
      `${label}: com.apple.security.cs.disable-library-validation requires current native library loading/bundling evidence`,
    );
  }
  return errors;
}

export function assertMasEntitlementRuntimeEvidence({
  entitlements,
  scan,
  label = "macOS MAS app",
}) {
  const errors = validateMasEntitlementRuntimeEvidence({
    entitlements,
    scan,
    label,
  });
  if (errors.length > 0) {
    throw new Error(
      [
        `apple entitlement runtime evidence audit failed for ${label}`,
        ...errors.map((error) => `  - ${error}`),
      ].join("\n"),
    );
  }
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      out[arg.slice(2)] = true;
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return out;
}

function printScanSummary(scan) {
  console.log(
    `apple entitlement audit: scanned ${scan.machOCount} Mach-O file(s) in ${scan.appPath}`,
  );
  console.log(
    `  JIT/executable-memory evidence: ${scan.jitExecutableMemory.length}`,
  );
  console.log(
    `  native library loading/bundling evidence: ${scan.dynamicLibraryLoading.length}`,
  );
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      [
        "Usage: node scripts/lib/apple-entitlement-audit.mjs [--app=/path/to/App.app]",
        "",
        "Validates App Store-facing Apple entitlement files against",
        "platforms/apple-store-entitlements.reviewed.json. When --app is",
        "provided, also scans the built MAS bundle for JIT/native evidence",
        "required by allow-unsigned-executable-memory and disable-library-validation.",
      ].join("\n"),
    );
    return;
  }

  assertReviewedAppleStoreEntitlements();
  console.log("apple entitlement audit: reviewed source entitlements OK");

  if (args.app) {
    const manifest = loadEntitlementReviewManifest();
    const entitlements = assertReviewedEntitlementsFile({
      filePath: path.join(
        appCoreRoot,
        "platforms/electrobun/entitlements/mas.entitlements",
      ),
      targetId: "macos-mas-app",
      manifest,
      label: "macOS MAS parent entitlements",
    });
    const scan = scanAppleAppBundleForNativeRuntimeSignals(path.resolve(args.app));
    printScanSummary(scan);
    assertMasEntitlementRuntimeEvidence({
      entitlements,
      scan,
      label: path.basename(args.app),
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
