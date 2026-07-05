#!/usr/bin/env node
/**
 * run-hitl.mjs — HITL golden-path harness skeleton (#14381).
 *
 * Walks the onboarding → first-chat → login decision points and produces a
 * HITL review packet: it drives the relevant EXISTING e2e recording suites
 * (through `scripts/e2e-recordings/run-all.mjs`, which already extracts frames,
 * builds contact sheets, and a viewer), then emits a `hitl-report.json` +
 * `hitl-report.md` that labels each staged frame with its decision point and a
 * pass / fail / blocked slot — so a developer skims a contact sheet during
 * development instead of manually driving the app or waiting for a device pass.
 *
 * It does NOT reinvent capture. Device-only decision points (real login,
 * wallet signing, push) are emitted as `blocked (device)` and routed to the
 * Seeker pass rather than faked headless.
 *
 * Usage:
 *   node scripts/hitl/run-hitl.mjs                # plan + report from existing recordings
 *   node scripts/hitl/run-hitl.mjs --record       # also (re)run the frame suites first
 *   node scripts/hitl/run-hitl.mjs --groups=onboarding,login
 *   node scripts/hitl/run-hitl.mjs --out=<dir>
 *
 * Honesty: the packages/ui e2e env is known-flaky. `--record` best-efforts the
 * suites and reports which ran / skipped / failed; the report is still emitted
 * from whatever frames exist so a partial run is still reviewable.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HITL_DECISION_POINTS,
  HITL_GOLDEN_GROUPS,
  hitlDeviceOnly,
  hitlFrameSuites,
} from "./hitl-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RECORDINGS_DIR = path.join(REPO_ROOT, "e2e-recordings");

// ── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = new Map();
for (const a of args) {
  const [k, v] = a.replace(/^--/, "").split("=");
  flags.set(k, v ?? true);
}
const doRecord = flags.get("record") === true || flags.get("record") === "true";
const groups = flags.has("groups")
  ? String(flags.get("groups"))
      .split(",")
      .map((s) => s.trim())
  : HITL_GOLDEN_GROUPS;
const outDir = flags.has("out")
  ? path.resolve(String(flags.get("out")))
  : path.join(RECORDINGS_DIR, "hitl");

function log(...m) {
  console.log("[hitl]", ...m);
}

// ── plan ──────────────────────────────────────────────────────────────────
const frameSuites = hitlFrameSuites(groups);
const deviceOnly = hitlDeviceOnly(groups);
const framePoints = HITL_DECISION_POINTS.filter(
  (dp) => dp.mark === "frame" && groups.includes(dp.group),
);
const autoPoints = HITL_DECISION_POINTS.filter(
  (dp) => dp.mark === "auto" && groups.includes(dp.group),
);

log(`groups: ${groups.join(", ")}`);
log(
  `frame decision points: ${framePoints.length} (suites: ${frameSuites.join(", ") || "none"})`,
);
log(`device-only (blocked, routed to Seeker): ${deviceOnly.length}`);
log(`auto (machine-decided, no human): ${autoPoints.length}`);

// ── optionally (re)run the frame suites through the existing pipeline ────────
const recordResult = { attempted: false, ran: [], failed: [], skipped: [] };
if (doRecord && frameSuites.length) {
  recordResult.attempted = true;
  const runAll = path.join(
    REPO_ROOT,
    "scripts",
    "e2e-recordings",
    "run-all.mjs",
  );
  log(
    `recording frame suites via ${path.relative(REPO_ROOT, runAll)} --packages=${frameSuites.join(",")}`,
  );
  const res = spawnSync(
    "node",
    [runAll, `--packages=${frameSuites.join(",")}`],
    { cwd: REPO_ROOT, stdio: "inherit", env: process.env },
  );
  // run-all uses exit code 77 for "skipped" per its contract.
  if (res.status === 0) recordResult.ran = frameSuites;
  else if (res.status === 77) recordResult.skipped = frameSuites;
  else recordResult.failed = frameSuites;
  log(`record exit=${res.status ?? "signal:" + res.signal}`);
} else if (doRecord) {
  log("no frame suites for the selected groups — nothing to record");
}

// ── collect whatever frames exist (partial runs still reviewable) ────────────
function readManifest() {
  const p = path.join(RECORDINGS_DIR, "manifest.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
const manifest = readManifest();
const haveContactSheets = fs.existsSync(
  path.join(RECORDINGS_DIR, "contact-sheets"),
);

// ── build the HITL review packet ─────────────────────────────────────────────
const report = {
  generatedAt: new Date().toISOString(),
  groups,
  record: recordResult,
  contactSheetsPresent: haveContactSheets,
  manifestPackages: manifest ? Object.keys(manifest).length : 0,
  decisionPoints: [],
};

for (const dp of HITL_DECISION_POINTS) {
  if (!groups.includes(dp.group)) continue;
  let state;
  if (dp.mark === "auto") state = "auto (no human needed)";
  else if (dp.mark === "device") state = "blocked (device) → Seeker pass";
  else
    state = haveContactSheets
      ? "review (frame staged)"
      : "review (no frames yet — run --record)";
  report.decisionPoints.push({
    id: dp.id,
    group: dp.group,
    label: dp.label,
    mark: dp.mark,
    why: dp.why,
    suites: dp.suites,
    scripts: dp.scripts ?? [],
    issues: dp.issues ?? [],
    result: null, // human fills: pass | fail | blocked
    state,
  });
}

fs.mkdirSync(outDir, { recursive: true });
const jsonPath = path.join(outDir, "hitl-report.json");
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

// markdown review sheet (what a developer skims)
const lines = [];
lines.push("# HITL review sheet");
lines.push("");
lines.push(`Generated: ${report.generatedAt}`);
lines.push(`Groups: ${groups.join(", ")}`);
lines.push(
  `Contact sheets: ${haveContactSheets ? "present (open e2e-recordings/viewer)" : "NOT present — run `node scripts/hitl/run-hitl.mjs --record`"}`,
);
lines.push("");
lines.push("| # | Group | Decision point | Mark | Result (fill in) | State |");
lines.push("|---|---|---|---|---|---|");
report.decisionPoints.forEach((dp, i) => {
  lines.push(
    `| ${i + 1} | ${dp.group} | ${dp.label} | ${dp.mark} | ☐ pass ☐ fail ☐ blocked | ${dp.state} |`,
  );
});
lines.push("");
if (deviceOnly.length) {
  lines.push("## Device-only (route to Seeker pass — not faked headless)");
  for (const dp of deviceOnly) {
    lines.push(
      `- **${dp.label}** — ${dp.why} (issues: ${(dp.issues ?? []).map((n) => `#${n}`).join(", ") || "—"})`,
    );
  }
  lines.push("");
}
lines.push("_See docs/testing/hitl-inventory.md for full rationale._");
const mdPath = path.join(outDir, "hitl-report.md");
fs.writeFileSync(mdPath, lines.join("\n") + "\n");

log(`wrote ${path.relative(REPO_ROOT, jsonPath)}`);
log(`wrote ${path.relative(REPO_ROOT, mdPath)}`);
log(
  `summary: ${report.decisionPoints.length} decision points ` +
    `(${framePoints.length} frame / ${deviceOnly.length} device / ${autoPoints.length} auto)`,
);

// non-zero only if --record was asked and the suites hard-failed, so CI can gate
// on capture health while a plan-only run always succeeds.
if (recordResult.attempted && recordResult.failed.length) {
  process.exitCode = 1;
}
