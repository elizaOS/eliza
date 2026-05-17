#!/usr/bin/env node
/**
 * Mac App Store launch-smoke harness.
 *
 * Empirically verifies a built `.app` bundle was codesigned with the tightened
 * MAS entitlement set defined under
 * `packages/app-core/platforms/electrobun/entitlements/`. Runs after
 * `codesign-mas.mjs` has finished — confirms that what shipped matches what we
 * intended, instead of trusting that the signing script did the right thing.
 *
 * Concretely:
 *   - The outer .app bundle gets `mas.entitlements`: app-sandbox + network
 *     client + data/privacy permissions, and explicitly NO `allow-jit`,
 *     `allow-unsigned-executable-memory`, or `disable-library-validation`.
 *   - The Bun runtime helper (`Contents/MacOS/bun`) gets `mas-bun.entitlements`:
 *     app-sandbox + cs.inherit + `allow-jit` only — JIT is scoped to this
 *     one binary because Bun's macOS runtime imports Apple's JIT
 *     write-protection APIs.
 *   - Every other nested Mach-O gets `mas-child.entitlements`: app-sandbox
 *     + cs.inherit, no JIT, no library-validation bypass, no unsigned-exec.
 *
 * Usage:
 *   node mas-smoke.mjs --app=path/to/Built.app
 *                      [--launch]   # also run `open -W` and sniff sandbox logs (30s)
 *                      [--help]
 *
 * Behavior:
 *   - On non-darwin: prints "skipped — not darwin" and exits 0.
 *   - Exits non-zero on any entitlement assertion failure, with a clear
 *     message naming the offender + key + expected/actual.
 *
 * Wired into `desktop-build.mjs` behind `--verify-mas` / `ELIZA_VERIFY_MAS=1`.
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUN_HELPER_BINARY_NAMES, isBunHelperBinary } from "./codesign-mas.mjs";

const __filename = fileURLToPath(import.meta.url);

const MACHO_MAGIC = new Set([
  0xfeedface,
  0xfeedfacf, // 32 / 64-bit
  0xcefaedfe,
  0xcffaedfe, // byte-swapped
  0xcafebabe,
  0xbebafeca, // fat
]);

// Entitlements that must NEVER appear on the outer parent .app under MAS.
// `allow-jit` is included here: the parent app does not need JIT; only the
// scoped Bun helper does. `disable-library-validation` and
// `allow-unsigned-executable-memory` are App Store rejection bait.
const PARENT_FORBIDDEN_KEYS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
];

// Entitlements required on the outer parent .app for MAS distribution.
const PARENT_REQUIRED_TRUE_KEYS = [
  "com.apple.security.app-sandbox",
  "com.apple.security.network.client",
];

// Entitlements that must NEVER appear on a child (non-Bun) Mach-O.
const CHILD_FORBIDDEN_KEYS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
];

// Entitlements that must NEVER appear on the Bun helper.
// `allow-jit` IS permitted there; the other two are not.
const BUN_HELPER_FORBIDDEN_KEYS = [
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
];

// Defensive: keys that have no business in a MAS-distributed entitlements
// plist. The store builds shouldn't carry "runFullTrust"-style keys; this is a
// belt-and-braces check.
const PARENT_DEFENSIVE_FORBIDDEN_KEYS = [
  "runFullTrust",
  "com.apple.security.runFullTrust",
];

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

function printUsage() {
  const usage = `Usage: node mas-smoke.mjs --app=<path/to/Built.app> [options]

Verify that a built macOS .app bundle was signed with the tightened MAS
entitlement set:
  - outer .app:        app-sandbox + network.client, NO JIT / NO unsigned-exec / NO library-validation bypass
  - Contents/MacOS/bun: app-sandbox + cs.inherit + allow-jit (scoped JIT)
  - every other Mach-O: app-sandbox + cs.inherit, no JIT, no exceptions

Options:
  --app=<path>   Required. Path to the built .app bundle.
  --launch       Optional. After verifying entitlements, runs \`open -W <app>\`
                 and tails 'log show --predicate "subsystem == com.apple.security.sandbox"'
                 for 30 seconds. Prints any sandbox violations. Skipped by default.
  --help         Print this message and exit.

Exit code:
  0  All entitlement assertions passed (or non-darwin platform — skipped).
  1  Assertion failure. Stderr names the offending Mach-O, key, expected, actual.
  2  Bad invocation (missing --app, --app not a .app directory, etc).
`;
  process.stdout.write(usage);
}

function isMachO(filePath) {
  const st = statSync(filePath);
  if (!st.isFile() || st.size < 4) return false;
  const fd = openSync(filePath, "r");
  const buf = Buffer.alloc(4);
  readSync(fd, buf, 0, 4, 0);
  closeSync(fd);
  return MACHO_MAGIC.has(buf.readUInt32BE(0));
}

function walkBundleFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

function findMachOFiles(appPath) {
  const machos = [];
  for (const filePath of walkBundleFiles(appPath)) {
    if (isMachO(filePath)) machos.push(filePath);
  }
  return machos;
}

/**
 * Parse a plist XML document produced by `codesign -d --entitlements - --xml`.
 *
 * Returns a `Map<string, true | false | string>`. Booleans become real booleans;
 * strings (e.g. `aps-environment`) become their literal string value. Other
 * value types (`<integer>`, `<array>`, `<dict>` nested) are returned as the
 * raw inner text for diagnostic purposes — entitlement plists rarely use them.
 *
 * Keys that are *absent* from the plist are simply not present in the Map.
 * Callers distinguish "missing" from "false" by checking `.has(key)`.
 */
