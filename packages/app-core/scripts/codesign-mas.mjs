#!/usr/bin/env node
/**
 * Mac App Store post-package codesign.
 *
 * Walks a built .app bundle bottom-up, signing every Mach-O binary with the
 * narrowest applicable entitlements. Most nested code gets
 * mas-child.entitlements (app-sandbox + cs.inherit). The bundled Bun helper,
 * which imports Apple's JIT write-protection APIs on macOS, gets
 * mas-bun.entitlements (child entitlements + allow-jit). The outer .app gets
 * mas.entitlements and does not receive broad code-signing exceptions.
 *
 * Apple TN2206 mandates inside-out signing: deepest binaries first, then
 * frameworks (sealing their resources), then the outer .app. Anything not in
 * that order fails `codesign --verify --deep --strict`.
 *
 * Usage:
 *   node codesign-mas.mjs --app=path/to/Built.app
 *                         --identity="3rd Party Mac Developer Application: Acme (TEAMID)"
 *                         [--installer-identity="3rd Party Mac Developer Installer: Acme (TEAMID)"]
 *                         [--team-id=TEAMID]
 *                         [--dry-run]
 *                         [--out=path/to/out.pkg]
 *
 * Env equivalents (CLI args win):
 *   ELIZA_MAS_SIGNING_IDENTITY
 *   ELIZA_MAS_INSTALLER_IDENTITY
 *   ELIZA_APPLE_TEAM_ID
 *
 * Exits non-zero on any signing or verification failure.
 */

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
import { fileURLToPath } from "node:url";
import {
  assertMasEntitlementRuntimeEvidence,
  assertReviewedEntitlementsFile,
  assertReviewedEntitlementsText,
  loadEntitlementReviewManifest,
  scanAppleAppBundleForNativeRuntimeSignals,
} from "./lib/apple-entitlement-audit.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENTITLEMENTS_DIR = path.resolve(
  __dirname,
  "../platforms/electrobun/entitlements",
);
const PARENT_ENTITLEMENTS = path.join(ENTITLEMENTS_DIR, "mas.entitlements");
const CHILD_ENTITLEMENTS = path.join(
  ENTITLEMENTS_DIR,
  "mas-child.entitlements",
);
const BUN_ENTITLEMENTS = path.join(ENTITLEMENTS_DIR, "mas-bun.entitlements");

const MACHO_MAGIC = new Set([
  0xfeedface,
  0xfeedfacf, // 32 / 64-bit
  0xcefaedfe,
  0xcffaedfe, // byte-swapped
  0xcafebabe,
  0xbebafeca, // fat
]);

const FORBIDDEN_MAS_CODE_SIGNING_EXCEPTIONS = [
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.cs.allow-dyld-environment-variables",
];

/**
 * Mach-O basenames that get the Bun-specific MAS entitlements
 * (`mas-bun.entitlements`: app-sandbox + cs.inherit + allow-jit).
 *
 * Kept as a Set keyed by basename so the smoke harness and the signer agree
 * on which binaries are "the Bun helper". Today there is exactly one entry
 * because we ship one Bun runtime; if a fat-bundle ever ships a renamed Bun
 * helper, add the basename here.
 */
export const BUN_HELPER_BINARY_NAMES = new Set(["bun"]);

/**
 * True when `target` is the Bun runtime helper inside `appPath` — the only
 * Mach-O that should receive `mas-bun.entitlements`.
 *
 * Anchors on the relative location `Contents/MacOS/<basename>` so a stray
 * `bun`-named binary buried deeper in the bundle does not silently pick up
 * the JIT entitlement.
 */
export function isBunHelperBinary(target, appPath) {
  const rel = path.relative(appPath, target).split(path.sep).join("/");
  const basename = path.basename(rel);
  if (!BUN_HELPER_BINARY_NAMES.has(basename)) return false;
  return rel === `Contents/MacOS/${basename}`;
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

function isMachO(filePath) {
  const st = statSync(filePath);
  if (!st.isFile() || st.size < 4) return false;
  const fd = openSync(filePath, "r");
  const buf = Buffer.alloc(4);
  readSync(fd, buf, 0, 4, 0);
  closeSync(fd);
  return MACHO_MAGIC.has(buf.readUInt32BE(0));
}

function walkFiles(root) {
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

function walkDirs(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        out.push(full);
        stack.push(full);
      }
    }
  }
  return out;
}

/**
 * Returns the signing units inside `appPath`, ordered deepest-first.
 * A signing unit is either:
 *   - a Mach-O file (.dylib / .so / .node / executable / no-extension)
 *   - a *.framework directory (signed as a unit; its inner Mach-Os are signed
 *     individually too, but Apple wants the framework directory itself signed)
 *   - a nested .app or .xpc bundle
 */
