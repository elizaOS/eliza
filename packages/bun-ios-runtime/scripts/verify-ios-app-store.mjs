#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const frameworkName = "ElizaBunEngine";
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
    fail(`failed to parse ${file}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    fail(`failed to decode ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function frameworkBinary(frameworkDir) {
  return path.join(frameworkDir, frameworkName);
}

function selectXcframeworkLibraries(root) {
  const info = parsePlist(path.join(root, "Info.plist"));
  const libraries = Array.isArray(info.AvailableLibraries)
    ? info.AvailableLibraries
    : [];
  return libraries.map((entry) => {
    const rel = typeof entry.LibraryPath === "string"
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
    fail(`${frameworkDir} has ABI ${String(plist.ElizaBunEngineABIVersion)}; expected ${expectedAbiVersion}`);
  }
  if (plist.ElizaBunEngineNoJIT !== true) {
    fail(`${frameworkDir} does not declare ElizaBunEngineNoJIT=true`);
  }
  if (plist.ElizaBunEngineExecutionProfile !== expectedProfile) {
    fail(`${frameworkDir} does not declare ${expectedProfile}`);
  }
}

function validateBinary(binary) {
  if (!fs.existsSync(binary)) fail(`${binary} does not exist`);
  const defined = run("nm", ["-gU", binary]);
  if (defined.status !== 0) fail(`nm failed for ${binary}: ${defined.stderr.trim()}`);
  const definedOutput = `${defined.stdout}\n${defined.stderr}`;
  const missing = requiredSymbols.filter((symbol) => !definedOutput.includes(symbol));
  if (missing.length > 0) {
    fail(`${binary} is missing required ABI symbols: ${missing.join(", ")}`);
  }

  const imports = run("nm", ["-u", binary]);
  if (imports.status !== 0) fail(`nm -u failed for ${binary}: ${imports.stderr.trim()}`);
  const importOutput = `${imports.stdout}\n${imports.stderr}`;
  const badImports = forbiddenRuntimeImports.filter((symbol) =>
    new RegExp(`(^|\\s)${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
      importOutput,
    ),
  );
  if (badImports.length > 0) {
    fail(`${binary} imports App Store-sensitive symbols: ${badImports.join(", ")}`);
  }

  const stringOutput = run("strings", [binary]).stdout;
  const badStrings = forbiddenStrings
    .filter((pattern) => pattern.test(stringOutput))
    .map((pattern) => pattern.source);
  if (badStrings.length > 0) {
    fail(`${binary} contains executable-memory markers: ${badStrings.join(", ")}`);
  }
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
    fail(`${frameworkDir} contains nested executable payloads: ${unexpected.join(", ")}`);
  }
}

function validateFramework(frameworkDir) {
  const binary = frameworkBinary(frameworkDir);
  validateFrameworkMetadata(frameworkDir);
  validateBinary(binary);
  validateNoNestedExecutables(frameworkDir, binary);
}

function validateXcframework(root) {
  if (!fs.existsSync(root)) fail(`${root} does not exist`);
  const libraries = selectXcframeworkLibraries(root);
  if (libraries.length === 0) fail(`${root} has no AvailableLibraries`);
  for (const library of libraries) {
    validateFramework(library.frameworkDir);
    console.log(`[bun-ios-runtime] verified ${library.id}`);
  }
}

function entitlementsFor(pathToCode) {
  const result = run("codesign", ["-d", "--entitlements", ":-", pathToCode]);
  if (result.status !== 0) {
    fail(`${pathToCode} is not code-signed or entitlements cannot be read: ${result.stderr.trim()}`);
  }
  if (!result.stdout.trim().startsWith("<?xml")) return {};
  const tmp = path.join(
    fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "eliza-ios-entitlements-")),
    "entitlements.plist",
  );
  fs.writeFileSync(tmp, result.stdout);
  return parsePlist(tmp);
}

function validateEntitlements(pathToCode) {
  const entitlements = entitlementsFor(pathToCode);
  const present = forbiddenEntitlements.filter((key) =>
    Object.prototype.hasOwnProperty.call(entitlements, key),
  );
  if (present.length > 0) {
    fail(`${pathToCode} contains App Store-incompatible entitlements: ${present.join(", ")}`);
  }
}

function validateApp(appPath) {
  if (!appPath.endsWith(".app")) fail(`--app must point at an .app bundle: ${appPath}`);
  validateEntitlements(appPath);
  const frameworkDir = path.join(appPath, "Frameworks", `${frameworkName}.framework`);
  validateFramework(frameworkDir);
  validateEntitlements(frameworkDir);
  console.log(`[bun-ios-runtime] verified App Store no-JIT profile for ${appPath}`);
}

const app = argValue("--app", process.env.ELIZA_IOS_APP_PATH || "");
const xcframework = argValue(
  "--xcframework",
  process.env.ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK || defaultXcframework,
);

if (app) {
  validateApp(path.resolve(app));
} else {
  validateXcframework(path.resolve(xcframework));
}
