#!/usr/bin/env node
/**
 * guided_decode_token_bench.mjs — Eliza-1 guided-structured-decode token-savings
 * benchmark.
 *
 * Measures how many decode tokens the *eliza harness schema* removes from a
 * structured generation. When the agent's job is to emit a structured response
 * (action selection / tool call / typed object), the lazy GBNF forces the JSON
 * scaffold and the closed enum set, and the *prefill plan* lets the server
 * splice the deterministically-implied byte runs as token ids *without a
 * forward pass* (see
 * `packages/app-core/src/services/local-inference/structured-output.ts`
 * `ElizaPrefillPlan` / `reports/porting/2026-05-11/guided-structured-decoding.md`).
 *
 * Two modes:
 *
 *  - **static** (default — always runs, no model needed): for each
 *    representative skeleton it reports the bytes/estimated-tokens of the
 *    deterministic runs (the prefill plan's forced spans), i.e. the tokens the
 *    model never has to generate, vs. the total envelope size. The token
 *    estimate uses ~3.6 bytes/token (a llama-family BPE average for JSON-ish
 *    text); pass `--bpt N` to override. This is the "guaranteed" floor of the
 *    saving — independent of which words the model picks for the free spans.
 *
 *  - **live** (`--bin PATH` to a fork `llama-server`, `--model PATH` to a
 *    GGUF): runs each prompt twice — once unguided, once with the harness
 *    schema (grammar + prefill plan) on the request body — and reports the
 *    measured `completion_tokens` and wall-time delta. (Today's fork ignores
 *    `eliza_prefill_plan` and only honours the grammar, so the live delta is
 *    the *grammar-only* saving — the scaffold tokens are still generated but
 *    constrained; the prefill-plan saving lands when a fork build consumes the
 *    field. The static mode reports that future floor.) When no binary / model
 *    is available it writes `status: "skipped"` and exits 0 — it does NOT
 *    fabricate numbers (AGENTS.md §3 / §8).
 *
 * Usage:
 *   node packages/inference/verify/guided_decode_token_bench.mjs \
 *     [--bin PATH --model PATH] [--bpt 3.6] [--report PATH] [--json]
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const out = { bin: null, model: null, bpt: 3.6, report: null, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--bin") out.bin = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--bpt") out.bpt = Number(argv[++i]);
    else if (a === "--report") out.report = argv[++i];
    else if (a === "--json") out.json = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Representative eliza-harness skeletons (the structured outputs the agent loop
// actually emits). Built the same way `buildResponseGrammar` /
// `buildPlannerActionGrammar` do, inlined here so the bench has no app-core
// import (it runs from `packages/inference/`).
// ---------------------------------------------------------------------------

/** Build a planner action-selection skeleton over a closed action-id set. */
function plannerSkeleton(actionIds) {
  return {
    id: `planner#${actionIds.join(",")}`,
    spans: [
      { kind: "literal", value: '{"action":' },
      actionIds.length === 1
        ? {
            kind: "literal",
            key: "action",
            value: JSON.stringify(actionIds[0]),
          }
        : { kind: "enum", key: "action", enumValues: actionIds },
      { kind: "literal", value: ',"parameters":' },
      { kind: "free-json", key: "parameters" },
      { kind: "literal", value: ',"thought":' },
      { kind: "free-string", key: "thought" },
      { kind: "literal", value: "}" },
    ],
  };
}

/** Build the Stage-1 response-handler envelope skeleton (non-direct channel). */
function stage1Skeleton() {
  return {
    id: "stage1#full",
    spans: [
      { kind: "literal", value: '{"shouldRespond":' },
      {
        kind: "enum",
        key: "shouldRespond",
        enumValues: ["RESPOND", "IGNORE", "STOP"],
      },
      { kind: "literal", value: ',"thought":' },
      { kind: "free-string", key: "thought" },
      { kind: "literal", value: ',"replyText":' },
      { kind: "free-string", key: "replyText" },
      { kind: "literal", value: ',"contexts":' },
      { kind: "free-json", key: "contexts" },
      { kind: "literal", value: ',"requiresTool":' },
      { kind: "free-json", key: "requiresTool" },
      { kind: "literal", value: ',"extract":' },
      { kind: "free-json", key: "extract" },
      { kind: "literal", value: "}" },
    ],
  };
}

/** A typed-field object (e.g. a SETTINGS action's parameters). */
function typedFieldsSkeleton() {
  return {
    id: "settings#params",
    spans: [
      { kind: "literal", value: '{"action":"' },
      { kind: "enum", key: "action", enumValues: ["set", "get", "list"] },
      { kind: "literal", value: '","provider":"' },
      {
        kind: "enum",
        key: "provider",
        enumValues: ["openai", "anthropic", "local"],
      },
      { kind: "literal", value: '","capability":"' },
      { kind: "free-string", key: "capability" },
      { kind: "literal", value: '","enabled":' },
      { kind: "free-json", key: "enabled" },
      { kind: "literal", value: "}" },
    ],
  };
}