function parseEntitlementsPlist(xml) {
  const out = new Map();
  // Strip XML/doctype declarations and the outer <plist><dict>...</dict></plist>
  // wrapper, then walk <key>...</key><value/> pairs in document order.
  const dictMatch = xml.match(/<dict\b[^>]*>([\s\S]*)<\/dict>/);
  if (!dictMatch) return out;
  const body = dictMatch[1];
  // Tokenize: match <key>...</key> followed by the next element.
  const re =
    /<key>([\s\S]*?)<\/key>\s*(<true\s*\/>|<false\s*\/>|<string>([\s\S]*?)<\/string>|<integer>([\s\S]*?)<\/integer>|<array\s*\/>|<array\b[^>]*>[\s\S]*?<\/array>|<dict\s*\/>|<dict\b[^>]*>[\s\S]*?<\/dict>)/g;
  let match = re.exec(body);
  while (match !== null) {
    const key = decodeXmlEntities(match[1].trim());
    const raw = match[2];
    let value;
    if (raw.startsWith("<true")) {
      value = true;
    } else if (raw.startsWith("<false")) {
      value = false;
    } else if (raw.startsWith("<string>")) {
      value = decodeXmlEntities(match[3] ?? "");
    } else if (raw.startsWith("<integer>")) {
      value = decodeXmlEntities(match[4] ?? "");
    } else {
      value = raw;
    }
    out.set(key, value);
    match = re.exec(body);
  }
  return out;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Shell out to `codesign -d --entitlements - --xml <target>` and return the
 * parsed entitlements Map. Returns an *empty* Map if the target has no
 * entitlements (codesign prints nothing on stdout in that case).
 *
 * Throws if codesign itself fails (e.g. unsigned binary, missing path).
 */
function readEntitlements(target) {
  const result = spawnSync(
    "codesign",
    ["-d", "--entitlements", "-", "--xml", target],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    // codesign prints "code object is not signed at all" on stderr for
    // unsigned targets. That's a real failure for our smoke check.
    const stderr = (result.stderr ?? "").trim();
    throw new Error(
      `codesign failed for ${target} (exit ${result.status}): ${stderr || "(no stderr)"}`,
    );
  }
  const stdout = result.stdout ?? "";
  if (!stdout.trim()) return new Map();
  return parseEntitlementsPlist(stdout);
}

class AssertionCollector {
  constructor() {
    this.failures = [];
  }

  failTrue(target, key, actualMap) {
    if (actualMap.get(key) === true) return;
    const actual = actualMap.has(key)
      ? JSON.stringify(actualMap.get(key))
      : "(absent)";
    this.failures.push(
      `${target}\n    key:      ${key}\n    expected: true\n    actual:   ${actual}`,
    );
  }

  failForbidden(target, key, actualMap) {
    if (!actualMap.has(key)) return;
    const actual = JSON.stringify(actualMap.get(key));
    this.failures.push(
      `${target}\n    key:      ${key}\n    expected: (absent)\n    actual:   ${actual}`,
    );
  }

  report() {
    if (this.failures.length === 0) return 0;
    process.stderr.write(
      `\nmas-smoke: ${this.failures.length} assertion failure(s):\n`,
    );
    for (const failure of this.failures) {
      process.stderr.write(`  - ${failure}\n`);
    }
    return 1;
  }
}

function assertParentEntitlements(appPath, ents, collector) {
  for (const key of PARENT_REQUIRED_TRUE_KEYS) {
    collector.failTrue(appPath, key, ents);
  }
  for (const key of PARENT_FORBIDDEN_KEYS) {
    collector.failForbidden(appPath, key, ents);
  }
  for (const key of PARENT_DEFENSIVE_FORBIDDEN_KEYS) {
    collector.failForbidden(appPath, key, ents);
  }
}

function assertBunHelperEntitlements(machoPath, ents, collector) {
  collector.failTrue(machoPath, "com.apple.security.cs.allow-jit", ents);
  for (const key of BUN_HELPER_FORBIDDEN_KEYS) {
    collector.failForbidden(machoPath, key, ents);
  }
}

function assertChildEntitlements(machoPath, ents, collector) {
  collector.failTrue(machoPath, "com.apple.security.inherit", ents);
  for (const key of CHILD_FORBIDDEN_KEYS) {
    collector.failForbidden(machoPath, key, ents);
  }
}

function tailSandboxLog(appPath) {
  console.log(
    `[mas-smoke] launching ${appPath} and tailing sandbox log for 30s...`,
  );
  // Block until the launched app exits OR 30s elapses, whichever comes first.
  // `open -W` waits for the app to terminate; we cap with our own timeout.
  const openProc = spawnSync("open", ["-W", appPath], {
    stdio: "inherit",
    timeout: 30_000,
  });
  console.log(
    `[mas-smoke] open -W exited with ${openProc.status ?? "(timeout)"}; collecting sandbox events`,
  );
  const logResult = spawnSync(
    "log",
    [
      "show",
      "--last",
      "1m",
      "--predicate",
      'subsystem == "com.apple.security.sandbox"',
    ],
    { encoding: "utf8" },
  );
  const stdout = logResult.stdout ?? "";
  const lines = stdout
    .split("\n")
    .filter((line) => /deny|violation/i.test(line));
  if (lines.length === 0) {
    console.log("[mas-smoke] no sandbox violations observed");
    return;
  }
  console.log(
    `[mas-smoke] ${lines.length} sandbox event(s) (containing deny/violation):`,
  );
  for (const line of lines) console.log(`  ${line}`);
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printUsage();
    return 0;
  }

  if (process.platform !== "darwin") {
    console.log("mas-smoke: skipped — not darwin");
    return 0;
  }

  const appPath = args.app;
  if (!appPath) {
    process.stderr.write(
      "mas-smoke: --app=<path/to/Built.app> is required\n\n",
    );
    printUsage();
    return 2;
  }
  if (!appPath.endsWith(".app")) {
    process.stderr.write(`mas-smoke: ${appPath} does not end in .app\n`);
    return 2;
  }
  if (!existsSync(appPath) || !statSync(appPath).isDirectory()) {
    process.stderr.write(`mas-smoke: ${appPath} is not a directory\n`);
    return 2;
  }

  const collector = new AssertionCollector();

  console.log(`mas-smoke: verifying ${appPath}`);

  // 1. Parent bundle entitlements.
  const parentEnts = readEntitlements(appPath);
  console.log(`  parent: ${parentEnts.size} entitlement keys`);
  assertParentEntitlements(appPath, parentEnts, collector);

  // 2. Walk every Mach-O. Skip the outer bundle (its entitlements were read
  // via the .app path above; codesign on the bundle reads its main executable
  // entitlements which we just checked).
  const machos = findMachOFiles(appPath);
  let bunHelperCount = 0;
  let childCount = 0;
  let parentMainExecCount = 0;
  for (const machoPath of machos) {
    const ents = readEntitlements(machoPath);
    const rel = path.relative(appPath, machoPath);
    if (isBunHelperBinary(machoPath, appPath)) {
      assertBunHelperEntitlements(machoPath, ents, collector);
      bunHelperCount += 1;
      console.log(`  bun-helper:  ${rel} (${ents.size} keys)`);
    } else if (isParentMainExecutable(machoPath, appPath)) {
      // The outer bundle's main executable carries the parent entitlements,
      // not child entitlements. We already validated those above; skip the
      // child assertions here so we don't double-report.
      parentMainExecCount += 1;
      console.log(`  parent-main: ${rel} (${ents.size} keys, validated above)`);
    } else {
      assertChildEntitlements(machoPath, ents, collector);
      childCount += 1;
    }
  }

  console.log(
    `  walked ${machos.length} Mach-O file(s): ${parentMainExecCount} parent main, ${bunHelperCount} bun-helper, ${childCount} child`,
  );

  if (bunHelperCount === 0) {
    console.log(
      "[mas-smoke] warning: no Bun helper Mach-O matched the BUN_HELPER_BINARY_NAMES classifier",
    );
    console.log(
      `[mas-smoke]          (expected one of: ${[...BUN_HELPER_BINARY_NAMES].join(", ")})`,
    );
  }

  const exit = collector.report();
  if (exit !== 0) return exit;

  if (args.launch) {
    tailSandboxLog(appPath);
  }

  console.log("mas-smoke: PASS");
  return 0;
}

function isParentMainExecutable(machoPath, appPath) {
  // The CFBundleExecutable for our app is `launcher` per Electrobun, located
  // at Contents/MacOS/launcher. Treat that Mach-O as carrying the parent
  // entitlements (already validated via `readEntitlements(appPath)`).
  const rel = path.relative(appPath, machoPath).split(path.sep).join("/");
  return rel === "Contents/MacOS/launcher";
}

// Exports for the self-test next to this script.
export {
  BUN_HELPER_FORBIDDEN_KEYS,
  CHILD_FORBIDDEN_KEYS,
  findMachOFiles,
  isMachO,
  isParentMainExecutable,
  PARENT_FORBIDDEN_KEYS,
  PARENT_REQUIRED_TRUE_KEYS,
  parseEntitlementsPlist,
  walkBundleFiles,
};

// Run when invoked directly, not when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  process.exit(main());
}
