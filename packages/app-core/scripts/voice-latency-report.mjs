#!/usr/bin/env node
/**
 * Print the end-to-end voice-loop latency table from a running Eliza API.
 *
 * **Why this exists:** agents/CI can't watch the native voice loop; the API
 * exposes `GET /api/dev/voice-latency` (loopback) with recent per-turn
 * traces + per-stage p50/p90/p99 histograms. This script fetches and
 * renders it, with one exit code.
 *
 * Usage:
 *   node eliza/packages/app-core/scripts/voice-latency-report.mjs [--json] [--limit N] [--base http://127.0.0.1:31337]
 *
 * Exit codes:
 *   0  — payload fetched (regardless of whether any traces exist).
 *   1  — API not reachable / endpoint errored.
 */

import {
  fetchAndRenderVoiceLatency,
  renderVoiceLatencyReport,
} from "./lib/voice-latency-report.mjs";

function parsePositivePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function resolveApiBase(env, argBase) {
  if (argBase) return argBase.replace(/\/$/, "");
  const port =
    parsePositivePort(env.ELIZA_API_PORT) ??
    parsePositivePort(env.ELIZA_PORT) ??
    // Dev default is 31337; prod desktop default is 2138. Prefer dev.
    31337;
  return `http://127.0.0.1:${port}`;
}

const argv = process.argv.slice(2);
let json = false;
let limit;
let base;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--json") json = true;
  else if (a === "--limit") {
    i += 1;
    limit = Number(argv[i]);
  } else if (a === "--base") {
    i += 1;
    base = argv[i];
  } else if (a === "--help" || a === "-h") {
    console.log(
      "Usage: node voice-latency-report.mjs [--json] [--limit N] [--base http://127.0.0.1:31337]",
    );
    process.exit(0);
  }
}

const baseUrl = resolveApiBase(process.env, base);

const result = await fetchAndRenderVoiceLatency(baseUrl, {
  limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
});

if (!result.ok) {
  if (json) {
    console.log(JSON.stringify({ ok: false, baseUrl, error: result.error }));
  } else {
    console.error(
      `[voice-latency-report] could not fetch ${baseUrl}/api/dev/voice-latency: ${result.error}`,
    );
    console.error(
      "[voice-latency-report] is the API running? (bun run dev / dev:desktop)",
    );
  }
  process.exit(1);
}

if (json) {
  // Re-fetch raw JSON for --json mode (the lib renders text). Simpler than
  // threading the raw payload back through — and this path is for humans
  // anyway; --json is a convenience.
  const url = new URL("/api/dev/voice-latency", baseUrl);
  if (Number.isInteger(limit) && limit > 0) {
    url.searchParams.set("limit", String(limit));
  }
  const res = await fetch(url.toString());
  const payload = await res.json();
  console.log(JSON.stringify(payload, null, 2));
  // Echo the rendered table to stderr so it's still visible.
  console.error(renderVoiceLatencyReport(payload));
  process.exit(0);
}

console.log(result.report);
process.exit(0);
