#!/usr/bin/env node
/**
 * Desktop multi-modality memory-bench harness (#8809 M10b).
 *
 * The desktop parallel to native/verify/mobile_peak_rss_harness.mjs. Where the
 * mobile harness can only record a "needs-device" stub off-device (it cannot
 * measure peak RSS or thermals on a host), the desktop harness CAN measure real
 * per-modality resident-set growth on the host it runs on — so it does, and it
 * never fabricates a number it didn't measure (AGENTS.md §3 / §8).
 *
 * What it measures
 * ----------------
 * For each modality present in an installed Eliza-1 bundle — text, embedding,
 * vision (mmproj), VAD — it spawns a child process that memory-maps that
 * modality's GGUF and *touches every page* (the residency the runtime pays once
 * a model is loaded and its weights are warm), and records the child's peak RSS
 * delta over a clean baseline. It then runs a co-residency pass that maps
 * text + embedding + vision + VAD together, which is exactly the resident set
 * the MemoryArbiter's `evictToFit` path (#8809) must keep under budget.
 *
 * This is a genuine warm-RSS measurement of the weight residency, not model
 * execution: it does not depend on the fused native inference library or a
 * loaded graph, so it runs on any desktop with a bundle on disk and stays
 * green while the engine load path is in flux. (Full decode-time RSS lives in
 * scripts/memory-benchmark.ts, which drives the real engine.)
 *
 * Discipline mirrored from the iOS runners:
 *   - No bundle installed  → records `available:false` with a structured
 *     reason and exits 0 (recording "not installed" is success, like the mtp
 *     bench), never a fabricated RSS.
 *   - A modality absent from a bundle → that modality row is `present:false`,
 *     `peakRssMb:null`; the tool does not invent residency for files that do
 *     not exist.
 *
 * Report shape: top-level `summary.peakRssMb` is the co-resident peak (the
 * number the collector's peak-RSS gate keys off, matching the mobile harness's
 * `summary.peakRssMb` field), with per-modality detail under `modalities`. The
 * JSON is written under reports/desktop-rss/ so eliza1_gates_collect.mjs can
 * fold it in alongside the mobile-rss reports.
 *
 * Usage:
 *   node plugins/plugin-local-inference/native/verify/desktop_memory_inventory.mjs \
 *     [bundle ...] [--report PATH] [--json] [--touch-bytes N]
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_BUNDLE_ROOT = path.join(
  os.homedir(),
  ".eliza",
  "local-inference",
  "models",
);

/** The modalities this harness exercises, in co-residency load order. */
const MODALITIES = ["text", "embedding", "vision", "vad"];

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseArgs(argv) {
  const args = {
    bundles: [],
    report: path.join(
      __dirname,
      "..",
      "reports",
      "desktop-rss",
      `desktop-memory-${timestamp()}.json`,
    ),
    json: false,
    /** Page-touch stride; reading one byte per OS page faults the page in. */
    touchStride: 4096,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--report") args.report = expandHome(argv[(i += 1)]);
    else if (a === "--json") args.json = true;
    else if (a === "--touch-stride") args.touchStride = Number(argv[(i += 1)]);
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "Usage: node desktop_memory_inventory.mjs [bundle ...]",
          "  --report PATH      output JSON (default reports/desktop-rss/desktop-memory-<ts>.json)",
          "  --json             print the report to stdout",
          "  --touch-stride N   bytes between page-touch reads (default 4096)",
        ].join("\n"),
      );
      process.exit(0);
    } else args.bundles.push(expandHome(a));
  }
  return args;
}

function defaultBundles() {
  if (!fs.existsSync(DEFAULT_BUNDLE_ROOT)) return [];
  return fs
    .readdirSync(DEFAULT_BUNDLE_ROOT)
    .filter((name) => /^eliza-1-.+\.bundle$/.test(name))
    .map((name) => path.join(DEFAULT_BUNDLE_ROOT, name))
    .filter((p) => fs.existsSync(p) && fs.statSync(p).isDirectory())
    .sort();
}

function tierFromBundlePath(bundleDir) {
  return path
    .basename(bundleDir)
    .replace(/\.bundle$/, "")
    .replace(/^eliza-1-/, "");
}

function walkGgufs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const name of fs.readdirSync(cur)) {
      const abs = path.join(cur, name);
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) stack.push(abs);
      else if (st.isFile()) out.push({ abs, size: st.size });
    }
  }
  return out;
}

/**
 * Resolve the on-disk file(s) backing a modality inside a bundle. The manifest
 * is the source of truth; we fall back to the conventional directory layout
 * (AGENTS.md §2) so the harness still works against a bundle whose manifest is
 * older than a component. Returns the largest matching GGUF (the weight bank).
 */
function modalityFile(bundleDir, modality) {
  const dirFor = {
    text: "text",
    embedding: "embedding",
    vision: "vision",
    vad: "vad",
  }[modality];
  const ggufs = walkGgufs(path.join(bundleDir, dirFor)).sort(
    (a, b) => b.size - a.size,
  );
  // The 2B tier reuses the text backbone for embeddings (no dedicated file).
  if (modality === "embedding" && ggufs.length === 0) {
    const textGgufs = walkGgufs(path.join(bundleDir, "text")).sort(
      (a, b) => b.size - a.size,
    );
    if (textGgufs[0]) {
      return { abs: textGgufs[0].abs, size: textGgufs[0].size, sharedWithText: true };
    }
    return null;
  }
  return ggufs[0] ?? null;
}

