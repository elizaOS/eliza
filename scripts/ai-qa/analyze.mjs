#!/usr/bin/env node
// Reads capture records produced by ai-qa-capture.spec.ts and runs a Claude
// vision pass over each screenshot. Writes per-capture findings JSON + a
// rolled-up markdown report.
//
// Usage:
//   node scripts/ai-qa/analyze.mjs --run-dir reports/ai-qa/<run-id>
//   node scripts/ai-qa/analyze.mjs --run-dir reports/ai-qa/<run-id> --route apps-catalog --viewport desktop
//
// Env:
//   ANTHROPIC_API_KEY  — required; loaded from .env if present
//   AI_QA_MODEL        — defaults to "claude-opus-4-7"
//   AI_QA_MAX_TOKENS   — defaults to 4096
//   AI_QA_CONCURRENCY  — defaults to 3

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

// --- minimal .env loader (no dotenv dependency) ---------------------------
async function loadDotEnvFile(envPath) {
  if (!existsSync(envPath)) return;
  const raw = await readFile(envPath, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

async function loadDotEnv() {
  // First the repo's own .env, then the parent milady/.env (workspace root).
  // process.env already-set values win — no override.
  await loadDotEnvFile(join(REPO_ROOT, ".env"));
  await loadDotEnvFile(join(REPO_ROOT, "..", ".env"));
}

// --- arg parsing -----------------------------------------------------------
function parseArgs(argv) {
  const out = { route: null, viewport: null, theme: null, runDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--run-dir") {
      out.runDir = next;
      i += 1;
    } else if (arg === "--route") {
      out.route = next;
      i += 1;
    } else if (arg === "--viewport") {
      out.viewport = next;
      i += 1;
    } else if (arg === "--theme") {
      out.theme = next;
      i += 1;
    }
  }
  return out;
}

// --- discovery -------------------------------------------------------------
async function findLatestRunDir() {
  const root = join(REPO_ROOT, "reports", "ai-qa");
  if (!existsSync(root)) return null;
  const entries = await readdir(root);
  const dirs = [];
  for (const entry of entries) {
    const full = join(root, entry);
    const st = await stat(full).catch(() => null);
    if (st?.isDirectory()) dirs.push({ name: entry, full });
  }
  if (dirs.length === 0) return null;
  dirs.sort((a, b) => (a.name < b.name ? 1 : -1));
  return dirs[0].full;
}

async function listCaptureRecords(runDir) {
  const captureRoot = join(runDir, "captures");
  if (!existsSync(captureRoot)) return [];
  const records = [];
  for (const routeDir of await readdir(captureRoot)) {
    const routePath = join(captureRoot, routeDir);
    const st = await stat(routePath).catch(() => null);
    if (!st?.isDirectory()) continue;
    for (const file of await readdir(routePath)) {
      if (!file.endsWith(".json")) continue;
      const recordPath = join(routePath, file);
      try {
        const record = JSON.parse(await readFile(recordPath, "utf-8"));
        records.push({ recordPath, record });
      } catch (error) {
        console.error(`[ai-qa] skip unreadable ${recordPath}:`, error.message);
      }
    }
  }
  return records;
}

// --- vision provider selection ---------------------------------------------
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const OPENAI_API = "https://api.openai.com/v1/chat/completions";
const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";
const ANTHROPIC_MODEL = process.env.AI_QA_ANTHROPIC_MODEL ?? "claude-opus-4-7";
const OPENAI_MODEL = process.env.AI_QA_OPENAI_MODEL ?? "gpt-5.5";
const GROQ_MODEL =
  process.env.AI_QA_GROQ_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct";
// Back-compat env (the original analyze.mjs only knew about Claude).
const MODEL = process.env.AI_QA_MODEL ?? ANTHROPIC_MODEL;
const MAX_TOKENS = Number(process.env.AI_QA_MAX_TOKENS ?? "4096");

function looksLikeOpenAiKey(key) {
  return typeof key === "string" && key.startsWith("sk-");
}

function looksLikeGroqKey(key) {
  return typeof key === "string" && key.startsWith("gsk_");
}

function selectVisionProvider() {
  const forced = process.env.AI_QA_PROVIDER?.toLowerCase();
  if (forced === "anthropic" || forced === "claude") {
    return process.env.ANTHROPIC_API_KEY ? "anthropic" : null;
  }
  if (forced === "openai") {
    return looksLikeOpenAiKey(process.env.OPENAI_API_KEY) ? "openai" : null;
  }
  if (forced === "groq") {
    return process.env.GROQ_API_KEY || looksLikeGroqKey(process.env.OPENAI_API_KEY)
      ? "groq"
      : null;
  }
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (looksLikeOpenAiKey(process.env.OPENAI_API_KEY)) return "openai";
  // Repos that route Groq through OPENAI_API_KEY are common in this workspace.
  if (process.env.GROQ_API_KEY || looksLikeGroqKey(process.env.OPENAI_API_KEY)) {
    return "groq";
  }
  return null;
}

function groqApiKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  if (looksLikeGroqKey(process.env.OPENAI_API_KEY)) {
    return process.env.OPENAI_API_KEY;
  }
  return null;
}

