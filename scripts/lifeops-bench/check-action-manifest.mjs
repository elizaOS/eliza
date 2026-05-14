#!/usr/bin/env node
/**
 * check-action-manifest — Manifest CI gate
 *
 * Saves the committed `packages/benchmarks/lifeops-bench/manifests/actions.manifest.json`
 * to a temp file, regenerates it from source by running:
 *   1. `bun run scripts/lifeops-bench/export-action-manifest.ts`
 *   2. `python -m eliza_lifeops_bench.manifest_export` (from the bench package dir)
 *
 * Then diffs the regenerated file against the committed copy.
 *
 * Always restores the committed file from temp before exiting so the working
 * tree is never left mutated, regardless of whether the diff passed or failed.
 *
 * Exit codes:
 *   0 — manifest is up to date
 *   1 — drift detected (or a regen step failed)
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  readFileSync,
  unlinkSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BENCH_DIR = path.join(REPO_ROOT, "packages/benchmarks/lifeops-bench");
const MANIFEST_PATH = path.join(BENCH_DIR, "manifests/actions.manifest.json");
const EXPORT_SCRIPT = path.join(
  REPO_ROOT,
  "scripts/lifeops-bench/export-action-manifest.ts",
);

function fail(msg) {
  process.stderr.write(`[check-action-manifest] ${msg}\n`);
}

function info(msg) {
  process.stdout.write(`[check-action-manifest] ${msg}\n`);
}

function run(cmd, args, opts = {}) {
  info(`$ ${cmd} ${args.join(" ")}${opts.cwd ? `  (cwd=${opts.cwd})` : ""}`);
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    shell: process.platform === "win32",
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.status ?? 1;
}

function unifiedDiff(originalText, regeneratedText, originalLabel, regeneratedLabel) {
  // Lightweight line-by-line diff. Avoids a `diff` binary dependency since
  // GitHub Windows runners may not have it. The output is sufficient to
  // identify drift in CI logs.
  const a = originalText.split(/\r?\n/);
  const b = regeneratedText.split(/\r?\n/);
  const out = [
    `--- ${originalLabel} (committed)`,
    `+++ ${regeneratedLabel} (regenerated)`,
  ];
  const max = Math.max(a.length, b.length);
  let drift = 0;
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) {
      drift++;
      if (a[i] !== undefined) out.push(`-${i + 1}: ${a[i]}`);
      if (b[i] !== undefined) out.push(`+${i + 1}: ${b[i]}`);
    }
  }
  return { text: out.join("\n"), drift };
}

async function main() {
  if (!existsSync(MANIFEST_PATH)) {
    fail(`manifest file not found at ${MANIFEST_PATH}`);
    process.exit(1);
  }
  if (!existsSync(EXPORT_SCRIPT)) {
    fail(`export script not found at ${EXPORT_SCRIPT}`);
    process.exit(1);
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), "lifeops-manifest-"));
  const tmpCopy = path.join(tmpDir, "actions.manifest.original.json");
  copyFileSync(MANIFEST_PATH, tmpCopy);
  info(`saved original manifest to ${tmpCopy}`);

  let exitCode = 0;
  try {
    // Step 1 — TS exporter (writes manifest in place).
    const exportStatus = run("bun", ["run", EXPORT_SCRIPT]);
    if (exportStatus !== 0) {
      fail(`export-action-manifest.ts exited with code ${exportStatus}`);
      exitCode = 1;
      return;
    }

    // Step 2 — Python umbrella augment (patches the same file in place).
    const pythonBin =
      process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    const augmentStatus = run(pythonBin, ["-m", "eliza_lifeops_bench.manifest_export"], {
      cwd: BENCH_DIR,
    });
    if (augmentStatus !== 0) {
      fail(`manifest_export.py exited with code ${augmentStatus}`);
      exitCode = 1;
      return;
    }

    // Step 3 — diff regenerated against the committed copy.
    const original = readFileSync(tmpCopy, "utf-8");
    const regenerated = readFileSync(MANIFEST_PATH, "utf-8");
    if (original === regenerated) {
      info("manifest is up to date — no drift detected.");
      exitCode = 0;
      return;
    }

    const { text, drift } = unifiedDiff(
      original,
      regenerated,
      "actions.manifest.json",
      "actions.manifest.json",
    );
    fail(`manifest drift detected (${drift} differing lines).`);
    fail(
      "Run `bun run check-actions-manifest` locally and commit the regenerated manifest.",
    );
    fail("Diff (first 50 lines shown):");
    const head = text.split("\n").slice(0, 52).join("\n");
    process.stderr.write(`${head}\n`);
    exitCode = 1;
  } finally {
    // Always restore the committed manifest so the working tree is unmodified.
    try {
      copyFileSync(tmpCopy, MANIFEST_PATH);
      info(`restored original manifest from ${tmpCopy}`);
    } catch (err) {
      fail(
        `failed to restore manifest from temp: ${err instanceof Error ? err.message : String(err)}`,
      );
      exitCode = exitCode || 1;
    }
    try {
      unlinkSync(tmpCopy);
    } catch {
      // best-effort cleanup
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  fail(
    `unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