/** Single-action turn (every scaffold byte AND the action id are forced). */
function singleActionSkeleton() {
  return plannerSkeleton(["IGNORE"]);
}

const SKELETONS = [
  {
    name: "planner-action-select (8 actions)",
    skeleton: plannerSkeleton([
      "REPLY",
      "SEND_MESSAGE",
      "IGNORE",
      "MUTE_ROOM",
      "FOLLOW_ROOM",
      "UNFOLLOW_ROOM",
      "UPDATE_SETTINGS",
      "GENERATE_IMAGE",
    ]),
  },
  {
    name: "planner-action-select (single action)",
    skeleton: singleActionSkeleton(),
  },
  { name: "stage1-response-envelope", skeleton: stage1Skeleton() },
  { name: "typed-fields-object (SETTINGS)", skeleton: typedFieldsSkeleton() },
];

// ---------------------------------------------------------------------------
// collapseSkeleton + compilePrefillPlan — inlined mirror of structured-output.ts
// ---------------------------------------------------------------------------

function collapseSkeleton(skeleton) {
  const out = [];
  for (const span of skeleton.spans) {
    if (
      span.kind === "enum" &&
      Array.isArray(span.enumValues) &&
      span.enumValues.length <= 1
    ) {
      out.push({
        kind: "literal",
        key: span.key,
        value: span.enumValues[0] ?? span.value ?? "",
      });
      continue;
    }
    out.push(span);
  }
  return { spans: out, id: skeleton.id };
}

function compilePrefillPlan(skeletonInput) {
  const skeleton = collapseSkeleton(skeletonInput);
  const runs = [];
  let freeCount = 0;
  let pending = "";
  const flush = (after) => {
    if (pending.length === 0) return;
    runs.push({ afterFreeSpan: after, text: pending });
    pending = "";
  };
  for (const span of skeleton.spans) {
    if (span.kind === "literal") {
      pending += span.value ?? "";
      continue;
    }
    if (
      span.kind === "enum" &&
      Array.isArray(span.enumValues) &&
      span.enumValues.length === 1
    ) {
      pending += JSON.stringify(String(span.enumValues[0]));
      continue;
    }
    flush(freeCount - 1);
    freeCount += 1;
  }
  flush(freeCount - 1);
  if (runs.length === 0) return null;
  return {
    prefix: runs[0].afterFreeSpan === -1 ? runs[0].text : "",
    runs,
    freeCount,
    id: skeleton.id,
  };
}

/** Bytes the prefill plan forces (the deterministic runs the model never generates). */
function forcedBytes(plan) {
  return plan
    ? plan.runs.reduce((n, r) => n + Buffer.byteLength(r.text, "utf8"), 0)
    : 0;
}

