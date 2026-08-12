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
 *   1  — API not reachable / endpoint errored, or invalid CLI input.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  fetchAndRenderVoiceLatency,
  renderVoiceLatencyReport,
} from "./lib/voice-latency-report.mjs";

/** Practical upper bound so overflow/timer-adjacent values fail closed. */
export const MAX_LIMIT = 2_147_483_647;

function parsePositivePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

export function resolveApiBase(env, argBase) {
  if (argBase) return argBase.replace(/\/$/, "");
  const port =
    parsePositivePort(env.ELIZA_API_PORT) ??
    parsePositivePort(env.ELIZA_PORT) ??
    // Dev default is 31337; prod desktop default is 2138. Prefer dev.
    31337;
  return `http://127.0.0.1:${port}`;
}

/**
 * Accept only a complete positive decimal integer string (>= 1, <= MAX_LIMIT).
 * Rejects missing, fractional, signed, partial, zero, and non-finite values so
 * mistyped report flags fail before contacting the API.
 */
export function parsePositiveLimit(raw, flag = "--limit") {
  if (raw === undefined || raw === null) {
    throw new Error(`${flag} requires a positive integer >= 1`);
  }
  const value = String(raw);
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `${flag} must be a positive integer >= 1 (received ${JSON.stringify(value)})`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new Error(
      `${flag} must be a positive integer from 1 to ${MAX_LIMIT} (received ${JSON.stringify(value)})`,
    );
  }
  return parsed;
}

export function parseArgs(argv) {
  let json = false;
  /** @type {number | undefined} */
  let limit;
  /** @type {string | undefined} */
  let base;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--limit") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--limit requires a positive integer >= 1");
      }
      limit = parsePositiveLimit(value, "--limit");
    } else if (a === "--base") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--base requires a URL value");
      }
      base = value;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node voice-latency-report.mjs [--json] [--limit N] [--base http://127.0.0.1:31337]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { json, limit, base };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const baseUrl = resolveApiBase(env, args.base);

  const result = await fetchAndRenderVoiceLatency(baseUrl, {
    limit: args.limit,
  });

  if (!result.ok) {
    if (args.json) {
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

  if (args.json) {
    // Re-fetch raw JSON for --json mode (the lib renders text). Simpler than
    // threading the raw payload back through — and this path is for humans
    // anyway; --json is a convenience.
    const url = new URL("/api/dev/voice-latency", baseUrl);
    if (args.limit !== undefined) {
      url.searchParams.set("limit", String(args.limit));
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
}

const isMain =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error(`[voice-latency-report] ${err?.stack || err}`);
    process.exit(1);
  });
}
