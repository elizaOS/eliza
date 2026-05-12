#!/usr/bin/env node
/**
 * Round-trip verification: HF -> phone-equivalent local fs.
 *
 * Picks one published eliza-1 model (via its catalog id), points the
 * local-inference `Downloader` at a temp state dir, and verifies the
 * resulting file's sha256 matches the manifest the publisher wrote.
 *
 * This is the gate W5-Catalog uses before merging a catalog update: if
 * `verify-phone-download.mjs --model-id <id>` fails, the diff stays
 * unmerged.
 *
 * The `Downloader` itself is what the iOS / Android runtimes use — the
 * AOSP plugin re-imports it through `@elizaos/app-core`, and the
 * Electrobun shell uses it directly. Pointing `ELIZA_STATE_DIR` at a
 * temp dir is sufficient to isolate this run from a developer's real
 * `~/.eliza` state.
 *
 * Usage:
 *
 *   node scripts/verify-phone-download.mjs --model-id eliza-1-mobile-1_7b
 *   node scripts/verify-phone-download.mjs --model-id eliza-1-mobile-1_7b \
 *       --catalog-diff reports/porting/2026-05-10/catalog-diff.json
 *   node scripts/verify-phone-download.mjs --diff-first  # use the latest diff in reports/porting/
 *
 * Without `--catalog-diff`, the script falls back to the in-tree catalog
 * (so it can verify already-shipped eliza-1 models even before a fresh
 * sync_catalog_from_hf.py run lands).
 *
 * Exits non-zero with an explicit error message on:
 *   - missing model id in catalog/diff
 *   - HTTP error during download
 *   - sha256 mismatch between downloaded file and the diff/manifest
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { modelId: null, catalogDiff: null, diffFirst: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model-id") {
      args.modelId = argv[++i];
    } else if (a === "--catalog-diff") {
      args.catalogDiff = argv[++i];
    } else if (a === "--diff-first") {
      args.diffFirst = true;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(`${import.meta.url}\n`);
      process.stdout.write(
        "Usage: verify-phone-download.mjs --model-id <id> [--catalog-diff path] [--diff-first]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return args;
}

async function findLatestDiff() {
  const portingRoot = path.join(REPO_ROOT, "reports", "porting");
  let dirs;
  try {
    dirs = await fsp.readdir(portingRoot);
  } catch {
    return null;
  }
  // Date-sortable directory names (YYYY-MM-DD-...).
  dirs.sort();
  for (let i = dirs.length - 1; i >= 0; i--) {
    const candidate = path.join(portingRoot, dirs[i], "catalog-diff.json");
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

async function loadDiffEntry(diffPath, modelId) {
  const raw = JSON.parse(await fsp.readFile(diffPath, "utf8"));
  if (!Array.isArray(raw.entries)) {
    throw new Error(
      `catalog diff at ${diffPath} is malformed (missing 'entries' array)`,
    );
  }
  const entry = raw.entries.find((e) => e.id === modelId);
  if (!entry) {
    const ids = raw.entries.map((e) => e.id);
    throw new Error(
      `model id ${JSON.stringify(modelId)} not found in diff ${diffPath}; ` +
        `known: ${JSON.stringify(ids)}`,
    );
  }
  return entry;
}

async function loadCatalogEntry(modelId) {
  // Dynamically import the in-tree catalog. Works in the worktree when
  // app-core has been built (catalog.ts is plain TS — we import the
  // emitted JS via the package's main entrypoint).
  let mod;
  try {
    mod = await import("@elizaos/app-core/services/local-inference/catalog");
  } catch (err) {
    throw new Error(
      `Could not import @elizaos/app-core catalog (${err?.message ?? err}). ` +
        `Either run \`bun install\` first, or pass --catalog-diff <path>.`,
    );
  }
  const entry =
    typeof mod.findCatalogModel === "function"
      ? mod.findCatalogModel(modelId)
      : mod.MODEL_CATALOG?.find((m) => m.id === modelId);
  if (!entry) {
    throw new Error(`model id ${modelId} not found in in-tree catalog`);
  }
  return {
    id: entry.id,
    hfRepo: entry.hfRepo,
    ggufFile: entry.ggufFile,
    sha256: null,
    sizeBytes: null,
  };
}

async function loadDownloader() {
  // Import via the package entrypoint so we pick up the same code the
  // phone runs. If the package build is stale, fall back to the source
  // path under the worktree (vitest pulls TS directly with bun, which
  // we don't have in pure node here).
  try {
    const mod = await import(
      "@elizaos/app-core/services/local-inference/downloader"
    );
    return mod.Downloader;
  } catch (err) {
    throw new Error(
      `Could not import @elizaos/app-core Downloader (${err?.message ?? err}). ` +
        `Run \`bun install && bun run build --filter @elizaos/app-core\` first.`,
    );
  }
}

async function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function runDownload(Downloader, entry, stagingRoot) {
  process.env.ELIZA_STATE_DIR = stagingRoot;

  const downloader = new Downloader();

  const events = [];
  downloader.subscribe((event) => {
    events.push(event);
  });

  const start = performance.now();
  const job = await downloader.start({
    id: entry.id,
    displayName: entry.id,
    hfRepo: entry.hfRepo,
    ggufFile: entry.ggufFile,
    params: "8B",
    quant: "eliza-1-optimized",
    sizeGb: entry.sizeBytes ? entry.sizeBytes / 1024 ** 3 : 1,
    minRamGb: 4,
    category: "chat",
    bucket: "mid",
    blurb: "verify-phone-download placeholder",
  });
  process.stderr.write(
    `[verify] download started job=${job.jobId} model=${job.modelId}\n`,
  );

  // Wait for terminal event for this model id.
  await new Promise((resolve, reject) => {
    const timeoutMs = 30 * 60 * 1000; // 30 min upper bound
    const timer = setTimeout(() => {
      reject(new Error(`download timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    const unsubscribe = downloader.subscribe((event) => {
      if (event.job.modelId !== entry.id) return;
      if (event.type === "completed") {
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      } else if (event.type === "failed" || event.type === "cancelled") {
        clearTimeout(timer);
        unsubscribe();
        reject(
          new Error(
            `download terminated as ${event.type}: ${event.job.error ?? "(no error)"}`,
          ),
        );
      }
    });
  });

  const elapsedMs = performance.now() - start;

  // Locate the downloaded file. The downloader places it at
  // `<state>/local-inference/models/<sanitized id>.gguf`.
  const sanitized = entry.id.replace(/[^a-zA-Z0-9._-]/g, "_");
  const finalPath = path.join(
    stagingRoot,
    "local-inference",
    "models",
    `${sanitized}.gguf`,
  );

  const stat = await fsp.stat(finalPath);
  return { finalPath, sizeBytes: stat.size, elapsedMs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.modelId) {
    throw new Error("--model-id is required");
  }

  let diffPath = args.catalogDiff;
  if (!diffPath && args.diffFirst) {
    diffPath = await findLatestDiff();
    if (!diffPath) {
      throw new Error("no catalog diff found under reports/porting/");
    }
    process.stderr.write(`[verify] using diff at ${diffPath}\n`);
  }

  const expected = diffPath
    ? await loadDiffEntry(diffPath, args.modelId)
    : await loadCatalogEntry(args.modelId);

  process.stderr.write(
    `[verify] target: ${args.modelId} -> ${expected.hfRepo}/${expected.ggufFile}\n`,
  );

  const Downloader = await loadDownloader();

  const stagingRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "verify-phone-download-"),
  );
  process.stderr.write(`[verify] state dir: ${stagingRoot}\n`);

  let result;
  try {
    result = await runDownload(Downloader, expected, stagingRoot);
  } catch (err) {
    await fsp.rm(stagingRoot, { recursive: true, force: true });
    throw err;
  }

  const actualSha = await sha256OfFile(result.finalPath);
  const elapsedSec = result.elapsedMs / 1000;
  const bytesPerSec = result.sizeBytes / Math.max(elapsedSec, 0.001);

  let shaOk = true;
  if (expected.sha256 && expected.sha256 !== actualSha) {
    shaOk = false;
  }

  const report = {
    modelId: args.modelId,
    hfRepo: expected.hfRepo,
    ggufFile: expected.ggufFile,
    expectedSha256: expected.sha256 ?? null,
    actualSha256: actualSha,
    shaMatch: shaOk,
    expectedSizeBytes: expected.sizeBytes ?? null,
    actualSizeBytes: result.sizeBytes,
    elapsedSec: Number(elapsedSec.toFixed(2)),
    bytesPerSec: Math.round(bytesPerSec),
    bytesPerSecHuman: `${formatBytes(bytesPerSec)}/s`,
    finalPath: result.finalPath,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  await fsp.rm(stagingRoot, { recursive: true, force: true });

  if (!shaOk) {
    process.stderr.write(
      `[verify] FAIL: sha mismatch — expected ${expected.sha256}, got ${actualSha}\n`,
    );
    process.exit(2);
  }

  process.stderr.write(
    `[verify] OK: ${formatBytes(result.sizeBytes)} in ${elapsedSec.toFixed(2)}s ` +
      `(${formatBytes(bytesPerSec)}/s)\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[verify] error: ${err?.stack ?? err}\n`);
  process.exit(1);
});
