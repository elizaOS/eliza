#!/usr/bin/env node
/**
 * One-command PR evidence attach for agents and humans: uploads media/log
 * artifacts to the shared `pr-evidence` release (the CLI attachment path for
 * headless agents that cannot drag-and-drop), rewrites the PR body's
 * `evidence-row:*` rows to reference the uploaded assets, and re-runs the
 * local evidence gate against the resulting body so the author knows the CI
 * check will pass BEFORE pushing the edit. Exists because the manual loop
 * (upload → copy URLs → hand-edit eight rows → wait for CI) is exactly the
 * friction that made agents skip evidence.
 *
 *   node scripts/pr-evidence.mjs attach <pr> <files...>        upload + print URLs
 *   node scripts/pr-evidence.mjs rows <pr> --row id=<file|url|"N/A - reason"> …
 *                                                              patch body rows + verify
 *   node scripts/pr-evidence.mjs verify <pr>                   run the gate locally
 *
 * `attach` prefixes every asset `<pr>-` so one release serves all PRs, and
 * skips re-uploading an asset that already exists on ANY pr-evidence release.
 * GitHub caps a release at 1000 assets, so once the primary `pr-evidence`
 * release fills, uploads roll deterministically into `pr-evidence-2`,
 * `pr-evidence-3`, … — the newest release with free capacity, creating the next
 * one when none has room. Every emitted URL points at whichever release actually
 * holds the asset, and the evidence gate (check-pr-evidence.mjs) accepts the
 * whole `pr-evidence`/`pr-evidence-N` family identically.
 * `rows` accepts a local file (uploaded automatically), an existing URL, or an
 * `N/A - reason` string per row; rows not named are left untouched. Every
 * mutation is previewed and the gate verdict printed; `--dry-run` stops before
 * editing the PR.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const PRIMARY_RELEASE_TAG = "pr-evidence";
const REPO = "elizaOS/eliza";
// GitHub caps a single release at 1000 assets. Keep headroom below that so a
// normal multi-file batch never straddles the boundary; roll to the next
// overflow release before the wall. The 422 fallback in `uploadAssets` covers
// the residual race where concurrent lanes fill a release between our capacity
// read and our upload.
export const MAX_ASSETS_PER_RELEASE = 1000;
export const ASSET_CAPACITY_THRESHOLD = 990;
const releaseDownloadBase = (tag) =>
  `https://github.com/${REPO}/releases/download/${tag}`;
const PRIMARY_ASSET_BASE = releaseDownloadBase(PRIMARY_RELEASE_TAG);
const ROW_IDS = [
  "before-screenshots",
  "after-screenshots",
  "walkthrough-video",
  "backend-logs",
  "frontend-logs",
  "llm-trajectory",
  "domain-artifacts",
  "ocr-review",
];

function gh(args, opts = {}) {
  return execFileSync("gh", args, { encoding: "utf8", ...opts });
}

function fail(message) {
  console.error(`pr-evidence: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  node scripts/pr-evidence.mjs attach <pr> <files...>
      Upload files to the '${PRIMARY_RELEASE_TAG}' release as <pr>-<name> and
      print the asset URLs ready to paste into evidence rows. Once the primary
      release is full, uploads roll into '${PRIMARY_RELEASE_TAG}-2', '-3', … and
      the printed URLs point at whichever release holds the asset.

  node scripts/pr-evidence.mjs rows <pr> [--dry-run] --row <id>=<value> [...]
      Patch the PR body's evidence rows and verify the gate locally.
      <id>    one of: ${ROW_IDS.join(", ")}
      <value> a local file path (auto-uploaded), an https URL, or an
              'N/A - <reason>' string.

  node scripts/pr-evidence.mjs verify <pr>
      Fetch the PR body/labels/files and run the local evidence gate exactly
      as CI does.

Assets land on: ${PRIMARY_ASSET_BASE}/<pr>-<filename>
  (or the current '${PRIMARY_RELEASE_TAG}-N' overflow release once it fills)
Worked example of a fully evidenced PR: https://github.com/elizaOS/eliza/pull/15171`);
}

/** Sequence index of a pr-evidence-family tag: `pr-evidence` → 1, `pr-evidence-N` → N; null for any other tag. A stray `pr-evidence-1` is not the canonical primary and is ignored. */
export function prEvidenceReleaseIndex(tag) {
  if (tag === PRIMARY_RELEASE_TAG) return 1;
  const match = /^pr-evidence-(\d+)$/.exec(tag ?? "");
  if (!match) return null;
  const index = Number(match[1]);
  return index >= 2 ? index : null;
}

