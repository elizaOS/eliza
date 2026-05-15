#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const frameworkName = "ElizaBunEngine";
const runtimePluginFrameworkName = "ElizaosCapacitorBunRuntime";
const expectedAbiVersion = "3";
const expectedProfile = "ios-app-store-nojit";
const defaultXcframework = path.join(
  packageRoot,
  "artifacts",
  `${frameworkName}.xcframework`,
);
const requiredSymbols = [
  "_eliza_bun_engine_abi_version",
  "_eliza_bun_engine_last_error",
  "_eliza_bun_engine_set_host_callback",
  "_eliza_bun_engine_start",
  "_eliza_bun_engine_stop",
  "_eliza_bun_engine_is_running",
  "_eliza_bun_engine_call",
  "_eliza_bun_engine_free",
];
const forbiddenRuntimeImports = [
  "_dlopen",
  "_dlsym",
  "_posix_spawn",
  "_fork",
  "_execve",
  "_system",
  "_pthread_jit_write_protect_np",
  "_mach_vm_protect",
  "_vm_protect",
];
const forbiddenEntitlements = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.cs.debugger",
];
const forbiddenStrings = [
  /\bMAP_JIT\b/i,
  /\ballow-jit\b/i,
  /\bdynamic-codesigning\b/i,
  /\bunsigned-executable-memory\b/i,
];
const networkPolicyTextExtensions = new Set([
  ".html",
  ".json",
  ".plist",
  ".xml",
]);
const networkUrlPattern =
  /\b(?:https?|wss?):\/\/(?:\[[^\]\s"'`<>]+\]|[^\s"'`<>/;)]+)/gi;

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg === name) return "1";
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return fallback;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr:
      result.stderr ??
      (result.error ? `${result.error.name}: ${result.error.message}` : ""),
  };
}

function fail(message) {
  console.error(`[bun-ios-runtime] ${message}`);
  process.exit(1);
}