const SYSTEM_PROMPT = `You are a senior product designer and QA engineer reviewing an
in-app screenshot for the elizaOS / Milady desktop+web+mobile assistant.

Your job: identify concrete, actionable issues with this page. You will be given:
- the screenshot
- the viewport (desktop / tablet / mobile)
- the theme (light / dark)
- a button inventory of visible interactive elements
- captured console errors / network failures

Return STRICT JSON only (no prose, no markdown fence), shaped:
{
  "summary": "one sentence overall impression",
  "findings": [
    {
      "severity": "P0" | "P1" | "P2" | "P3",
      "category": "layout" | "copy" | "accessibility" | "interaction" | "branding" | "data" | "error" | "navigation" | "other",
      "title": "short imperative title under 60 chars",
      "detail": "what is wrong and how a user would notice",
      "fix": "concrete suggested change a developer can implement"
    }
  ]
}

Severity meaning:
- P0: page is broken — crash, dead button, no content, can't proceed
- P1: significant usability/visual problem — critical info missing, unreadable, severely misaligned
- P2: notable but workaroundable — confusing copy, minor layout, low contrast
- P3: polish — spacing, voice, micro-interactions

Be specific. "Buttons look fine" is not a finding. "The 'Save' button on the right
has no visible label in dark mode (white text on white background)" is a finding.

If the page looks clean, return an empty findings array. Do not invent issues.
Be skeptical: console errors do not always mean the user experience is broken —
mention them only if they would surface to a user.

NEVER return non-JSON. NEVER wrap JSON in markdown.`;

function parseJsonResponse(text) {
  const trimmed = text.trim();
  const stripped = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(stripped);
}

async function callAnthropic({ imageBase64, userText }) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: imageBase64,
            },
          },
          { type: "text", text: userText },
        ],
      },
    ],
  };
  const response = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      reason: `anthropic ${response.status}: ${text.slice(0, 300)}`,
    };
  }
  const json = await response.json();
  const blocks = Array.isArray(json.content) ? json.content : [];
  const textBlock = blocks.find((b) => b.type === "text");
  if (!textBlock) {
    return { ok: false, reason: "anthropic: no text block in response" };
  }
  return { ok: true, text: textBlock.text };
}

