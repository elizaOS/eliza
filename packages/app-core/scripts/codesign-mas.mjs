#!/usr/bin/env node
/**
 * Mac App Store post-package codesign.
 *
 * Walks a built .app bundle bottom-up, signing every Mach-O binary with the
 * child entitlements (mas-child.entitlements: app-sandbox + cs.inherit), then
 * signs the outer .app with the parent entitlements (mas.entitlements). Final
 * step verifies the bundle and (optionally) productbuilds a .pkg installer.
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
 * Exits non-zero on any signing or verification failure. No try/catch sludge.
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

const MACHO_MAGIC = new Set([
  0xfeedface,
  0xfeedfacf, // 32 / 64-bit
  0xcefaedfe,
  0xcffaedfe, // byte-swapped
  0xcafebabe,
  0xbebafeca, // fat
]);

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

  console.log(`MAS codesign for ${appPath}`);
  console.log(`  identity: ${identity}`);
  if (installerIdentity) {
    console.log(`  installer-identity: ${installerIdentity}`);
  }
  console.log(`  parent entitlements: ${PARENT_ENTITLEMENTS}`);
  console.log(`  child entitlements:  ${CHILD_ENTITLEMENTS}`);
  if (dryRun) console.log("  mode: DRY RUN — no commands will execute");

  const { machos, bundles } = findSigningUnits(appPath);

  // 1. Sign all loose Mach-O binaries with child entitlements (deepest first).
  console.log(
    `\nSigning ${machos.length} Mach-O binaries (child entitlements):`,
  );
  for (const target of machos) {
    sign(target, CHILD_ENTITLEMENTS, identity, dryRun);
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

main();
