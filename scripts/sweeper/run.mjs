#!/usr/bin/env node
/**
 * Orchestrator for the nightly E2E orphan sweeper.
 *
 * Usage:
 *   bun run scripts/sweeper/run.mjs --service gmail --max-age-hours 24
 *   bun run scripts/sweeper/run.mjs --service all   --max-age-hours 24
 *
 * Each service-specific sweeper lives at `scripts/sweeper/<service>.mjs` and
 * exports a default async function `sweep({ maxAgeMs, dryRun, logger })` that
 * returns `{ deleted: number, kept: number, notes: string[] }`.
 *
 * Sweepers for integrations whose backends aren't yet implemented will throw
 * `NotYetImplementedError` — that's expected while those integrations land,
 * and translates to a yellow warning in the workflow summary rather than a
 * red failure. A real failure is anything else.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KNOWN_SERVICES = [
  "gmail",
  "calendar",
  "discord",
  "telegram",
  "twitter",
  "signal",
  "imessage",
  "github",
  "twilio",
  "selfcontrol",
];

function getFlag(name, def) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return def;
  return process.argv[idx + 1] ?? def;
}

const service = getFlag("--service", "all");
const maxAgeHours = Number(getFlag("--max-age-hours", "24"));
const dryRun = process.argv.includes("--dry-run");

const servicesToRun =
  service === "all" ? KNOWN_SERVICES : service.split(",").map((s) => s.trim());

for (const s of servicesToRun) {
  if (!KNOWN_SERVICES.includes(s)) {
    console.error(
      `❌ Unknown service: ${s}. Known: ${KNOWN_SERVICES.join(", ")}`,
    );
    process.exit(2);
  }
}

const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

const results = [];
let anyHardFailure = false;

for (const svc of servicesToRun) {
  const modulePath = path.join(__dirname, `${svc}.mjs`);
  try {
    const mod = await import(modulePath);
    const sweepFn = mod.default ?? mod.sweep;
    if (typeof sweepFn !== "function") {
      const reason = `${modulePath} does not export a default function`;
      console.error(`❌ ${svc}: ${reason}`);
      anyHardFailure = true;
      results.push({ service: svc, status: "error", reason });
      continue;
    }
    const started = Date.now();
    const res = await sweepFn({
      maxAgeMs,
      dryRun,
      logger: {
        info: (...args) => console.log(`[${svc}]`, ...args),
        warn: (...args) => console.warn(`[${svc}][warn]`, ...args),
        error: (...args) => console.error(`[${svc}][error]`, ...args),
      },
    });
    const durationMs = Date.now() - started;
    results.push({ service: svc, status: "ok", ...res, durationMs });
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      err.name === "NotYetImplementedError"
    ) {
      results.push({
        service: svc,
        status: "not-yet-implemented",
        reason: String(err.message ?? err),
      });
    } else {
      anyHardFailure = true;
      results.push({
        service: svc,
        status: "error",
        reason: String(err instanceof Error ? err.message : err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const lines = [
  "## E2E Orphan Sweeper",
  "",
  `- max-age-hours: ${maxAgeHours}`,
  `- dry-run: ${dryRun}`,
  "",
  "| service | status | deleted | kept | notes |",
  "|---|---|---|---|---|",
];

for (const r of results) {
  const notes =
    r.status === "ok"
      ? (r.notes || []).join("; ")
      : r.status === "not-yet-implemented"
        ? r.reason
        : r.reason;
  lines.push(
    `| ${r.service} | ${r.status} | ${r.deleted ?? "-"} | ${r.kept ?? "-"} | ${notes ?? ""} |`,
  );
}

console.log(lines.join("\n"));

process.exit(anyHardFailure ? 1 : 0);