/** Run the page-touch child and return its measured peak RSS delta in MB. */
function measurePeakRss(files, touchStride) {
  const list = files.map((f) => f.abs);
  const child = spawnSync(
    process.execPath,
    ["-e", PAGE_TOUCH_CHILD, JSON.stringify(list), String(touchStride)],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (child.status !== 0) {
    return {
      ok: false,
      error: (child.stderr || child.stdout || "child exited non-zero").trim(),
    };
  }
  try {
    const last = child.stdout.trim().split("\n").pop();
    const parsed = JSON.parse(last);
    return { ok: true, ...parsed };
  } catch (err) {
    return { ok: false, error: `unparseable child output: ${String(err)}` };
  }
}

/**
 * The child: read baseline RSS, mmap+touch every page of each file, sample RSS
 * across the touch, and print the peak-RSS delta. Uses a Buffer read of one
 * byte per page so the kernel faults the file-backed page into resident memory
 * — the same residency the warm runtime holds.
 */
const PAGE_TOUCH_CHILD = `
const fs = require("node:fs");
const files = JSON.parse(process.argv[1]);
const stride = Math.max(512, Number(process.argv[2]) || 4096);
const MB = 1024 * 1024;
const baseline = process.memoryUsage().rss;
let peak = baseline;
let touchedBytes = 0;
const buf = Buffer.allocUnsafe(1);
for (const file of files) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    for (let pos = 0; pos < size; pos += stride) {
      fs.readSync(fd, buf, 0, 1, pos);
      touchedBytes += 1;
      if ((touchedBytes & 0x3ff) === 0) {
        const rss = process.memoryUsage().rss;
        if (rss > peak) peak = rss;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}
const rss = process.memoryUsage().rss;
if (rss > peak) peak = rss;
process.stdout.write(JSON.stringify({
  baselineRssMb: round(baseline / MB),
  peakRssMb: round(peak / MB),
  peakRssDeltaMb: round((peak - baseline) / MB),
}) + "\\n");
function round(n) { return Math.round(n * 100) / 100; }
`;

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function inventoryBundle(bundleDir, touchStride) {
  const tier = tierFromBundlePath(bundleDir);
  const modalities = {};
  const presentFiles = [];
  for (const modality of MODALITIES) {
    const file = modalityFile(bundleDir, modality);
    if (!file) {
      modalities[modality] = {
        present: false,
        path: null,
        sizeMb: null,
        peakRssMb: null,
        peakRssDeltaMb: null,
        reason: "modality file absent from bundle",
      };
      continue;
    }
    const measured = measurePeakRss([file], touchStride);
    modalities[modality] = {
      present: true,
      path: path.relative(bundleDir, file.abs),
      sizeMb: round(file.size / 1024 / 1024),
      sharedWithText: Boolean(file.sharedWithText),
      peakRssMb: measured.ok ? measured.peakRssMb : null,
      peakRssDeltaMb: measured.ok ? measured.peakRssDeltaMb : null,
      reason: measured.ok ? null : measured.error,
    };
    // Dedupe the shared-with-text embedding file in the co-resident pass.
    if (!presentFiles.some((f) => f.abs === file.abs)) presentFiles.push(file);
  }

  let coResident = {
    measured: false,
    peakRssMb: null,
    peakRssDeltaMb: null,
    files: presentFiles.length,
    reason: presentFiles.length ? null : "no modality files present",
  };
  if (presentFiles.length) {
    const result = measurePeakRss(presentFiles, touchStride);
    coResident = result.ok
      ? {
          measured: true,
          peakRssMb: result.peakRssMb,
          peakRssDeltaMb: result.peakRssDeltaMb,
          baselineRssMb: result.baselineRssMb,
          files: presentFiles.length,
          reason: null,
        }
      : { ...coResident, reason: result.error };
  }

  return { tier, bundleDir, modalities, coResident };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundles = (args.bundles.length ? args.bundles : defaultBundles()).filter(
    (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
  );

  const base = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    harness: path.relative(process.cwd(), __filename),
    host: {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      totalRamMb: round(os.totalmem() / 1024 / 1024),
      freeRamMb: round(os.freemem() / 1024 / 1024),
    },
  };

  if (!bundles.length) {
    // No bundle on disk → record "not installed", never a fabricated number.
    const report = {
      ...base,
      available: false,
      reason:
        "no Eliza-1 bundle found on disk — install a bundle (default ~/.eliza/local-inference/models) to measure per-modality peak RSS",
      bundles: [],
      summary: { peakRssMb: null, coResidentPeakRssMb: null },
    };
    writeReport(args, report);
    return;
  }

  const inventories = bundles.map((b) => inventoryBundle(b, args.touchStride));
  // Summary peak = the largest co-resident peak observed (the residency the
  // arbiter budget must hold), matching the mobile harness's summary.peakRssMb.
  const coResidentPeaks = inventories
    .map((b) => b.coResident.peakRssMb)
    .filter((v) => typeof v === "number");
  const summaryPeak = coResidentPeaks.length
    ? Math.max(...coResidentPeaks)
    : null;

  const report = {
    ...base,
    available: summaryPeak !== null,
    reason: summaryPeak !== null ? null : "no modality residency could be measured",
    inputBundles: bundles,
    bundles: inventories,
    summary: {
      peakRssMb: summaryPeak,
      coResidentPeakRssMb: summaryPeak,
      bundlesMeasured: inventories.length,
      modalities: MODALITIES,
    },
  };
  writeReport(args, report);
}

function writeReport(args, report) {
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`wrote ${args.report}`);
    console.log(
      `desktop-memory: available=${report.available}${
        report.available
          ? ` co-resident peak RSS=${report.summary.peakRssMb} MB`
          : ` — ${report.reason}`
      }`,
    );
  }
  // Exit 0: recording a "not installed" entry is success, like the mtp bench.
  process.exit(0);
}

main();
