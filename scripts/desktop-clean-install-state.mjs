#!/usr/bin/env node
/**
 * Removes every persistence surface a macOS Eliza desktop install can leave
 * behind, so a fresh build genuinely starts from first-run. Filesystem wipes
 * alone are not enough: the shell keeps runtime/session records in the macOS
 * Keychain (services `eliza` and `ai.elizaos.agent.vault`), and a surviving
 * `runtime.active_server` record makes a "fresh" install restore a stale cloud
 * agent target while the auth gate still demands sign-in — the pill then
 * silently no-ops (the state contradiction behind the 2026-08-23 dead-pill
 * debugging session). Default is a dry run that lists findings; pass --apply
 * to delete. --keep-keychain / --keep-files scope the wipe.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

/** Keychain generic-password services the desktop stack writes. */
export const ELIZA_KEYCHAIN_SERVICES = Object.freeze([
  // Electrobun shell secure store: runtime.active_server, session.steward_token,
  // session.device_auth, runtime.agent_profiles (account = local username).
  "eliza",
  // Per-install agent secret vault (accounts are derived `mldy1-…` handles).
  "ai.elizaos.agent.vault",
]);

/** Filesystem roots an install writes, resolved per app id / namespace. */
export function elizaStateLocations({ home = HOME, env = process.env } = {}) {
  const appSupport = path.join(home, "Library", "Application Support");
  const xdgStateHome = env.XDG_STATE_HOME?.trim()
    ? path.isAbsolute(env.XDG_STATE_HOME.trim())
      ? env.XDG_STATE_HOME.trim()
      : path.join(home, env.XDG_STATE_HOME.trim())
    : path.join(home, ".local", "state");
  return [
    // WKWebView/renderer storage keyed by bundle id.
    path.join(appSupport, "ai.elizaos.app"),
    // Brand configDirName (packaged brand-config.json `configDirName: "Eliza"`).
    path.join(appSupport, "Eliza"),
    path.join(home, "Library", "WebKit", "ai.elizaos.app"),
    path.join(home, "Library", "HTTPStorages", "ai.elizaos.app"),
    path.join(home, "Library", "Caches", "ai.elizaos.app"),
    path.join(home, "Library", "Preferences", "ai.elizaos.app.plist"),
    path.join(
      home,
      "Library",
      "Saved Application State",
      "ai.elizaos.app.savedState",
    ),
    path.join(home, "Library", "Logs", "Eliza"),
    // Canonical agent state dir (ELIZA_STATE_DIR > XDG default). Holds the
    // agent database, media store, and the input from which vault account
    // handles are derived.
    env.ELIZA_STATE_DIR?.trim() ||
      path.join(xdgStateHome, env.ELIZA_NAMESPACE?.trim() || "eliza"),
  ];
}

/** Installed app bundles (any Eliza*.app in /Applications and ~/Applications). */
export function installedElizaBundles({ home = HOME } = {}) {
  const roots = ["/Applications", path.join(home, "Applications")];
  const bundles = [];
  for (const root of roots) {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      continue; // error-policy:J4 unreadable root — nothing to list there
    }
    for (const name of names) {
      if (/^Eliza.*\.app$/.test(name)) bundles.push(path.join(root, name));
    }
  }
  return bundles;
}

function listKeychainItems(service) {
  // `security find-generic-password` returns one match; dump-keychain lists
  // all. Filter dump output for the service to count matching items.
  const dump = spawnSync("security", ["dump-keychain"], { encoding: "utf8" });
  if (dump.status !== 0) return null;
  const needle = `"svce"<blob>="${service}"`;
  return dump.stdout
    .split("keychain:")
    .filter((entry) => entry.includes(needle)).length;
}

function deleteKeychainService(service) {
  // Items under one service can differ by account; loop until none remain.
  // Bounded so a permission-denied item cannot loop forever.
  for (let i = 0; i < 64; i += 1) {
    const res = spawnSync(
      "security",
      ["delete-generic-password", "-s", service],
      { encoding: "utf8" },
    );
    if (res.status !== 0) return i; // no more matches (or denied) — report count
  }
  return 64;
}