async function callOpenAiCompatible({
  endpoint,
  apiKey,
  model,
  imageBase64,
  userText,
  providerName,
}) {
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${imageBase64}` },
          },
          { type: "text", text: userText },
        ],
      },
    ],
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      reason: `${providerName} ${response.status}: ${text.slice(0, 300)}`,
    };
  }
  const json = await response.json();
  const choice = json.choices?.[0]?.message?.content;
  if (typeof choice !== "string") {
    return { ok: false, reason: `${providerName}: no content in response` };
  }
  return { ok: true, text: choice };
}

async function callOpenAi({ imageBase64, userText }) {
  return callOpenAiCompatible({
    endpoint: OPENAI_API,
    apiKey: process.env.OPENAI_API_KEY,
    model: OPENAI_MODEL,
    imageBase64,
    userText,
    providerName: "openai",
  });
}

async function callGroq({ imageBase64, userText }) {
  return callOpenAiCompatible({
    endpoint: GROQ_API,
    apiKey: groqApiKey(),
    model: GROQ_MODEL,
    imageBase64,
    userText,
    providerName: "groq",
  });
}

async function analyzeCapture({ runDir, capture, provider }) {
  const screenshotPath = join(runDir, capture.screenshotRelPath);
  if (!existsSync(screenshotPath)) {
    return {
      ok: false,
      reason: `screenshot missing at ${screenshotPath}`,
      finding: null,
    };
  }
  const imageBytes = await readFile(screenshotPath);
  const imageBase64 = imageBytes.toString("base64");

  const buttonLines = capture.buttons
    .slice(0, 80)
    .map(
      (b) =>
        `- [${b.role}] ${b.text ? `"${b.text.slice(0, 60)}"` : "(no text)"}${
          b.testId ? ` testid=${b.testId}` : ""
        }${b.ariaLabel ? ` aria="${b.ariaLabel.slice(0, 40)}"` : ""}${
          b.disabled ? " disabled" : ""
        }`,
    )
    .join("\n");

  const issueLines = capture.issues
    .slice(0, 30)
    .map((i) => `- ${i.kind}: ${i.detail.slice(0, 200)}`)
    .join("\n");

  const userText = [
    `Route: ${capture.routeId} (${capture.routePath})`,
    `Viewport: ${capture.viewport} (${capture.viewport === "desktop" ? "1440x900" : capture.viewport === "tablet" ? "820x1180" : "390x844"})`,
    `Theme: ${capture.theme}`,
    `Ready check passed: ${capture.readyOk}`,
    `Nav time: ${capture.navMs}ms`,
    "",
    `Button inventory (${capture.buttonCount} visible):`,
    buttonLines || "(none)",
    "",
    `Captured issues (${capture.issues.length}):`,
    issueLines || "(none)",
    "",
    "Review the screenshot and produce findings JSON.",
  ].join("\n");

  let apiResult;
  if (provider === "anthropic") {
    apiResult = await callAnthropic({ imageBase64, userText });
  } else if (provider === "openai") {
    apiResult = await callOpenAi({ imageBase64, userText });
  } else if (provider === "groq") {
    apiResult = await callGroq({ imageBase64, userText });
  } else {
    apiResult = { ok: false, reason: `unknown provider: ${provider}` };
  }
  if (!apiResult.ok) {
    return { ok: false, reason: apiResult.reason, finding: null };
  }
  let parsed;
  try {
    parsed = parseJsonResponse(apiResult.text);
  } catch (error) {
    return {
      ok: false,
      reason: `unparseable JSON: ${error.message}`,
      raw: apiResult.text.slice(0, 1000),
      finding: null,
    };
  }
  return { ok: true, finding: parsed };
}

// --- driver ----------------------------------------------------------------
async function withConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const inflight = new Set();
  async function spawn() {
    if (idx >= items.length) return;
    const myIdx = idx;
    idx += 1;
    const promise = (async () => {
      try {
        results[myIdx] = await worker(items[myIdx], myIdx);
      } catch (error) {
        results[myIdx] = { ok: false, reason: error.message };
      }
    })();
    inflight.add(promise);
    promise.finally(() => {
      inflight.delete(promise);
      spawn();
    });
  }
  const initial = Math.min(limit, items.length);
  for (let i = 0; i < initial; i += 1) spawn();
  while (inflight.size > 0) {
    await Promise.race(inflight);
  }
  return results;
}

async function main() {
  await loadDotEnv();
  const provider = selectVisionProvider();
  if (!provider) {
    console.error(
      "[ai-qa] No vision provider available. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in env or in <repo>/.env or <repo>/../.env",
    );
    process.exit(2);
  }
  const providerModel =
    provider === "anthropic"
      ? MODEL
      : provider === "openai"
        ? OPENAI_MODEL
        : provider === "groq"
          ? GROQ_MODEL
          : "?";
  console.error(`[ai-qa] vision provider: ${provider} (model: ${providerModel})`);
  const args = parseArgs(process.argv.slice(2));
  const runDir = args.runDir
    ? resolve(args.runDir)
    : await findLatestRunDir();
  if (!runDir || !existsSync(runDir)) {
    console.error(`[ai-qa] no run dir found; run capture spec first`);
    process.exit(2);
  }
  console.error(`[ai-qa] analyzing ${runDir}`);
  const all = await listCaptureRecords(runDir);
  let work = all
    .map((entry) => entry.record)
    .filter((r) => r.screenshotRelPath);
  if (args.route) work = work.filter((r) => r.routeId === args.route);
  if (args.viewport) work = work.filter((r) => r.viewport === args.viewport);
  if (args.theme) work = work.filter((r) => r.theme === args.theme);

  console.error(`[ai-qa] ${work.length} captures to analyze`);

  const concurrency = Math.max(1, Number(process.env.AI_QA_CONCURRENCY ?? "3"));
  const findingsRoot = join(runDir, "findings");
  await import("node:fs").then((fs) =>
    fs.promises.mkdir(findingsRoot, { recursive: true }),
  );

  const results = await withConcurrency(work, concurrency, async (capture) => {
    console.error(
      `[ai-qa] analyze ${capture.routeId} ${capture.viewport} ${capture.theme}`,
    );
    const result = await analyzeCapture({ runDir, capture, provider });
    const outPath = join(
      findingsRoot,
      `${capture.routeId}__${capture.viewport}__${capture.theme}.json`,
    );
    await writeFile(
      outPath,
      JSON.stringify(
        {
          routeId: capture.routeId,
          routePath: capture.routePath,
          viewport: capture.viewport,
          theme: capture.theme,
          screenshotRelPath: capture.screenshotRelPath,
          analysisOk: result.ok,
          analysisReason: result.ok ? null : result.reason,
          finding: result.finding,
        },
        null,
        2,
      ),
    );
    return { capture, result };
  });

  // Roll-up. `withConcurrency` returns either `{ capture, result }` from a
  // successful worker call or `{ ok: false, reason }` if the worker itself
  // threw, so unwrap defensively.
  function unwrapResult(r) {
    if (!r) return { ok: false, finding: null };
    if (r.result) return r.result;
    return r; // already in {ok, reason} shape from the catch path
  }
  const summaryPath = join(runDir, "analysis-summary.json");
  await writeFile(
    summaryPath,
    JSON.stringify(
      {
        runId: runDir.split("/").pop(),
        completedAt: new Date().toISOString(),
        totalCaptures: work.length,
        succeeded: results.filter((r) => unwrapResult(r).ok).length,
        failed: results.filter((r) => !unwrapResult(r).ok).length,
        findingCounts: results.reduce(
          (acc, r) => {
            const findings = unwrapResult(r).finding?.findings ?? [];
            for (const f of findings) {
              acc[f.severity] = (acc[f.severity] ?? 0) + 1;
            }
            return acc;
          },
          { P0: 0, P1: 0, P2: 0, P3: 0 },
        ),
      },
      null,
      2,
    ),
  );
  console.error(`[ai-qa] wrote ${summaryPath}`);
}

main().catch((error) => {
  console.error("[ai-qa] fatal:", error);
  process.exit(1);
});