function parsePlist(file) {
  const result = run("plutil", ["-convert", "json", "-o", "-", file]);
  if (result.status !== 0) {
    fail(
      `failed to parse ${file}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    fail(
      `failed to decode ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function frameworkBinary(frameworkDir) {
  return path.join(frameworkDir, frameworkName);
}

function selectXcframeworkLibraries(root, { target = "device" } = {}) {
  const info = parsePlist(path.join(root, "Info.plist"));
  const libraries = Array.isArray(info.AvailableLibraries)
    ? info.AvailableLibraries
    : [];
  const selected = libraries.filter((entry) => {
    if (!entry || entry.SupportedPlatform !== "ios") return false;
    const variant = entry.SupportedPlatformVariant;
    if (target === "all") return true;
    if (target === "simulator") return variant === "simulator";
    return !variant;
  });
  if (selected.length === 0) {
    const available = libraries
      .map(
        (entry) =>
          `${entry?.SupportedPlatform ?? "unknown"}${
            entry?.SupportedPlatformVariant
              ? `-${entry.SupportedPlatformVariant}`
              : ""
          }/${entry?.LibraryIdentifier ?? "missing-id"}`,
      )
      .join(", ");
    fail(
      `${root} does not contain an iOS ${target} ElizaBunEngine library. Available: ${
        available || "none"
      }`,
    );
  }
  return selected.map((entry) => {
    const rel =
      typeof entry.LibraryPath === "string"
        ? entry.LibraryPath
        : `${frameworkName}.framework`;
    return {
      id: entry.LibraryIdentifier,
      frameworkDir: path.join(root, entry.LibraryIdentifier, rel),
    };
  });
}

function validateFrameworkMetadata(frameworkDir) {
  const plist = parsePlist(path.join(frameworkDir, "Info.plist"));
  if (String(plist.ElizaBunEngineABIVersion ?? "") !== expectedAbiVersion) {
    fail(
      `${frameworkDir} has ABI ${String(plist.ElizaBunEngineABIVersion)}; expected ${expectedAbiVersion}`,
    );
  }
  if (plist.ElizaBunEngineNoJIT !== true) {
    fail(`${frameworkDir} does not declare ElizaBunEngineNoJIT=true`);
  }
  if (plist.ElizaBunEngineExecutionProfile !== expectedProfile) {
    fail(`${frameworkDir} does not declare ${expectedProfile}`);
  }
}

function validateUnsafeRuntimeBinary(binary) {
  if (!fs.existsSync(binary)) fail(`${binary} does not exist`);
  const imports = run("nm", ["-u", binary]);
  if (imports.status !== 0)
    fail(`nm -u failed for ${binary}: ${imports.stderr.trim()}`);
  const importOutput = `${imports.stdout}\n${imports.stderr}`;
  const badImports = forbiddenRuntimeImports.filter((symbol) =>
    new RegExp(
      `(^|\\s)${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    ).test(importOutput),
  );
  if (badImports.length > 0) {
    fail(
      `${binary} imports App Store-sensitive symbols: ${badImports.join(", ")}`,
    );
  }

  const stringOutput = run("strings", [binary]).stdout;
  const badStrings = forbiddenStrings
    .filter((pattern) => pattern.test(stringOutput))
    .map((pattern) => pattern.source);
  if (badStrings.length > 0) {
    fail(
      `${binary} contains executable-memory markers: ${badStrings.join(", ")}`,
    );
  }
}

function validateBinary(binary) {
  if (!fs.existsSync(binary)) fail(`${binary} does not exist`);
  const defined = run("nm", ["-gU", binary]);
  if (defined.status !== 0)
    fail(`nm failed for ${binary}: ${defined.stderr.trim()}`);
  const definedOutput = `${defined.stdout}\n${defined.stderr}`;
  const missing = requiredSymbols.filter(
    (symbol) => !definedOutput.includes(symbol),
  );
  if (missing.length > 0) {
    fail(`${binary} is missing required ABI symbols: ${missing.join(", ")}`);
  }
  validateUnsafeRuntimeBinary(binary);
}

function isExecutable(file) {
  try {
    return (fs.statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function validateNoNestedExecutables(frameworkDir, binary) {
  const expected = path.resolve(binary);
  const stack = [frameworkDir];
  const unexpected = [];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "_CodeSignature") stack.push(candidate);
        continue;
      }
      if (
        path.resolve(candidate) !== expected &&
        (/\.(dylib|so|bundle)$/i.test(entry.name) || isExecutable(candidate))
      ) {
        unexpected.push(candidate);
      }
    }
  }
  if (unexpected.length > 0) {
    fail(
      `${frameworkDir} contains nested executable payloads: ${unexpected.join(", ")}`,
    );
  }
}

function validateFramework(frameworkDir) {
  const binary = frameworkBinary(frameworkDir);
  validateFrameworkMetadata(frameworkDir);
  validateBinary(binary);
  validateNoNestedExecutables(frameworkDir, binary);
}

function normalizePolicyHost(host) {
  return String(host ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/^\*\./, "")
    .replace(/^\./, "");
}

function isPrivateOrLoopbackPolicyHost(host) {
  const normalized = normalizePolicyHost(host);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("10.") ||
    normalized.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(normalized) ||
    normalized.startsWith("169.254.") ||
    (normalized.includes(":") &&
      (normalized.startsWith("fe80:") ||
        normalized.startsWith("fc") ||
        normalized.startsWith("fd"))) ||
    normalized === "local" ||
    normalized === "internal" ||
    normalized === "lan" ||
    normalized === "ts.net" ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".ts.net")
  );
}

function isUnsafeNetworkUrlLiteral(value) {
  let parsed;
  try {
    parsed = new URL(String(value).replace(/:\*(?=\/|$)/, ":0"));
  } catch {
    return false;
  }
  if (!["http:", "ws:"].includes(parsed.protocol)) return false;
  return isPrivateOrLoopbackPolicyHost(parsed.hostname);
}

function isUnsafeAllowNavigationEntry(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return isUnsafeNetworkUrlLiteral(trimmed);
  }
  return isPrivateOrLoopbackPolicyHost(trimmed);
}

function collectNetworkPolicyTextFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "_CodeSignature" ||
          entry.name === "Frameworks" ||
          entry.name.endsWith(".framework")
        ) {
          continue;
        }
        stack.push(candidate);
        continue;
      }
      if (
        networkPolicyTextExtensions.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push(candidate);
      }
    }
  }
  return files;
}

function findUnsafeNetworkPolicyFindings(appPath) {
  const findings = [];
  for (const file of collectNetworkPolicyTextFiles(appPath)) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(networkUrlPattern)) {
      const url = match[0];
      if (isUnsafeNetworkUrlLiteral(url)) {
        findings.push({
          file,
          value: url,
          reason: "loopback/private cleartext URL",
        });
      }
    }
    if (path.basename(file) === "capacitor.config.json") {
      try {
        const config = JSON.parse(text);
        const allowNavigation = config?.server?.allowNavigation;
        if (Array.isArray(allowNavigation)) {
          for (const entry of allowNavigation) {
            if (isUnsafeAllowNavigationEntry(entry)) {
              findings.push({
                file,
                value: String(entry),
                reason: "loopback/private allowNavigation host",
              });
            }
          }
        }
      } catch (err) {
        findings.push({
          file,
          value: "capacitor.config.json",
          reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }
  return findings;
}

function validateAppNetworkPolicy(appPath) {
  const findings = findUnsafeNetworkPolicyFindings(appPath);
  if (findings.length === 0) return;
  const formatted = findings
    .map((finding) => `${finding.file}: ${finding.reason} (${finding.value})`)
    .join("; ");
  fail(
    `${appPath} contains App Store-unsafe loopback/private HTTP or WS policy: ${formatted}`,
  );
}

function validateXcframework(root, { target = "device" } = {}) {
  if (!fs.existsSync(root)) fail(`${root} does not exist`);
  const libraries = selectXcframeworkLibraries(root, { target });
  if (libraries.length === 0) fail(`${root} has no AvailableLibraries`);
  for (const library of libraries) {
    validateFramework(library.frameworkDir);
    console.log(`[bun-ios-runtime] verified ${library.id}`);
  }
}

function entitlementsFor(pathToCode) {
  const result = run("codesign", ["-d", "--entitlements", ":-", pathToCode]);
  if (result.status !== 0) {
    fail(
      `${pathToCode} is not code-signed or entitlements cannot be read: ${result.stderr.trim()}`,
    );
  }
  if (!result.stdout.trim().startsWith("<?xml")) return {};
  const tmp = path.join(
    fs.mkdtempSync(
      path.join(process.env.TMPDIR || "/tmp", "eliza-ios-entitlements-"),
    ),
    "entitlements.plist",
  );
  fs.writeFileSync(tmp, result.stdout);
  return parsePlist(tmp);
}

function validateEntitlements(pathToCode) {
  const entitlements = entitlementsFor(pathToCode);
  const present = forbiddenEntitlements.filter((key) =>
    Object.hasOwn(entitlements, key),
  );
  if (present.length > 0) {
    fail(
      `${pathToCode} contains App Store-incompatible entitlements: ${present.join(", ")}`,
    );
  }
}

function validateApp(appPath) {
  if (!appPath.endsWith(".app"))
    fail(`--app must point at an .app bundle: ${appPath}`);
  validateEntitlements(appPath);
  const frameworkDir = path.join(
    appPath,
    "Frameworks",
    `${frameworkName}.framework`,
  );
  validateFramework(frameworkDir);
  validateEntitlements(frameworkDir);
  const runtimePluginDir = path.join(
    appPath,
    "Frameworks",
    `${runtimePluginFrameworkName}.framework`,
  );
  const runtimePluginBinary = path.join(
    runtimePluginDir,
    runtimePluginFrameworkName,
  );
  validateUnsafeRuntimeBinary(runtimePluginBinary);
  validateEntitlements(runtimePluginDir);
  validateAppNetworkPolicy(appPath);
  console.log(
    `[bun-ios-runtime] verified App Store no-JIT profile for ${appPath}`,
  );
}

function main() {
  const app = argValue("--app", process.env.ELIZA_IOS_APP_PATH || "");
  const target = argValue(
    "--target",
    process.env.ELIZA_IOS_VERIFY_TARGET || "device",
  );
  const xcframework = argValue(
    "--xcframework",
    process.env.ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK || defaultXcframework,
  );

  if (app) {
    validateApp(path.resolve(app));
  } else {
    validateXcframework(path.resolve(xcframework), { target });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}

export {
  findUnsafeNetworkPolicyFindings,
  isPrivateOrLoopbackPolicyHost,
  isUnsafeAllowNavigationEntry,
  isUnsafeNetworkUrlLiteral,
  validateAppNetworkPolicy,
};
