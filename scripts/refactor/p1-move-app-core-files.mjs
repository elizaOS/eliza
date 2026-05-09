#!/usr/bin/env bun
// P1a — Move app-core's React/state/hooks into @elizaos/ui, and pure types/utils
// into @elizaos/shared. Writes a JSON migration manifest at /tmp that the
// import-rewrite phase (p1b) consumes.
//
// File-collision policy: if the destination path already exists, the script
// logs MANUAL and skips that file. No overwrites.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  REPO_ROOT,
  Stats,
  makeLogger,
  moveFile,
  parseFlags,
  preflight,
  removeFile,
  writeFileIfChanged,
} from "./lib/util.mjs";

// ────────────────────────────────────────────────────────────────────────────
// Directory-level moves. Each entry says "everything under `from` moves into
// `to`, preserving relative structure". The dest package's existing files are
// never overwritten — collisions log MANUAL.

const DIR_MOVES = [
  // ── React / browser → @elizaos/ui ────────────────────────────────────────
  { from: "packages/app-core/src/components", to: "packages/ui/src/components" },
  { from: "packages/app-core/src/state", to: "packages/ui/src/state" },
  { from: "packages/app-core/src/hooks", to: "packages/ui/src/hooks" },
  { from: "packages/app-core/src/widgets", to: "packages/ui/src/widgets" },
  { from: "packages/app-core/src/navigation", to: "packages/ui/src/navigation" },
  { from: "packages/app-core/src/i18n", to: "packages/ui/src/i18n" },
  { from: "packages/app-core/src/styles", to: "packages/ui/src/styles" },

  // electrobun-rpc is browser/preload-side; the runtime side stays in app-core
  {
    from: "packages/app-core/src/bridge/electrobun-rpc.ts",
    to: "packages/ui/src/bridge/electrobun-rpc.ts",
    file: true,
  },

  // ── Pure types / utils → @elizaos/shared ─────────────────────────────────
  { from: "packages/app-core/src/types", to: "packages/shared/src/types" },
  { from: "packages/app-core/src/events", to: "packages/shared/src/events" },
  { from: "packages/app-core/src/voice", to: "packages/shared/src/voice" },
  { from: "packages/app-core/src/config", to: "packages/shared/src/config" },
  { from: "packages/app-core/src/onboarding", to: "packages/shared/src/onboarding" },
  { from: "packages/app-core/src/test-support", to: "packages/shared/src/test-support" },

  // utils splits — only pure-JS modules go to shared. Anything that imports
  // node: stays. Caller below splits these per-file.
  // (This entry left as MANUAL because individual file inspection is required.)
];

const PARTIAL_DIRS = [
  // For these dirs, we walk file-by-file: pure files go to shared, files that
  // import `node:`/`fs`/`path`/etc stay in app-core.
  {
    from: "packages/app-core/src/utils",
    pure: "packages/shared/src/utils",
  },
];

// ────────────────────────────────────────────────────────────────────────────

const MANIFEST_PATH = "/tmp/refactor-p1-manifest.json";

async function main() {
  const flags = parseFlags();
  const log = makeLogger(flags);
  preflight("p1-move-app-core-files", flags, log);
  const stats = new Stats();

  /** @type {Array<{ from: string, to: string }>} */
  const manifest = [];

  log.section("Whole-directory moves into @elizaos/ui");
  for (const move of DIR_MOVES.filter((m) => m.to.includes("packages/ui/"))) {
    walkAndMove(move, flags, log, stats, manifest);
  }

  log.section("Whole-directory moves into @elizaos/shared");
  for (const move of DIR_MOVES.filter((m) => m.to.includes("packages/shared/"))) {
    walkAndMove(move, flags, log, stats, manifest);
  }

  log.section("Partial-directory moves (per-file inspection)");
  for (const partial of PARTIAL_DIRS) {
    walkAndSplit(partial, flags, log, stats, manifest);
  }

  // Write manifest for p1b (imports phase) to consume.
  // Always write (even in dry-run) so the next phase can sequence; the
  // manifest is tooling output, not a mutation to the worktree.
  log.section("Write migration manifest");
  log.info(`manifest: ${MANIFEST_PATH} (${manifest.length} entries)`);
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  stats.print(log);
}