function quitElizaProcesses({ apply }) {
  const probe = spawnSync("pgrep", ["-fl", "Eliza"], { encoding: "utf8" });
  const lines = (probe.stdout ?? "")
    .split("\n")
    .filter((line) => /Eliza[^/]*\.app/.test(line));
  if (lines.length === 0) return { running: 0 };
  if (apply) {
    spawnSync("pkill", ["-f", "Eliza.*\\.app"], { encoding: "utf8" });
  }
  return { running: lines.length };
}

export function parseCleanArgs(argv) {
  const args = {
    apply: false,
    keepKeychain: false,
    keepFiles: false,
    keepBundles: true,
  };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--keep-keychain") args.keepKeychain = true;
    else if (arg === "--keep-files") args.keepFiles = true;
    else if (arg === "--delete-bundles") args.keepBundles = false;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/desktop-clean-install-state.mjs [options]

Wipes macOS Eliza desktop install state: app data, WebKit storage, caches,
preferences, the agent state dir, AND the Keychain records (the part a
filesystem wipe misses — a stale runtime.active_server Keychain record makes
a fresh install restore a dead cloud target and silently break sign-in).

Default is a DRY RUN. Nothing is deleted without --apply.

Options:
  --apply            Actually delete (default: list what would be deleted)
  --keep-keychain    Skip Keychain services (${ELIZA_KEYCHAIN_SERVICES.join(", ")})
  --keep-files       Skip filesystem state
  --delete-bundles   Also remove Eliza*.app bundles from /Applications
  -h, --help         Show this help
`);
}

function main() {
  let args;
  try {
    args = parseCleanArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    printUsage();
    process.exit(2);
  }
  if (args.help) {
    printUsage();
    return;
  }
  if (process.platform !== "darwin") {
    console.error("This cleanup targets macOS desktop installs only.");
    process.exit(1);
  }

  const mode = args.apply ? "APPLY" : "DRY RUN";
  console.log(`[desktop-clean] ${mode}`);

  const procs = quitElizaProcesses({ apply: args.apply });
  if (procs.running > 0) {
    console.log(
      `[desktop-clean] ${procs.running} running Eliza process(es)${args.apply ? " — terminated" : " (would terminate)"}`,
    );
  }

  if (!args.keepFiles) {
    for (const location of elizaStateLocations()) {
      if (!fs.existsSync(location)) continue;
      if (args.apply) {
        fs.rmSync(location, { recursive: true, force: true });
        console.log(`[desktop-clean] removed ${location}`);
      } else {
        console.log(`[desktop-clean] would remove ${location}`);
      }
    }
  }

  if (!args.keepBundles) {
    for (const bundle of installedElizaBundles()) {
      if (args.apply) {
        fs.rmSync(bundle, { recursive: true, force: true });
        console.log(`[desktop-clean] removed ${bundle}`);
      } else {
        console.log(`[desktop-clean] would remove ${bundle}`);
      }
    }
  } else {
    const bundles = installedElizaBundles();
    if (bundles.length > 0) {
      console.log(
        `[desktop-clean] leaving ${bundles.length} app bundle(s) installed (pass --delete-bundles to remove): ${bundles.join(", ")}`,
      );
    }
  }

  if (!args.keepKeychain) {
    for (const service of ELIZA_KEYCHAIN_SERVICES) {
      const count = listKeychainItems(service);
      if (count === null) {
        console.log(
          `[desktop-clean] could not inspect Keychain for service "${service}" (security dump failed)`,
        );
        continue;
      }
      if (count === 0) continue;
      if (args.apply) {
        const deleted = deleteKeychainService(service);
        console.log(
          `[desktop-clean] deleted ${deleted} Keychain item(s) for service "${service}"`,
        );
      } else {
        console.log(
          `[desktop-clean] would delete ${count} Keychain item(s) for service "${service}"`,
        );
      }
    }
  }

  if (!args.apply) {
    console.log(
      "[desktop-clean] dry run complete — re-run with --apply to delete",
    );
  } else {
    console.log(
      "[desktop-clean] done — next launch starts from a genuine first run",
    );
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (invokedDirectly) main();