/** The tag for a sequence index: 1 → `pr-evidence`, N≥2 → `pr-evidence-N`. */
export function prEvidenceTagForIndex(index) {
  return index <= 1 ? PRIMARY_RELEASE_TAG : `${PRIMARY_RELEASE_TAG}-${index}`;
}

/**
 * Choose which pr-evidence-family release receives `neededSlots` new assets.
 * Prefers the highest-indexed EXISTING release that still has capacity (packs
 * uploads into the newest release); when none has room, returns the next tag in
 * the deterministic sequence with `create: true`. Never selects a release whose
 * post-upload count would exceed GitHub's hard cap. Pure — the caller supplies
 * the observed `{tag, count}` list — so the selection rule is unit-testable
 * without touching the network.
 *
 * @param {{tag: string, count: number}[]} releases
 * @param {number} neededSlots
 * @returns {{ tag: string, create: boolean }}
 */
export function selectPrEvidenceTarget(releases, neededSlots) {
  const family = releases
    .map((release) => ({
      ...release,
      index: prEvidenceReleaseIndex(release.tag),
    }))
    .filter((release) => release.index !== null)
    .sort((a, b) => a.index - b.index);

  const withRoom = family.filter(
    (release) =>
      release.count < ASSET_CAPACITY_THRESHOLD &&
      release.count + neededSlots <= MAX_ASSETS_PER_RELEASE,
  );
  if (withRoom.length > 0) {
    return { tag: withRoom[withRoom.length - 1].tag, create: false };
  }
  const maxIndex = family.length > 0 ? family[family.length - 1].index : 0;
  return { tag: prEvidenceTagForIndex(maxIndex + 1), create: true };
}