function walkAndMove(move, flags, log, stats, manifest) {
  const fromAbs = join(REPO_ROOT, move.from);
  const toAbs = join(REPO_ROOT, move.to);

  if (move.file) {
    if (!existsSync(fromAbs)) {
      log.verbose(`skip (missing): ${move.from}`);
      return;
    }
    if (existsSync(toAbs)) {
      log.manual(`collision: ${move.to} (skipping ${move.from})`);
      stats.incr("collisions");
      return;
    }
    if (moveFile(fromAbs, toAbs, flags, log)) {
      manifest.push({ from: move.from, to: move.to });
      stats.incr("files moved");
    }
    return;
  }

  if (!existsSync(fromAbs) || !statSync(fromAbs).isDirectory()) {
    log.verbose(`skip (no dir): ${move.from}`);
    return;
  }

  walkDir(fromAbs, (file) => {
    const rel = relative(fromAbs, file);
    const targetAbs = join(toAbs, rel);
    const targetRel = relative(REPO_ROOT, targetAbs);
    const sourceRel = relative(REPO_ROOT, file);
    if (existsSync(targetAbs)) {
      if (isIndexFile(sourceRel)) {
        mergeIndexBarrel(file, targetAbs, flags, log, stats);
        manifest.push({ from: sourceRel, to: targetRel });
        return;
      }
      log.manual(`collision: ${targetRel} (skipping ${sourceRel})`);
      stats.incr("collisions");
      return;
    }
    if (moveFile(file, targetAbs, flags, log)) {
      manifest.push({ from: sourceRel, to: targetRel });
      stats.incr("files moved");
    }
  });
}

function walkAndSplit(partial, flags, log, stats, manifest) {
  const fromAbs = join(REPO_ROOT, partial.from);
  const pureAbs = join(REPO_ROOT, partial.pure);

  if (!existsSync(fromAbs)) {
    log.verbose(`skip (missing): ${partial.from}`);
    return;
  }

  walkDir(fromAbs, (file) => {
    const source = readFileSync(file, "utf8");
    const isPure = !/(?:^|\W)(?:from|require\()\s*["'](?:node:|fs|path|os|child_process|http|https|net|crypto|url|zlib)(?:\/|["'])/.test(
      source,
    );
    if (!isPure) {
      log.verbose(`stays (node-using): ${relative(REPO_ROOT, file)}`);
      return;
    }
    const rel = relative(fromAbs, file);
    const targetAbs = join(pureAbs, rel);
    const targetRel = relative(REPO_ROOT, targetAbs);
    const sourceRel = relative(REPO_ROOT, file);
    if (existsSync(targetAbs)) {
      if (isIndexFile(sourceRel)) {
        mergeIndexBarrel(file, targetAbs, flags, log, stats);
        manifest.push({ from: sourceRel, to: targetRel });
        return;
      }
      log.manual(`collision: ${targetRel} (skipping ${sourceRel})`);
      stats.incr("collisions");
      return;
    }
    if (moveFile(file, targetAbs, flags, log)) {
      manifest.push({ from: sourceRel, to: targetRel });
      stats.incr("partial files moved");
    }
  });
}

function walkDir(dir, fn) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walkDir(full, fn);
    } else if (entry.isFile()) {
      fn(full);
    }
  }
}

function isIndexFile(repoRelPath) {
  return /(?:^|\/)index\.tsx?$/.test(repoRelPath);
}

function mergeIndexBarrel(sourceAbs, targetAbs, flags, log, stats) {
  const sourceRel = relative(REPO_ROOT, sourceAbs);
  const targetRel = relative(REPO_ROOT, targetAbs);
  const source = readFileSync(sourceAbs, "utf8");
  const target = readFileSync(targetAbs, "utf8");
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !target.includes(line));
  if (lines.length > 0) {
    const next = `${target.trimEnd()}\n${lines.join("\n")}\n`;
    log.info(`merge index barrel: ${sourceRel} → ${targetRel}`);
    writeFileIfChanged(targetAbs, next, flags, log);
    stats.incr("index barrels merged");
  } else {
    log.info(`index barrel already covered: ${targetRel}`);
  }
  removeFile(sourceAbs, flags, log);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
