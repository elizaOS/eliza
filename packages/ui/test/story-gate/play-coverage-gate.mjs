#!/usr/bin/env node
/**
 * Storybook `play`-coverage ratchet (issue #9943).
 *
 * The story gate (`run-story-gate.mjs`) proves every story MOUNTS; it does not
 * prove component interactions work. Most stories are render-only — only a small
 * set export a `play` (Storybook's interaction-test hook). A naive "require `play`
 * on every story" would red ~300 stories at once, so this is an eslint-style
 * RATCHET instead: the set of stories that currently have a `play` is the
 * committed floor, and the gate fails when any of them LOSES its `play` (an
 * interaction-test regression) or the total count drops below the floor. New
 * `play`s are encouraged (ratchet up via `--update-baseline`), never required.
 *
 * Source-static (scans `*.stories.tsx`) — no Storybook build or browser needed,
 * so it runs fast on every PR.
 *
 * Usage:
 *   node test/story-gate/play-coverage-gate.mjs [--update-baseline]
 *
 * Exit codes: 0 clean · 1 regression (a tracked story lost `play`, or count fell).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const baselinePath = join(here, "baseline", "play-baseline.json");

/** Roots scanned for `*.stories.tsx`. */
const SCAN_ROOTS = ["packages/ui/src", "plugins/plugin-companion/src"];

/** A `play` is `play:` (CSF3 object) or `.play =` (CSF2 assignment); `\bplay\b`
 * avoids matching `display`/`replay`. */
const PLAY_RE = /\bplay\b\s*[:=]/;

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (
        e.name === "node_modules" ||
        e.name === "dist" ||
        e.name === "storybook-static"
      )
        continue;
      walk(full, out);
    } else if (e.isFile() && e.name.endsWith(".stories.tsx")) {
      out.push(full);
    }
  }
  return out;
}

function storyFilesWithPlay() {
  const withPlay = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(repoRoot, root);
    try {
      statSync(abs);
    } catch {
      continue;
    }
    for (const file of walk(abs, [])) {
      const src = readFileSync(file, "utf8");
      if (PLAY_RE.test(src))
        withPlay.push(relative(repoRoot, file).replaceAll("\\", "/"));
    }
  }
  return withPlay.sort();
}

function loadBaseline() {
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
    return Array.isArray(parsed.files) ? parsed.files : [];
  } catch {
    return [];
  }
}

const updateBaseline = process.argv.includes("--update-baseline");
const current = storyFilesWithPlay();

if (updateBaseline) {
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ description: "Story files with a Storybook `play` interaction test (#9943 ratchet floor). Regenerate with: bun run --cwd packages/ui audit:stories:play -- --update-baseline", files: current }, null, 2)}\n`,
  );
  console.log(
    `[play-gate] baseline updated: ${current.length} stories with a play`,
  );
  process.exit(0);
}

const baseline = loadBaseline();
const currentSet = new Set(current);
const lost = baseline.filter((f) => !currentSet.has(f));

if (lost.length > 0) {
  console.error(
    `[play-gate] REGRESSION: ${lost.length} story file(s) that had a \`play\` interaction test lost it:\n` +
      lost.map((f) => `  - ${f}`).join("\n") +
      `\nAdd the \`play\` back, or (if intentional) regenerate the baseline with:\n` +
      `  bun run --cwd packages/ui audit:stories:play -- --update-baseline`,
  );
  process.exit(1);
}

if (current.length < baseline.length) {
  console.error(
    `[play-gate] REGRESSION: play-coverage fell from ${baseline.length} to ${current.length} stories.`,
  );
  process.exit(1);
}

const added = current.filter((f) => !baseline.includes(f));
console.log(
  `[play-gate] OK — ${current.length} stories have a play (floor ${baseline.length})` +
    (added.length
      ? `; ${added.length} new (run --update-baseline to lock them in)`
      : ""),
);
process.exit(0);