function findSigningUnits(appPath) {
  const machos = [];
  for (const filePath of walkFiles(appPath)) {
    if (!isMachO(filePath)) continue;
    machos.push(filePath);
  }
  const bundles = walkDirs(appPath).filter(
    (dir) =>
      dir !== appPath &&
      (dir.endsWith(".framework") ||
        dir.endsWith(".app") ||
        dir.endsWith(".xpc") ||
        dir.endsWith(".bundle")),
  );
  const byDepth = (a, b) => b.split(path.sep).length - a.split(path.sep).length;
  return {
    machos: machos.sort(byDepth),
    bundles: bundles.sort(byDepth),
  };
}

function runOrPrint(cmd, args, dryRun) {
  const display = `${cmd} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;
  if (dryRun) {
    console.log(`[dry-run] ${display}`);
    return { status: 0 };
  }
  console.log(`+ ${display}`);
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`Command failed (${result.status}): ${display}`);
  }
  return result;
}

function runCapture(cmd, args) {
  const display = `${cmd} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.stdout.write(result.stdout ?? "");
    process.exitCode = result.status ?? 1;
    throw new Error(`Command failed (${result.status}): ${display}`);
  }
  return result.stdout;
}

function plistLint(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Entitlements file missing: ${filePath}`);
  }
  // Quick sanity — full lint requires `plutil`, which only exists on macOS.
  // Validate XML well-formedness with a minimal regex check; macOS will
  // re-validate during `codesign`.
  const content = readFileSync(filePath, "utf8");
  if (!/<plist\b[^>]*>[\s\S]*<\/plist>/i.test(content)) {
    throw new Error(`Entitlements not a well-formed plist: ${filePath}`);
  }
}

function assertSourceEntitlementsReviewed(manifest) {
  assertReviewedEntitlementsFile({
    filePath: PARENT_ENTITLEMENTS,
    targetId: "macos-mas-app",
    manifest,
    label: "macOS MAS parent entitlements",
  });
  assertReviewedEntitlementsFile({
    filePath: CHILD_ENTITLEMENTS,
    targetId: "macos-mas-child",
    manifest,
    label: "macOS MAS child entitlements",
  });
  assertReviewedEntitlementsFile({
    filePath: BUN_ENTITLEMENTS,
    targetId: "macos-mas-bun",
    manifest,
    label: "macOS MAS Bun helper entitlements",
  });
}

function assertNoForbiddenMasExceptions(filePath) {
  const content = readFileSync(filePath, "utf8");
  const forbidden = FORBIDDEN_MAS_CODE_SIGNING_EXCEPTIONS.filter((key) =>
    content.includes(key),
  );
  if (forbidden.length === 0) return;
  throw new Error(
    `MAS entitlements file contains forbidden code-signing exception(s): ${filePath}\n` +
      forbidden.map((key) => `  - ${key}`).join("\n"),
  );
}

function assertSignedEntitlements(target, targetId, label, manifest) {
  const entitlementsXml = runCapture("codesign", [
    "-d",
    "--entitlements",
    ":-",
    target,
  ]);
  return assertReviewedEntitlementsText({
    plistXml: entitlementsXml,
    targetId,
    manifest,
    label,
  });
}

function sign(target, entitlements, identity, dryRun) {
  runOrPrint(
    "codesign",
    [
      "--force",
      "--timestamp",
      "--options",
      "runtime",
      "--entitlements",
      entitlements,
      "--sign",
      identity,
      target,
    ],
    dryRun,
  );
}

function entitlementsForMacho(target, appPath) {
  return isBunHelperBinary(target, appPath)
    ? BUN_ENTITLEMENTS
    : CHILD_ENTITLEMENTS;
}

function entitlementTargetIdForMacho(target, appPath) {
  return isBunRuntimeExecutable(target, appPath)
    ? "macos-mas-bun"
    : "macos-mas-child";
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(
      readFileSync(__filename, "utf8").split("\n").slice(2, 32).join("\n"),
    );
    return;
  }

  const appPath = args.app;
  if (!appPath) {
    console.error("error: --app=<path/to/Built.app> is required");
    process.exit(2);
  }
  if (!existsSync(appPath) || !appPath.endsWith(".app")) {
    console.error(`error: ${appPath} is not a .app bundle`);
    process.exit(2);
  }

  const dryRun = Boolean(args["dry-run"]);

  const identity =
    args.identity ?? process.env.ELIZA_MAS_SIGNING_IDENTITY ?? null;
  if (!identity) {
    console.error(
      "error: --identity or ELIZA_MAS_SIGNING_IDENTITY required " +
        '(e.g. "3rd Party Mac Developer Application: Acme (TEAMID)")',
    );
    process.exit(2);
  }

  const installerIdentity =
    args["installer-identity"] ??
    process.env.ELIZA_MAS_INSTALLER_IDENTITY ??
    null;

  plistLint(PARENT_ENTITLEMENTS);
  plistLint(CHILD_ENTITLEMENTS);
  plistLint(BUN_ENTITLEMENTS);
  assertNoForbiddenMasExceptions(PARENT_ENTITLEMENTS);
  assertNoForbiddenMasExceptions(CHILD_ENTITLEMENTS);
  assertNoForbiddenMasExceptions(BUN_ENTITLEMENTS);
  const entitlementManifest = loadEntitlementReviewManifest();
  assertSourceEntitlementsReviewed(entitlementManifest);

  console.log(`MAS codesign for ${appPath}`);
  console.log(`  identity: ${identity}`);
  if (installerIdentity) {
    console.log(`  installer-identity: ${installerIdentity}`);
  }
  console.log(`  parent entitlements: ${PARENT_ENTITLEMENTS}`);
  console.log(`  child entitlements:  ${CHILD_ENTITLEMENTS}`);
  console.log(`  bun entitlements:    ${BUN_ENTITLEMENTS}`);
  if (dryRun) console.log("  mode: DRY RUN — no commands will execute");

  const { machos, bundles } = findSigningUnits(appPath);

  // 1. Sign all loose Mach-O binaries with the narrowest matching
  // entitlements (deepest first).
  console.log(`\nSigning ${machos.length} Mach-O binaries:`);
  for (const target of machos) {
    sign(target, entitlementsForMacho(target, appPath), identity, dryRun);
  }

  // 2. Sign nested bundles (frameworks, helper apps, xpc, .bundle) deepest-first.
  console.log(
    `\nSigning ${bundles.length} nested bundles (child entitlements):`,
  );
  for (const target of bundles) {
    sign(target, CHILD_ENTITLEMENTS, identity, dryRun);
  }

  // 3. Sign the parent .app with parent entitlements.
  console.log(`\nSigning parent app with MAS entitlements:`);
  sign(appPath, PARENT_ENTITLEMENTS, identity, dryRun);

  // 4. Verify.
  console.log(`\nVerifying signature:`);
  runOrPrint(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    dryRun,
  );

  if (!dryRun) {
    console.log(`\nAuditing signed entitlements:`);
    const nativeScan = scanAppleAppBundleForNativeRuntimeSignals(appPath);
    for (const target of machos) {
      const targetId = entitlementTargetIdForMacho(target, appPath);
      const entitlements = assertSignedEntitlements(
        target,
        targetId,
        `signed Mach-O ${path.relative(appPath, target)}`,
        entitlementManifest,
      );
      assertMasEntitlementRuntimeEvidence({
        entitlements,
        scan: nativeScan,
        label: `signed Mach-O ${path.relative(appPath, target)}`,
      });
    }
    for (const target of bundles) {
      assertSignedEntitlements(
        target,
        "macos-mas-child",
        `signed nested bundle ${path.relative(appPath, target)}`,
        entitlementManifest,
      );
    }
    assertSignedEntitlements(
      appPath,
      "macos-mas-app",
      `signed parent app ${path.basename(appPath)}`,
      entitlementManifest,
    );

    console.log(`\nNative runtime evidence scan:`);
    console.log(`  Mach-O files: ${nativeScan.machOCount}`);
    console.log(
      `  JIT/executable-memory findings: ${nativeScan.jitExecutableMemory.length}`,
    );
    console.log(
      `  native library findings: ${nativeScan.dynamicLibraryLoading.length}`,
    );
  }

  // 5. Optional productbuild for MAS submission.
  if (installerIdentity) {
    const pkgOut =
      args.out ??
      path.join(path.dirname(appPath), `${path.basename(appPath, ".app")}.pkg`);
    console.log(`\nProductbuilding MAS .pkg → ${pkgOut}`);
    runOrPrint(
      "productbuild",
      [
        "--component",
        appPath,
        "/Applications",
        "--sign",
        installerIdentity,
        pkgOut,
      ],
      dryRun,
    );
  }

  console.log(`\n${dryRun ? "[dry-run] " : ""}Done.`);
}

// Run only when invoked as a script; the smoke harness imports
// `BUN_HELPER_BINARY_NAMES` / `isBunHelperBinary` from this module.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
