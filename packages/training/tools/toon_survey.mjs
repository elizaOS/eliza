#!/usr/bin/env bun
/**
 * Legacy-only bulk TOON round-trip survey.
 *
 * Native v5 tool-calling exports are JSON; this survey is only for old
 * compatibility corpora that still contain TOON expectedResponse strings.
 *
 * Walks every JSONL under data/normalized/ (excluding *.errors.jsonl),
 * extracts the `expectedResponse` (a TOON string) from each record,
 * decodes via @toon-format/toon, and writes a JSON inventory of failures
 * bucketed by error class.
 *
 * Output: previews/toon_failures.json with shape
 *   {
 *     summary: { total, ok, fail, slugs: { slug: { count, ok, fail } } },
 *     errors:  { error_pattern: { count, slugs: { slug: count }, sample_records: [...] } }
 *   }
 */

import { decode } from "@toon-format/toon";
import {
  readdirSync,
  statSync,
  createReadStream,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join, basename } from "node:path";

const NORMALIZED_DIR = "data/normalized";
const OUT_PATH = "previews/toon_failures.json";

const args = process.argv.slice(2);
const limitPerFile = (() => {
  const i = args.indexOf("--limit-per-file");
  if (i >= 0 && args[i + 1]) return Number.parseInt(args[i + 1], 10);
  return Number.POSITIVE_INFINITY;
})();
const onlyArg = (() => {
  const i = args.indexOf("--only");
  if (i >= 0 && args[i + 1]) return new Set(args[i + 1].split(","));
  return null;
})();

function classifyError(msg) {
  // "Expected N inline array items, but got M" -> "Expected N inline array items, but got M"
  // Normalize numbers so we bucket related errors together.
  const m1 = msg.match(
    /^(?:RangeError: )?Expected (\d+) inline array items, but got (\d+)/,
  );
  if (m1) return `EXPECTED_INLINE_ARRAY_ITEMS_MISMATCH`;
  const m2 = msg.match(/^(?:SyntaxError: )?Invalid escape sequence/);
  if (m2) return "INVALID_ESCAPE_SEQUENCE";
  const m3 = msg.match(/^(?:SyntaxError: )?Unterminated string/);
  if (m3) return "UNTERMINATED_STRING";
  const m4 = msg.match(
    /^(?:SyntaxError: )?Unexpected characters after closing quote/,
  );
  if (m4) return "UNEXPECTED_AFTER_CLOSING_QUOTE";
  const m5 = msg.match(/^(?:SyntaxError: )?Missing colon after key/);
  if (m5) return "MISSING_COLON_AFTER_KEY";
  const m6 = msg.match(/^(?:TypeError: )?Invalid array length/);
  if (m6) return "INVALID_ARRAY_LENGTH";
  // Generic catch-all bucket: first 80 chars
  return `OTHER: ${msg.replace(/^(?:RangeError|SyntaxError|TypeError|Error): /, "").slice(0, 80)}`;
}

async function processFile(slug, path) {
  const stream = createReadStream(path, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  let ok = 0;
  let fail = 0;
  const failureRecords = [];
  for await (const line of rl) {
    if (count >= limitPerFile) break;
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      count++;
      fail++;
      failureRecords.push({
        idx: count - 1,
        error: "JSON_PARSE",
        snippet: line.slice(0, 200),
      });
      continue;
    }
    const er = rec.expectedResponse;
    count++;
    if (typeof er !== "string") {
      fail++;
      failureRecords.push({
        idx: count - 1,
        error: "NO_EXPECTED_RESPONSE",
        snippet: JSON.stringify(er).slice(0, 200),
      });
      continue;
    }
    // Skip task types whose expectedResponse is intentionally not TOON.
    // - `claude_distill` keeps raw `<think>{reasoning}</think>{final}` so the
    //   student model learns the upstream surface byte-for-byte (see
    //   scripts/lib/adapters.py::claude_distill).
    // The survey is for *TOON-encoded* targets; raw-text targets pass through
    // the trainer untouched and never go through a TOON round-trip at runtime.
    const taskType = rec?.metadata?.task_type;
    if (taskType === "claude_distill") {
      ok++; // counted as ok because TOON validity does not apply
      continue;
    }
    try {
      decode(er);
      ok++;
    } catch (e) {
      fail++;
      const msg = String(e?.message ?? e);
      failureRecords.push({
        idx: count - 1,
        error: msg,
        snippet: er.slice(0, 240),
      });
    }
  }
  return { slug, count, ok, fail, failureRecords };
}

async function main() {
  const files = readdirSync(NORMALIZED_DIR)
    .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".errors.jsonl"))
    .map((f) => ({
      slug: f.replace(/\.jsonl$/, ""),
      path: join(NORMALIZED_DIR, f),
    }))
    .filter((f) => !onlyArg || onlyArg.has(f.slug));

  files.sort((a, b) => statSync(a.path).size - statSync(b.path).size);

  const summary = { total: 0, ok: 0, fail: 0, slugs: {} };
  const errors = {}; // class -> { count, slugs, sample_records }

  for (const { slug, path } of files) {
    const t0 = Date.now();
    const result = await processFile(slug, path);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    summary.total += result.count;
    summary.ok += result.ok;
    summary.fail += result.fail;
    summary.slugs[slug] = {
      count: result.count,
      ok: result.ok,
      fail: result.fail,
    };

    for (const fr of result.failureRecords) {
      const cls = classifyError(fr.error);
      const bucket =
        errors[cls] ??
        (errors[cls] = { count: 0, slugs: {}, sample_records: [] });
      bucket.count++;
      bucket.slugs[slug] = (bucket.slugs[slug] ?? 0) + 1;
      if (bucket.sample_records.length < 5) {
        bucket.sample_records.push({
          slug,
          line_idx: fr.idx,
          error: fr.error,
          snippet: fr.snippet,
        });
      }
    }

    process.stderr.write(
      `[${dt}s] ${slug}: ${result.ok}/${result.count} ok (${result.fail} fail)\n`,
    );
  }

  // Sort error buckets by count desc.
  const sortedErrors = Object.fromEntries(
    Object.entries(errors).sort(([, a], [, b]) => b.count - a.count),
  );
  writeFileSync(
    OUT_PATH,
    JSON.stringify({ summary, errors: sortedErrors }, null, 2),
  );
  process.stderr.write(
    `\nDONE. total=${summary.total} ok=${summary.ok} fail=${summary.fail} (${(
      (summary.ok / summary.total) * 100
    ).toFixed(2)}%) -> ${OUT_PATH}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e?.stack ?? e}\n`);
  process.exit(1);
});
