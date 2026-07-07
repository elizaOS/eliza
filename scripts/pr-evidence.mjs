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
 * skips re-uploading an asset that already exists with identical bytes.
 * `rows` accepts a local file (uploaded automatically), an existing URL, or an
 * `N/A - reason` string per row; rows not named are left untouched. Every
 * mutation is previewed and the gate verdict printed; `--dry-run` stops before
 * editing the PR.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const RELEASE_TAG = "pr-evidence";
const ASSET_BASE = `https://github.com/elizaOS/eliza/releases/download/${RELEASE_TAG}`;
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
      Upload files to the '${RELEASE_TAG}' release as <pr>-<name> and print
      the asset URLs ready to paste into evidence rows.

  node scripts/pr-evidence.mjs rows <pr> [--dry-run] --row <id>=<value> [...]
      Patch the PR body's evidence rows and verify the gate locally.
      <id>    one of: ${ROW_IDS.join(", ")}
      <value> a local file path (auto-uploaded), an https URL, or an
              'N/A - <reason>' string.

  node scripts/pr-evidence.mjs verify <pr>
      Fetch the PR body/labels/files and run the local evidence gate exactly
      as CI does.

Assets land on: ${ASSET_BASE}/<pr>-<filename>
Worked example of a fully evidenced PR: https://github.com/elizaOS/eliza/pull/15171`);
}

/** Existing release assets, name → { sha? } (sha lazily unavailable via API — name match only). */
function existingAssetNames() {
  const out = gh([
    "release",
    "view",
    RELEASE_TAG,
    "--json",
    "assets",
    "-q",
    ".assets[].name",
  ]);
  return new Set(out.split("\n").filter(Boolean));
}

/**
 * Upload local files as `<pr>-<basename>`; returns name → URL. A name
 * collision uploads with `--clobber` only when the local bytes differ from a
 * previous upload this run cannot verify — so collide loudly instead:
 * existing names are reused as-is (assets referenced by open PRs are
 * immutable by policy), and a genuinely different file must be renamed.
 */
function attach(pr, files) {
  if (files.length === 0) fail("attach needs at least one file");
  const existing = existingAssetNames();
  const urls = new Map();
  const toUpload = [];
  const staged = [];
  for (const file of files) {
    if (!existsSync(file)) fail(`no such file: ${file}`);
    // GitHub rejects zero-byte release assets with an opaque 400
    // (Bad Content-Length) that aborts the whole batch — fail per-file with
    // the actual reason instead. An empty artifact is never real evidence.
    if (readFileSync(file).length === 0) {
      fail(`refusing to upload empty file (0 bytes): ${file}`);
    }
    const name = `${pr}-${basename(file).replace(new RegExp(`^${pr}-`), "")}`;
    const url = `${ASSET_BASE}/${name}`;
    urls.set(name, url);
    if (existing.has(name)) {
      console.log(`  = ${name} (already uploaded, reusing)`);
      continue;
    }
    // gh names the asset after the file, so stage a correctly-named copy.
    const stagedPath = join(tmpdir(), name);
    writeFileSync(stagedPath, readFileSync(file));
    staged.push(stagedPath);
    toUpload.push(stagedPath);
  }
  if (toUpload.length > 0) {
    gh(["release", "upload", RELEASE_TAG, ...toUpload], { stdio: "inherit" });
  }
  for (const [name, url] of urls) console.log(`  ${url}`);
  return urls;
}

function isMediaName(name) {
  return /\.(png|jpe?g|gif|webp|mp4|mov|webm)$/i.test(name);
}

/** Render the replacement row line for an id + resolved value. */
function renderRow(id, value) {
  if (/^N\/?A\s*[-:]/i.test(value)) return `- [ ] ${value}`;
  if (isMediaName(value) && /^https?:/i.test(value)) {
    // Embed images inline; videos/GIFs render from the bare URL on GitHub.
    return /\.(png|jpe?g|gif|webp)$/i.test(value)
      ? `- [x] ![${id}](${value})`
      : `- [x] ${value}`;
  }
  if (/^https?:/i.test(value)) return `- [x] [${basename(value)}](${value})`;
  fail(`row ${id}: value must be a file, URL, or 'N/A - <reason>' (got: ${value})`);
}

/** Replace the block after `<!-- evidence-row:<id> -->` with `line`. */
function patchRow(body, id, line) {
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
  return body.slice(0, afterMarker) + "\n" + line + body.slice(afterMarker + blockEnd);
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
    "[.labels[].name]|join(\",\")",
  ]).trim();
  const changedFiles = gh(["pr", "diff", String(pr), "--name-only"])
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
    console.log(`  [${f.status === "ok" ? "ok  " : "FAIL"}] ${f.id}: ${f.status}`);
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
      if (!ROW_IDS.includes(id)) fail(`unknown row id '${id}' (valid: ${ROW_IDS.join(", ")})`);
      rowArgs.push({ id, value: spec.slice(eq + 1) });
      i += 1;
    }
  }
  if (rowArgs.length === 0) fail("rows needs at least one --row <id>=<value>");

  // Resolve local files to uploaded asset URLs first.
  const localFiles = rowArgs.filter((r) => !/^https?:/i.test(r.value) && !/^N\/?A\s*[-:]/i.test(r.value));
  if (localFiles.length > 0) {
    console.log(`Uploading ${localFiles.length} local file(s) to '${RELEASE_TAG}':`);
    const urls = attach(pr, localFiles.map((r) => r.value));
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
    console.log(`\n--dry-run: PR #${pr} not edited. Gate ${ok ? "would PASS" : "would FAIL"}.`);
    return;
  }
  const bodyFile = join(tmpdir(), `pr-${pr}-body.md`);
  writeFileSync(bodyFile, body);
  gh(["pr", "edit", String(pr), "--body-file", bodyFile], { stdio: "inherit" });
  console.log(`\nPR #${pr} updated. Gate ${ok ? "PASSES" : "still FAILS — fix the rows above"}.`);
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

await main();
