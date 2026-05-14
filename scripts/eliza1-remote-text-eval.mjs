#!/usr/bin/env node
/**
 * Remote Eliza-1 text-quality eval against an OpenAI-compatible endpoint.
 *
 * This is deliberately not a local GGUF/perplexity run. It evaluates the live
 * Vast deployment against the held-out Eliza-1 JSONL and writes a text_eval
 * artifact under the native release-report tree so eliza1_gates_collect.mjs
 * can include it. Scores are behavior checks, not fabricated perplexity.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const DEFAULT_CORPUS = path.join(
  REPO_ROOT,
  "packages",
  "training",
  "datasets",
  "eliza1-sft-0_6b",
  "test.jsonl",
);
const DEFAULT_REPORT_ROOT = path.join(
  REPO_ROOT,
  "plugins",
  "plugin-local-inference",
  "native",
  "reports",
  "local-e2e",
);

const STOPWORDS = new Set(
  [
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "but",
    "by",
    "for",
    "from",
    "i",
    "in",
    "is",
    "it",
    "me",
    "my",
    "of",
    "on",
    "or",
    "that",
    "the",
    "to",
    "with",
    "you",
    "your",
  ].map((word) => word.toLowerCase()),
);

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.VAST_STAGING_BASE_URL?.trim() || "",
    apiKey: process.env.VAST_STAGING_API_KEY?.trim() || "not-required",
    model: process.env.VAST_STAGING_MODEL?.trim() || "",
    tier: process.env.ELIZA1_TEXT_EVAL_TIER?.trim() || "",
    corpus: process.env.ELIZA1_TEXT_EVAL_CORPUS?.trim() || DEFAULT_CORPUS,
    reportRoot:
      process.env.ELIZA1_TEXT_EVAL_REPORT_ROOT?.trim() || DEFAULT_REPORT_ROOT,
    maxRows: Number.parseInt(process.env.ELIZA1_TEXT_EVAL_MAX_ROWS || "0", 10),
    maxTokens: Number.parseInt(
      process.env.ELIZA1_TEXT_EVAL_MAX_TOKENS || "160",
      10,
    ),
    temperature: Number(process.env.ELIZA1_TEXT_EVAL_TEMPERATURE || "0"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--base-url") args.baseUrl = next();
    else if (arg === "--api-key") args.apiKey = next();
    else if (arg === "--model") args.model = next();
    else if (arg === "--tier") args.tier = next();
    else if (arg === "--corpus") args.corpus = path.resolve(next());
    else if (arg === "--report-root") args.reportRoot = path.resolve(next());
    else if (arg === "--max-rows") args.maxRows = Number.parseInt(next(), 10);
    else if (arg === "--max-tokens")
      args.maxTokens = Number.parseInt(next(), 10);
    else if (arg === "--temperature") args.temperature = Number(next());
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/eliza1-remote-text-eval.mjs --base-url URL --model MODEL --tier 2b|9b|27b",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.baseUrl) throw new Error("missing --base-url");
  if (!args.model) throw new Error("missing --model");
  if (!args.tier) throw new Error("missing --tier");
  args.baseUrl = args.baseUrl.replace(/\/+$/, "");
  return args;
}

function timestampForFile() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function readJsonl(file, maxRows) {
  const rows = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return maxRows > 0 ? rows.slice(0, maxRows) : rows;
}

function assistantText(row) {
  return (row.messages || [])
    .filter((message) => message.role === "assistant")
    .map((message) => String(message.content ?? ""))
    .join("\n")
    .trim();
}

function promptMessages(row) {
  return (row.messages || [])
    .filter((message) => message.role !== "assistant")
    .map((message) => ({
      role: message.role,
      content: String(message.content ?? ""),
    }));
}

function stripThinking(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_:-]/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function tokenF1(expected, actual) {
  const exp = tokens(expected);
  const act = tokens(actual);
  if (exp.length === 0) return act.length === 0 ? 1 : 0;
  if (act.length === 0) return 0;
  const counts = new Map();
  for (const token of act) counts.set(token, (counts.get(token) || 0) + 1);
  let overlap = 0;
  for (const token of exp) {
    const count = counts.get(token) || 0;
    if (count > 0) {
      overlap += 1;
      counts.set(token, count - 1);
    }
  }
  const precision = overlap / act.length;
  const recall = overlap / exp.length;
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
}

function parseJsonObject(text) {
  const clean = stripThinking(text);
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(clean.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function firstAction(text) {
  const match = stripThinking(text).match(/\bACTION\s*:\s*([A-Z0-9_]+)/i);
  return match ? match[1].toUpperCase() : null;
}

function expectedEmotionTag(text) {
  const match = String(text || "").match(/^\s*(\[[a-z]+\])/i);
  return match ? match[1].toLowerCase() : null;
}

function arrayOverlapScore(expected, actual) {
  const exp = Array.isArray(expected)
    ? expected.map((value) => String(value).toUpperCase())
    : [];
  const act = Array.isArray(actual)
    ? actual.map((value) => String(value).toUpperCase())
    : [];
  if (exp.length === 0) return act.length === 0 ? 1 : 0;
  const actSet = new Set(act);
  return exp.filter((value) => actSet.has(value)).length / exp.length;
}

function scoreJson(expectedText, actualText) {
  const expected = parseJsonObject(expectedText);
  const actual = parseJsonObject(actualText);
  if (!expected || !actual) {
    return {
      score: 0.15 * tokenF1(expectedText, actualText),
      reason: "json-parse-failed",
    };
  }
  let score = 0.25;
  if (
    expected.shouldRespond === undefined ||
    actual.shouldRespond === expected.shouldRespond
  ) {
    score += 0.12;
  }
  if (actual.requiresTool === expected.requiresTool) score += 0.16;
  score += 0.24 * arrayOverlapScore(expected.candidateActions, actual.candidateActions);
  score += 0.12 * tokenF1(JSON.stringify(expected.extract ?? {}), JSON.stringify(actual.extract ?? {}));
  score += 0.11 * tokenF1(expected.replyText ?? "", actual.replyText ?? "");
  return { score: clamp01(score), reason: "json-envelope" };
}

function scoreAction(expectedText, actualText) {
  const expected = firstAction(expectedText);
  const actual = firstAction(actualText);
  const actionScore = expected && actual === expected ? 0.72 : 0;
  const contentScore = 0.28 * tokenF1(expectedText, actualText);
  return {
    score: clamp01(actionScore + contentScore),
    reason: actual === expected ? "action-match" : `action-mismatch:${actual ?? "none"}`,
  };
}

function scoreVoice(expectedText, actualText) {
  const expectedTag = expectedEmotionTag(expectedText);
  const actual = stripThinking(actualText).toLowerCase();
  const tagScore = expectedTag && actual.includes(expectedTag) ? 0.42 : 0;
  return {
    score: clamp01(tagScore + 0.58 * tokenF1(expectedText, actualText)),
    reason: tagScore > 0 ? "emotion-tag-match" : "emotion-tag-missing",
  };
}

function scoreReply(expectedText, actualText) {
  const expected = expectedText.toLowerCase();
  const actual = stripThinking(actualText).toLowerCase();
  if (
    (expected.includes("can’t") || expected.includes("can't")) &&
    (actual.includes("can’t") ||
      actual.includes("can't") ||
      actual.includes("cannot") ||
      actual.includes("sorry"))
  ) {
    return { score: Math.max(0.7, tokenF1(expectedText, actualText)), reason: "refusal-intent" };
  }
  return { score: tokenF1(expectedText, actualText), reason: "token-f1" };
}

function scoreRow(row, actualText) {
  const expected = assistantText(row);
  if (expected.startsWith("{")) return scoreJson(expected, actualText);
  if (/^\s*ACTION\s*:/i.test(expected)) return scoreAction(expected, actualText);
  if (/^\s*\[[a-z]+\]/i.test(expected)) return scoreVoice(expected, actualText);
  return scoreReply(expected, actualText);
}

async function chat(args, row) {
  const started = performance.now();
  const res = await fetch(`${args.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: args.model,
      messages: promptMessages(row),
      temperature: args.temperature,
      max_tokens: args.maxTokens,
      stream: false,
    }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // keep json null
  }
  const content = json?.choices?.[0]?.message?.content ?? "";
  return {
    ok: res.ok,
    status: res.status,
    latencyMs: Math.round(performance.now() - started),
    content: stripThinking(content),
    rawText: text.slice(0, 1000),
    usage: json?.usage ?? null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = readJsonl(args.corpus, args.maxRows);
  const results = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const result = await chat(args, row);
    const scored = result.ok
      ? scoreRow(row, result.content)
      : { score: 0, reason: `http-${result.status}` };
    results.push({
      index,
      task: row.task ?? null,
      tags: row.tags ?? [],
      ok: result.ok,
      httpStatus: result.status,
      latencyMs: result.latencyMs,
      score: Number(scored.score.toFixed(4)),
      reason: scored.reason,
      expected: assistantText(row).slice(0, 500),
      actual: result.content.slice(0, 500),
      usage: result.usage,
    });
    console.log(
      `[remote-text-eval] ${args.tier} ${index + 1}/${rows.length} ${row.task ?? "unknown"} score=${results.at(-1).score} ${scored.reason}`,
    );
  }
  const score =
    results.reduce((sum, row) => sum + row.score, 0) / Math.max(1, results.length);
  const byTask = {};
  for (const row of results) {
    byTask[row.task ?? "unknown"] ??= { count: 0, scoreSum: 0 };
    byTask[row.task ?? "unknown"].count += 1;
    byTask[row.task ?? "unknown"].scoreSum += row.score;
  }
  for (const stats of Object.values(byTask)) {
    stats.score = Number((stats.scoreSum / stats.count).toFixed(4));
    delete stats.scoreSum;
  }
  const dateDir = new Date().toISOString().slice(0, 10);
  const reportDir = path.join(args.reportRoot, dateDir);
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(
    reportDir,
    `${args.tier}-text-eval-remote-${timestampForFile()}.json`,
  );
  const report = {
    schemaVersion: 1,
    metric: "text_eval",
    generatedAt: new Date().toISOString(),
    tier: args.tier,
    model: args.model,
    baseUrl: args.baseUrl,
    corpus: path.relative(REPO_ROOT, args.corpus),
    rows: results.length,
    score: Number(score.toFixed(4)),
    status: "ok",
    scoring:
      "Remote behavior score over held-out Eliza-1 JSONL; checks JSON envelope fields, ACTION names, expressive tags, refusal intent, and lexical F1. This is not local GGUF perplexity.",
    byTask,
    results,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[remote-text-eval] wrote ${path.relative(REPO_ROOT, reportPath)} score=${report.score}`);
}

main().catch((error) => {
  console.error(`[remote-text-eval] ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
