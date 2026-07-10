/**
 * CLI that renders the static e2e run viewer for one artifact run:
 * `node scripts/e2e-viewer/generate.mjs [--run <id>] [--open] [--force]`.
 * Reads the run through the shared contract (default: latest run under the
 * artifacts root), derives the index with `buildRunIndex`, and writes
 * `viewer/index.html` + `viewer/data.js` + `viewer/replay.js` INTO the run
 * directory. Artifacts are never copied — the page references them by
 * relative href back into `tests/<id>/`.
 *
 * Because the page is opened from `file://` (no fetch/XHR allowed), textual
 * artifacts — logs, JSONL, trajectories, PostHog snapshots, OCR, reports —
 * are parsed here and inlined into `data.js` when under 256 KB; larger files
 * stay link-only. `replay.js` is an esbuild IIFE bundle of rrweb-player
 * (exposes `window.rrwebPlayer`) built from node_modules and cached across
 * regenerations unless `--force`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRunIndex, latestRunId, readTestManifest, runDir } from "../e2e-artifacts/contract.mjs";
import { buildViewerHtml } from "./template.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const require = createRequire(import.meta.url);

const INLINE_LIMIT_BYTES = 256 * 1024;
// Kinds whose content the viewer renders inline (everything textual the UI
// has a dedicated pane for). Binary kinds (video, screenshots, traces) are
// always referenced by href.
const INLINE_KINDS = new Set([
  "console-log",
  "network-log",
  "server-log",
  "trajectory",
  "posthog-events",
  "posthog-snapshots",
  "ocr",
  "report",
  "ai-review",
]);

function parseArgs(argv) {
  const args = { run: null, open: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--run") {
      args.run = argv[++i];
      if (!args.run) throw new Error("--run requires a run id");
    } else if (arg === "--open") {
      args.open = true;
    } else if (arg === "--force") {
      args.force = true;
    } else {
      throw new Error(`Unknown argument: ${arg} (usage: generate.mjs [--run <id>] [--open] [--force])`);
    }
  }
  return args;
}

/**
 * Parse a textual artifact into the shape the viewer renders. Malformed
 * content is returned as an explicit invalid value — never silently dropped —
 * so the viewer can show "unparsed" lines instead of a healthy-looking gap.
 */
function parseInline(absPath, text) {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".jsonl" || ext === ".ndjson") {
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return { ok: true, value: JSON.parse(line) };
        } catch {
          // error-policy:J3 artifact bytes are untrusted; a malformed line becomes an explicit invalid entry the viewer flags
          return { ok: false, raw: line };
        }
      });
    return { type: "jsonl", lines };
  }
  if (ext === ".json") {
    try {
      return { type: "json", value: JSON.parse(text) };
    } catch {
      // error-policy:J3 invalid JSON is surfaced as raw content with an explicit invalid marker
      return { type: "invalid-json", raw: text };
    }
  }
  return { type: "text", text };
}

/** Href from `viewer/index.html` back to an artifact inside `tests/<id>/`. */
function artifactHref(testDirRel, artifactPath) {
  const segments = [...testDirRel.split("/"), ...String(artifactPath).split("/")];
  return `../${segments.map(encodeURIComponent).join("/")}`;
}

function enrichArtifact(runRoot, testDirRel, artifact) {
  const enriched = { ...artifact, href: artifactHref(testDirRel, artifact.path) };
  if (!INLINE_KINDS.has(artifact.kind)) return enriched;
  const absPath = path.join(runRoot, testDirRel, artifact.path);
  if (!fs.existsSync(absPath)) {
    enriched.inlineSkipped = "missing";
    return enriched;
  }
  const size = fs.statSync(absPath).size;
  enriched.sizeBytes = size;
  if (size > INLINE_LIMIT_BYTES) {
    enriched.inlineSkipped = "too-large";
    return enriched;
  }
  enriched.inline = parseInline(absPath, fs.readFileSync(absPath, "utf8"));
  return enriched;
}

/**
 * Bundle rrweb-player into `<viewerDir>/replay.js` (IIFE, exposes
 * `window.rrwebPlayer`). Skipped when the bundle already exists unless
 * forced — the bundle only changes when the dependency version does.
 */
async function ensureReplayBundle(viewerDir, force) {
  const outfile = path.join(viewerDir, "replay.js");
  if (!force && fs.existsSync(outfile)) return { outfile, cached: true };
  require.resolve("esbuild");
  const esbuild = await import("esbuild");
  await esbuild.build({
    stdin: {
      contents: 'import Player from "rrweb-player";\nwindow.rrwebPlayer = Player;\n',
      resolveDir: repoRoot,
      loader: "js",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    minify: true,
    logLevel: "silent",
    outfile,
  });
  return { outfile, cached: false };
}

function openInBrowser(target) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = args.run ?? latestRunId(repoRoot);
  if (!runId) {
    throw new Error(`No e2e runs found under the artifacts root (and no --run given). Run a lane first or point ELIZA_E2E_RUN_ID at one.`);
  }
  const runRoot = runDir(repoRoot, runId);
  if (!fs.existsSync(path.join(runRoot, "tests"))) {
    throw new Error(`Run "${runId}" has no tests/ directory at ${runRoot}`);
  }

  const index = buildRunIndex(repoRoot, runId);
  const tests = index.tests.map((entry) => {
    const manifest = readTestManifest(path.join(runRoot, entry.dir));
    if (!manifest) {
      throw new Error(`Manifest disappeared while generating: ${entry.dir}`);
    }
    return {
      ...manifest,
      dir: entry.dir,
      artifacts: (manifest.artifacts ?? []).map((artifact) => enrichArtifact(runRoot, entry.dir, artifact)),
    };
  });

  const viewerDir = path.join(runRoot, "viewer");
  fs.mkdirSync(viewerDir, { recursive: true });

  const replay = await ensureReplayBundle(viewerDir, args.force);

  // "</" must not appear verbatim inside the inline <script> payloads.
  const dataJs = `window.E2E_VIEWER_DATA = ${JSON.stringify({ index, tests }).replace(/</g, "\\u003c")};\n`;
  fs.writeFileSync(path.join(viewerDir, "data.js"), dataJs);

  const playerCss = fs.readFileSync(require.resolve("rrweb-player/dist/style.css"), "utf8");
  const indexHtml = path.join(viewerDir, "index.html");
  fs.writeFileSync(
    indexHtml,
    buildViewerHtml({ runId, generatedAt: index.generatedAt, playerCss }),
  );

  console.log(`[e2e-viewer] run ${runId}: ${index.testCount} tests (${JSON.stringify(index.statusCounts)})`);
  console.log(`[e2e-viewer] replay bundle ${replay.cached ? "cached" : "built"}: ${replay.outfile}`);
  console.log(`[e2e-viewer] wrote ${indexHtml}`);
  if (args.open) openInBrowser(indexHtml);
}

await main();