/** A representative "free" content size in bytes for token estimates, per skeleton. */
function estimateFreeBytes(skeleton) {
  // Rough: thought ~80 chars, replyText ~120, parameters ~40, contexts ~12,
  // requiresTool ~5, extract ~20, a free-string field ~20, enum-with-N ~ name len.
  let total = 0;
  for (const span of skeleton.spans) {
    if (span.kind === "literal") continue;
    if (span.kind === "enum") {
      const vals = span.enumValues ?? [];
      if (vals.length <= 1) continue; // collapsed
      // The model emits one of the (JSON-quoted) values — average length.
      total += Math.round(
        vals.reduce((n, v) => n + v.length + 2, 0) / vals.length,
      );
      continue;
    }
    const k = span.key ?? "";
    if (k === "thought") total += 80;
    else if (k === "replyText") total += 120;
    else if (k === "parameters") total += 40;
    else if (k === "contexts") total += 12;
    else if (k === "extract") total += 20;
    else total += 12;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Static mode
// ---------------------------------------------------------------------------

function runStatic(bpt) {
  const rows = SKELETONS.map(({ name, skeleton }) => {
    const plan = compilePrefillPlan(skeleton);
    const forced = forcedBytes(plan);
    const free = estimateFreeBytes(skeleton);
    const totalBytes = forced + free;
    const forcedTokens = Math.round(forced / bpt);
    const freeTokens = Math.round(free / bpt);
    const totalTokens = forcedTokens + freeTokens;
    return {
      name,
      freeSpans: plan?.freeCount ?? 0,
      forcedBytes: forced,
      forcedTokensEst: forcedTokens,
      freeBytesEst: free,
      freeTokensEst: freeTokens,
      totalTokensEst: totalTokens,
      tokenReductionPct:
        totalTokens > 0 ? Math.round((forcedTokens / totalTokens) * 100) : 0,
      prefixBytes: plan ? Buffer.byteLength(plan.prefix, "utf8") : 0,
    };
  });
  const agg = {
    forcedTokensEst: rows.reduce((n, r) => n + r.forcedTokensEst, 0),
    totalTokensEst: rows.reduce((n, r) => n + r.totalTokensEst, 0),
  };
  agg.tokenReductionPct =
    agg.totalTokensEst > 0
      ? Math.round((agg.forcedTokensEst / agg.totalTokensEst) * 100)
      : 0;
  return { mode: "static", bytesPerToken: bpt, rows, aggregate: agg };
}

// ---------------------------------------------------------------------------
// Live mode (optional)
// ---------------------------------------------------------------------------

const PROMPTS = [
  "User: schedule a meeting tomorrow at 3pm with the design team.\nPick an action and parameters.",
  "User: hey what's up?\nDecide whether to respond and draft a reply.",
  "User: turn on the openai provider for image generation.\nFill in the settings object.",
];

async function fetchJson(url, body, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function waitHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.ok) return resolve();
      } catch {}
      if (Date.now() > deadline)
        return reject(new Error("server health timeout"));
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function runLive(opts) {
  if (!fs.existsSync(opts.bin) || !fs.existsSync(opts.model)) {
    return null;
  }
  const port = 18900 + (process.pid % 200);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    opts.bin,
    [
      "-m",
      opts.model,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "-c",
      "4096",
      "-np",
      "1",
      "--no-warmup",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  try {
    await waitHealth(baseUrl, 60_000);
    const rows = [];
    for (let i = 0; i < PROMPTS.length; i += 1) {
      const prompt = PROMPTS[i];
      const skeleton =
        i === 1
          ? stage1Skeleton()
          : i === 2
            ? typedFieldsSkeleton()
            : plannerSkeleton([
                "REPLY",
                "SEND_MESSAGE",
                "IGNORE",
                "UPDATE_SETTINGS",
              ]);
      const plan = compilePrefillPlan(skeleton);
      const grammar = compileSkeletonToGbnfLike(skeleton);
      const base = {
        model: "x",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 256,
        temperature: 0.2,
        cache_prompt: true,
      };
      const t0 = Date.now();
      const r0 = await fetchJson(
        `${baseUrl}/v1/chat/completions`,
        base,
        60_000,
      );
      const dtUnguided = Date.now() - t0;
      const guidedBody = {
        ...base,
        grammar: grammar.source,
        ...(grammar.lazy
          ? {
              grammar_lazy: true,
              grammar_triggers: grammar.triggers.map((v) => ({
                type: "word",
                value: v,
              })),
            }
          : {}),
        eliza_prefill_plan: plan
          ? {
              prefix: plan.prefix,
              runs: plan.runs.map((r) => ({
                after_free_span: r.afterFreeSpan,
                text: r.text,
              })),
              free_count: plan.freeCount,
              id: plan.id,
            }
          : undefined,
        messages:
          plan && plan.prefix
            ? [
                { role: "user", content: prompt },
                { role: "assistant", content: plan.prefix },
              ]
            : base.messages,
        continue_final_message: !!(plan && plan.prefix),
      };
      const t1 = Date.now();
      const r1 = await fetchJson(
        `${baseUrl}/v1/chat/completions`,
        guidedBody,
        60_000,
      );
      const dtGuided = Date.now() - t1;
      rows.push({
        prompt: prompt.slice(0, 40) + "…",
        unguided: {
          completionTokens: r0?.usage?.completion_tokens ?? null,
          wallMs: dtUnguided,
        },
        guided: {
          completionTokens: r1?.usage?.completion_tokens ?? null,
          wallMs: dtGuided,
          prefillPlanForcedBytes: forcedBytes(plan),
        },
        tokenDelta:
          (r0?.usage?.completion_tokens ?? 0) -
          (r1?.usage?.completion_tokens ?? 0),
        wallDeltaMs: dtUnguided - dtGuided,
      });
    }
    return { mode: "live", bin: opts.bin, model: opts.model, rows };
  } finally {
    child.kill("SIGKILL");
  }
}

// Minimal GBNF compiler for the live mode (mirror of compileSkeletonToGbnf).
function gbnfEsc(s) {
  let o = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === "\\") o += "\\\\";
    else if (ch === '"') o += '\\"';
    else if (ch === "\n") o += "\\n";
    else if (ch === "\r") o += "\\r";
    else if (ch === "\t") o += "\\t";
    else if (c < 0x20) o += `\\x${c.toString(16).padStart(2, "0")}`;
    else o += ch;
  }
  return o;
}
function compileSkeletonToGbnfLike(skeletonInput) {
  const skeleton = collapseSkeleton(skeletonInput);
  const JSON_STRING = '"\\"" ( [^"\\\\] | "\\\\" . )* "\\""';
  const JSON_VALUE = [
    'jsonvalue ::= jsonobject | jsonarray | jsonstring | jsonnumber | "true" | "false" | "null"',
    'jsonobject ::= "{" ws ( jsonstring ws ":" ws jsonvalue ( ws "," ws jsonstring ws ":" ws jsonvalue )* )? ws "}"',
    'jsonarray ::= "[" ws ( jsonvalue ( ws "," ws jsonvalue )* )? ws "]"',
    `jsonstring ::= ${JSON_STRING}`,
    'jsonnumber ::= "-"? ( [0-9] | [1-9] [0-9]* ) ( "." [0-9]+ )? ( [eE] [-+]? [0-9]+ )?',
    "ws ::= [ \\t\\n\\r]*",
  ].join("\n");
  const rules = new Map();
  const root = [];
  let freeIdx = 0,
    needsJson = false,
    trigger = null;
  skeleton.spans.forEach((span, i) => {
    if (span.kind === "literal") {
      const t = span.value ?? "";
      if (i === 0 && t.length) trigger = t;
      root.push(`"${gbnfEsc(t)}"`);
    } else if (span.kind === "enum") {
      const vals = span.enumValues ?? [];
      const rn = `enum${freeIdx++}`;
      rules.set(rn, vals.map((v) => `"${gbnfEsc(`"${v}"`)}"`).join(" | "));
      root.push(rn);
    } else if (span.kind === "free-string") {
      const rn = `freestr${freeIdx++}`;
      rules.set(rn, JSON_STRING);
      root.push(rn);
    } else {
      needsJson = true;
      root.push("jsonvalue");
    }
  });
  const lines = [`root ::= ${root.join(" ")}`];
  for (const [n, b] of rules) lines.push(`${n} ::= ${b}`);
  if (needsJson) lines.push(JSON_VALUE);
  return {
    source: lines.join("\n"),
    lazy: !!trigger,
    triggers: trigger ? [trigger] : [],
  };
}

// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  const reportPath = opts.report
    ? path.resolve(opts.report)
    : path.join(
        __dirname,
        "bench_results",
        `guided_decode_${new Date().toISOString().slice(0, 10)}.json`,
      );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  const result = {
    benchmark: "guided-structured-decode-token-savings",
    generatedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
    },
    static: runStatic(opts.bpt),
    live: null,
  };
  if (opts.bin && opts.model) {
    try {
      result.live = await runLive(opts);
    } catch (err) {
      result.live = {
        mode: "live",
        status: "failed",
        reason: String(err && err.message ? err.message : err),
      };
    }
    if (result.live === null) {
      result.live = {
        mode: "live",
        status: "skipped",
        reason: "binary or model not found",
      };
    }
  } else {
    result.live = {
      mode: "live",
      status: "skipped",
      reason: "pass --bin PATH --model PATH for a live run",
    };
  }

  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      "[guided-decode-bench] static token savings (estimated, bpt=" +
        opts.bpt +
        "):",
    );
    for (const r of result.static.rows) {
      console.log(
        `  ${r.name.padEnd(40)} free-spans=${String(r.freeSpans).padStart(2)}  ` +
          `forced≈${String(r.forcedTokensEst).padStart(3)}tok  free≈${String(r.freeTokensEst).padStart(3)}tok  ` +
          `→ ${String(r.tokenReductionPct).padStart(2)}% fewer generated`,
      );
    }
    console.log(
      `  AGGREGATE: ${result.static.aggregate.forcedTokensEst}/${result.static.aggregate.totalTokensEst} tokens forced ≈ ${result.static.aggregate.tokenReductionPct}% reduction`,
    );
    if (
      result.live &&
      result.live.mode === "live" &&
      Array.isArray(result.live.rows)
    ) {
      console.log(
        "[guided-decode-bench] live (grammar-only today; prefill-plan when the fork consumes it):",
      );
      for (const r of result.live.rows) {
        console.log(
          `  ${r.prompt.padEnd(42)} Δtokens=${r.tokenDelta}  Δwall=${r.wallDeltaMs}ms`,
        );
      }
    } else {
      console.log(
        `[guided-decode-bench] live: ${result.live?.reason ?? "skipped"}`,
      );
    }
    console.log(`[guided-decode-bench] report → ${reportPath}`);
  }
}

main().catch((err) => {
  console.error("[guided-decode-bench] error:", err);
  process.exit(1);
});