/** Every pr-evidence-family release with its assets (one NDJSON object per release from the paginated releases API). `run` is the `gh` invoker — injectable so the fetch/roll-over pipeline is unit-testable without the network. */
export function fetchPrEvidenceReleases(run = gh) {
  const out = run([
    "api",
    "repos/{owner}/{repo}/releases",
    "--paginate",
    "-q",
    '.[] | select(.tag_name|test("^pr-evidence(-[0-9]+)?$")) | {tag: .tag_name, assets: [.assets[]? | {name, url: .browser_download_url}]}',
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function releaseCounts(releases) {
  return releases.map((release) => ({
    tag: release.tag,
    count: release.assets.length,
  }));
}

/** Asset name → {tag, url} across ALL pr-evidence releases, so an asset already uploaded to any release (primary or overflow) is reused in place rather than duplicated onto a newer one — the invariant that keeps existing evidence links stable. */
function assetIndex(releases) {
  const index = new Map();
  for (const release of releases) {
    for (const asset of release.assets) {
      if (!index.has(asset.name)) {
        index.set(asset.name, { tag: release.tag, url: asset.url });
      }
    }
  }
  return index;
}

function errText(err) {
  return String(err?.stderr ?? err?.stdout ?? err?.message ?? "");
}

// GitHub answers an over-cap release upload with HTTP 422 naming the asset
// count; the phrasing has drifted across API versions, so match the stable
// tokens rather than a full sentence. A name-collision 422 (a different message)
// deliberately does NOT match — that is a real surprise the author should see,
// not something to paper over by rolling to another release.
export function isReleaseFullError(text) {
  return (
    /HTTP 422/i.test(text) &&
    /file_count|number of (files|assets)|asset (count|limit)|too many (files|assets)|maximum.*(files|assets)/i.test(
      text,
    )
  );
}

/** Create the next overflow release, tolerating a concurrent lane that beat us to it (the created release is the desired end state either way). */
export function createOverflowReleaseIfAbsent(tag, run = gh) {
  const index = prEvidenceReleaseIndex(tag);
  const notes = `Overflow continuation of the '${PRIMARY_RELEASE_TAG}' evidence asset store. GitHub caps a release at ${MAX_ASSETS_PER_RELEASE} assets, so headless-agent evidence uploads (scripts/pr-evidence.mjs) roll into '${tag}' once '${prEvidenceTagForIndex(index - 1)}' fills. Files are named '<pr>-<artifact>'; embed the asset download URLs in the PR evidence rows. Never delete assets referenced by an open PR.`;
  try {
    run(
      [
        "release",
        "create",
        tag,
        "--title",
        `PR evidence assets ${index} (headless-agent attachments)`,
        "--notes",
        notes,
        "--prerelease",
      ],
      { stdio: ["ignore", "inherit", "pipe"] },
    );
    console.log(`  + created overflow release '${tag}'`);
  } catch (err) {
    if (
      !/already exists|already_exists|tag_name.*exist|Validation Failed/i.test(
        errText(err),
      )
    ) {
      throw err;
    }
  }
}

/**
 * Upload staged, correctly-named files to the pr-evidence family, rolling to the
 * next release when the chosen one is full — capacity is read up front, and a
 * 422 `file_count` failure (concurrent-fill race) triggers a rollover retry.
 * `stagedByName` is name → local path. Returns name → download URL on whichever
 * release accepted the batch. `run` is the `gh` invoker (injectable for tests).
 */
export function uploadAssets(stagedByName, releases, run = gh) {
  const names = [...stagedByName.keys()];
  const paths = names.map((name) => stagedByName.get(name));
  const counts = releaseCounts(releases);
  const full = new Set();
  const maxAttempts = releases.length + 4;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const visible = counts.map((entry) =>
      full.has(entry.tag) ? { ...entry, count: MAX_ASSETS_PER_RELEASE } : entry,
    );
    const { tag, create } = selectPrEvidenceTarget(visible, names.length);
    if (create) {
      createOverflowReleaseIfAbsent(tag, run);
      if (!counts.some((entry) => entry.tag === tag)) {
        counts.push({ tag, count: 0 });
      }
    }
    try {
      run(["release", "upload", tag, ...paths], {
        stdio: ["ignore", "inherit", "pipe"],
      });
      const base = releaseDownloadBase(tag);
      return new Map(names.map((name) => [name, `${base}/${name}`]));
    } catch (err) {
      if (isReleaseFullError(errText(err))) {
        console.log(
          `  release '${tag}' is full; rolling over to the next overflow release`,
        );
        full.add(tag);
        continue;
      }
      throw err;
    }
  }
  fail(
    "could not upload evidence assets: every candidate pr-evidence release is full",
  );
}

/**
 * Upload local files as `<pr>-<basename>`; returns name → URL. An asset already
 * present on ANY pr-evidence release is reused as-is (assets referenced by open
 * PRs are immutable by policy) and keeps its original release URL; only genuinely
 * new assets are uploaded, into the current release with capacity.
 */
export function attach(pr, files, run = gh) {
  if (files.length === 0) fail("attach needs at least one file");
  const releases = fetchPrEvidenceReleases(run);
  const index = assetIndex(releases);
  const urls = new Map();
  const stagedByName = new Map();
  const order = [];
  for (const file of files) {
    if (!existsSync(file)) fail(`no such file: ${file}`);
    // GitHub rejects zero-byte release assets with an opaque 400
    // (Bad Content-Length) that aborts the whole batch — fail per-file with
    // the actual reason instead. An empty artifact is never real evidence.
    if (readFileSync(file).length === 0) {
      fail(`refusing to upload empty file (0 bytes): ${file}`);
    }
    const name = `${pr}-${basename(file).replace(new RegExp(`^${pr}-`), "")}`;
    if (!order.includes(name)) order.push(name);
    const existing = index.get(name);
    if (existing) {
      urls.set(name, existing.url);
      console.log(`  = ${name} (already on '${existing.tag}', reusing)`);
      continue;
    }
    if (!stagedByName.has(name)) {
      // gh names the asset after the file, so stage a correctly-named copy.
      const stagedPath = join(tmpdir(), name);
      writeFileSync(stagedPath, readFileSync(file));
      stagedByName.set(name, stagedPath);
    }
  }
  if (stagedByName.size > 0) {
    const uploaded = uploadAssets(stagedByName, releases, run);
    for (const [name, url] of uploaded) urls.set(name, url);
  }
  for (const name of order) console.log(`  ${urls.get(name)}`);
  return urls;
}

function isMediaName(name) {
  return /\.(png|jpe?g|gif|webp|mp4|mov|webm)$/i.test(name);
}

/** Render the replacement row line for an id + resolved value. */
export function renderRow(id, value) {
  if (/^N\/?A\s*[-:]/i.test(value)) return `- [ ] ${value}`;
  if (isMediaName(value) && /^https?:/i.test(value)) {
    // Embed images inline; videos/GIFs render from the bare URL on GitHub.
    return /\.(png|jpe?g|gif|webp)$/i.test(value)
      ? `- [x] ![${id}](${value})`
      : `- [x] ${value}`;
  }
  if (/^https?:/i.test(value)) return `- [x] [${basename(value)}](${value})`;
  fail(
    `row ${id}: value must be a file, URL, or 'N/A - <reason>' (got: ${value})`,
  );
}

/** Replace the block after `<!-- evidence-row:<id> -->` with `line`. */
export function patchRow(body, id, line) {
  const marker = `<!-- evidence-row:${id} -->`;
  const at = body.indexOf(marker);
  if (at === -1) {
    // Row marker absent (old template) — append a fresh marker + row.
    return `${body.trimEnd()}\n\n${marker}\n${line}\n`;
  }
  const afterMarker = at + marker.length;
  const rest = body.slice(afterMarker);
  // The row block ends at the next blank line, heading, or marker.
  const end = rest.search(/\n\s*\n|\n#|\n<!-- evidence-row:/);
  const blockEnd = end === -1 ? rest.length : end;
  return (
    body.slice(0, afterMarker) +
    "\n" +
    line +
    body.slice(afterMarker + blockEnd)
  );
}

async function runGate(pr, body) {
  const { evaluatePrEvidence } = await import(
    pathToFileURL(join(import.meta.dirname, "check-pr-evidence.mjs")).href
  );
  const labels = gh([
    "pr",
    "view",
    String(pr),
    "--json",
    "labels",
    "-q",
    '[.labels[].name]|join(",")',
  ]).trim();
  // `gh pr diff` 406s past GitHub's 300-file diff cap (hit live on the 350-file
  // #15291); the paginated files API has no such limit.
  const changedFiles = gh([
    "api",
    `repos/{owner}/{repo}/pulls/${pr}/files`,
    "--paginate",
    "-q",
    ".[].filename",
  ])
    .split("\n")
    .filter(Boolean);
  const addedFiles = gh([
    "api",
    `repos/{owner}/{repo}/pulls/${pr}/files`,
    "--paginate",
    "-q",
    '.[] | select(.status=="added") | .filename',
  ])
    .split("\n")
    .filter(Boolean);
  const { ok, findings } = evaluatePrEvidence(body, undefined, {
    labels,
    changedFiles,
    addedFiles,
  });
  for (const f of findings) {
    console.log(
      `  [${f.status === "ok" ? "ok  " : "FAIL"}] ${f.id}: ${f.status}`,
    );
  }
  return ok;
}

async function rows(pr, args) {
  const dryRun = args.includes("--dry-run");
  const rowArgs = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--row") {
      const spec = args[i + 1] ?? "";
      const eq = spec.indexOf("=");
      if (eq === -1) fail(`--row needs <id>=<value>, got: ${spec}`);
      const id = spec.slice(0, eq);
      if (!ROW_IDS.includes(id))
        fail(`unknown row id '${id}' (valid: ${ROW_IDS.join(", ")})`);
      rowArgs.push({ id, value: spec.slice(eq + 1) });
      i += 1;
    }
  }
  if (rowArgs.length === 0) fail("rows needs at least one --row <id>=<value>");

  // Resolve local files to uploaded asset URLs first.
  const localFiles = rowArgs.filter(
    (r) => !/^https?:/i.test(r.value) && !/^N\/?A\s*[-:]/i.test(r.value),
  );
  if (localFiles.length > 0) {
    console.log(
      `Uploading ${localFiles.length} local file(s) to '${PRIMARY_RELEASE_TAG}':`,
    );
    const urls = attach(
      pr,
      localFiles.map((r) => r.value),
    );
    for (const r of localFiles) {
      const name = `${pr}-${basename(r.value).replace(new RegExp(`^${pr}-`), "")}`;
      r.value = urls.get(name);
    }
  }

  let body = gh(["pr", "view", String(pr), "--json", "body", "-q", ".body"]);
  for (const { id, value } of rowArgs) {
    body = patchRow(body, id, renderRow(id, value));
  }

  console.log("\nLocal gate verdict on the new body:");
  const ok = await runGate(pr, body);
  if (dryRun) {
    console.log(
      `\n--dry-run: PR #${pr} not edited. Gate ${ok ? "would PASS" : "would FAIL"}.`,
    );
    return;
  }
  const bodyFile = join(tmpdir(), `pr-${pr}-body.md`);
  writeFileSync(bodyFile, body);
  gh(["pr", "edit", String(pr), "--body-file", bodyFile], { stdio: "inherit" });
  console.log(
    `\nPR #${pr} updated. Gate ${ok ? "PASSES" : "still FAILS — fix the rows above"}.`,
  );
  if (!ok) process.exit(1);
}

async function verify(pr) {
  const body = gh(["pr", "view", String(pr), "--json", "body", "-q", ".body"]);
  const ok = await runGate(pr, body);
  console.log(ok ? "\nEvidence gate PASSES." : "\nEvidence gate FAILS.");
  if (!ok) process.exit(1);
}

async function main() {
  const [cmd, prArg, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    usage();
    return;
  }
  const pr = Number(prArg);
  if (!Number.isInteger(pr) || pr <= 0) fail(`invalid PR number: ${prArg}`);
  if (cmd === "attach") attach(pr, rest);
  else if (cmd === "rows") await rows(pr, rest);
  else if (cmd === "verify") await verify(pr);
  else fail(`unknown command: ${cmd}`);
}

// Only run the CLI when invoked directly; importing (e.g. from the test) must
// not execute `main` with no argv.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
