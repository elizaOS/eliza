/**
 * Comprehensive view-switching verification harness.
 *
 * Runs a fixed matrix of natural-language navigation prompts through an
 * OpenAI-compatible chat-completions endpoint (local llama.cpp `llama-server`
 * OR a cloud provider), constrains the model to the same planner schema the
 * runtime uses ({action, view}), then mirrors `runViewsShow`'s end-to-end
 * landing logic — the deterministic `resolveIntentView` override corrects a
 * wrong/missing model `view` for the known domain surfaces — and scores:
 *
 *   - actionOk     : did the model pick the right action (VIEWS vs REPLY)?
 *   - rawViewOk    : did the model's raw `view` param match expected?
 *   - landedOk     : did the user END UP on the expected view (with correction)?
 *
 * Usage:
 *   MODEL_URL=http://127.0.0.1:8081/v1 MODEL_LABEL=eliza-1-2b \
 *     bun run plugins/plugin-training/scripts/verify-view-switching.ts
 *   MODEL_URL=https://api.anthropic.com/... MODEL_KEY=sk-... MODEL_NAME=claude-... \
 *   MODEL_LABEL=cloud bun run plugins/plugin-training/scripts/verify-view-switching.ts
 *
 * Writes a JSON + HTML report under output/view-switching-verify/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { matchViewCommand } from "../../plugin-app-control/src/actions/view-command-matcher.ts";
import { resolveIntentView } from "../../plugin-app-control/src/actions/views-show.ts";
import { extractPlannerView } from "../src/optimizers/scoring.ts";

// Navigable view ids exposed to the planner (domain surfaces + common builtins).
const VIEW_IDS = [
  "chat", "settings", "calendar", "inbox", "wallet", "finances", "focus",
  "goals", "health", "todos", "documents", "relationships", "companion",
  "task-coordinator", "help", "character", "automations", "none",
] as const;

// The set the deterministic resolveIntentView override knows about — landing on
// these is auto-corrected even when the model picks a wrong view name (this is
// exactly what runViewsShow does at views-show.ts:372-380). Used to mirror
// end-to-end landing.
const REGISTERED = new Set(VIEW_IDS.filter((v) => v !== "none"));

interface Case {
  prompt: string;
  expected: string; // expected landed view id, or "none" for no-nav
  kind: "direct" | "passive" | "contextual" | "multilingual" | "negative";
}

const CASES: Case[] = [
  // direct "open X"
  { prompt: "open settings", expected: "settings", kind: "direct" },
  { prompt: "go to my calendar", expected: "calendar", kind: "direct" },
  { prompt: "open my inbox", expected: "inbox", kind: "direct" },
  { prompt: "show my wallet", expected: "wallet", kind: "direct" },
  { prompt: "open my todos", expected: "todos", kind: "direct" },
  { prompt: "take me to my documents", expected: "documents", kind: "direct" },
  { prompt: "open my goals", expected: "goals", kind: "direct" },
  { prompt: "show my companion", expected: "companion", kind: "direct" },
  // passive intent (no show-verb)
  { prompt: "what's on my schedule today", expected: "calendar", kind: "passive" },
  { prompt: "check my messages", expected: "inbox", kind: "passive" },
  { prompt: "my crypto balance", expected: "wallet", kind: "passive" },
  { prompt: "how much did i spend on subscriptions", expected: "finances", kind: "passive" },
  { prompt: "i need to focus and block distractions", expected: "focus", kind: "passive" },
  { prompt: "how did i sleep last night", expected: "health", kind: "passive" },
  { prompt: "who do i know at acme corp", expected: "relationships", kind: "passive" },
  { prompt: "change my preferences", expected: "settings", kind: "passive" },
  // contextual (situation implies a view)
  { prompt: "i need to fix the login bug in my app", expected: "task-coordinator", kind: "contextual" },
  { prompt: "let's build a new feature for my app", expected: "task-coordinator", kind: "contextual" },
  // multilingual
  { prompt: "muéstrame mi calendario", expected: "calendar", kind: "multilingual" },
  { prompt: "abre mi correo", expected: "inbox", kind: "multilingual" },
  { prompt: "我的钱包", expected: "wallet", kind: "multilingual" },
  // negatives (must NOT navigate)
  { prompt: "what's the weather like today", expected: "none", kind: "negative" },
  { prompt: "tell me a joke", expected: "none", kind: "negative" },
  { prompt: "what is the capital of France", expected: "none", kind: "negative" },
];

const SYSTEM_PROMPT = [
  "You route a user's chat message to an app view, or reply normally.",
  `Available views: ${VIEW_IDS.filter((v) => v !== "none").join(", ")}.`,
  "If the message asks to open/show/go to a view, or the situation clearly calls for one, respond with action VIEWS and the best matching view id.",
  "If it's small talk, a general question, or no view clearly helps, respond with action REPLY and view \"none\".",
  'Respond ONLY as compact JSON: {"action": "VIEWS" or "REPLY", "view": "<one listed view id or none>"}.',
].join("\n");

const PLANNER_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["VIEWS", "REPLY"] },
    view: { type: "string", enum: [...VIEW_IDS] },
  },
  required: ["action", "view"],
  additionalProperties: false,
};

const MODEL_URL = process.env.MODEL_URL ?? "http://127.0.0.1:8081/v1";
const MODEL_LABEL = process.env.MODEL_LABEL ?? "local";
const MODEL_NAME = process.env.MODEL_NAME ?? "eliza-1";
const MODEL_KEY = process.env.MODEL_KEY ?? "sk-no-key";

async function postChat(prompt: string, structured: boolean): Promise<Response> {
  const body: Record<string, unknown> = {
    model: MODEL_NAME,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: 0,
    max_tokens: 60,
    chat_template_kwargs: { enable_thinking: false },
  };
  if (structured) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "planner", schema: PLANNER_SCHEMA, strict: true },
    };
  }
  return fetch(`${MODEL_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${MODEL_KEY}` },
    body: JSON.stringify(body),
  });
}

async function callModel(prompt: string): Promise<{ action: string; view: string; raw: string }> {
  let res = await postChat(prompt, true);
  // Some providers reject json_schema response_format — retry unconstrained and
  // rely on the system-prompt JSON instruction + loose extraction.
  if (!res.ok && (res.status === 400 || res.status === 422)) {
    res = await postChat(prompt, false);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  let action = "REPLY";
  let view = "none";
  try {
    const parsed = JSON.parse(content);
    action = String(parsed.action ?? "REPLY").toUpperCase();
    view = String(parsed.view ?? "none").toLowerCase();
  } catch {
    const ev = extractPlannerView(content);
    if (ev) { view = ev; action = "VIEWS"; }
  }
  return { action, view, raw: content };
}

// Mirror the full 3-stage cascade end-to-end landing:
//  1. EARLY hook (viewCommandShortcutEvaluator): a rigid matchViewCommand hit
//     FORCES the VIEWS action regardless of what the model chose — so explicit
//     commands land deterministically, model strength irrelevant.
//  2. ACTION: if the model engaged VIEWS, land on resolveIntentView(prompt) (it
//     wraps matchViewCommand) or the model's view param.
// Contextual intent with no rigid match that the model REPLYs to would be
// caught by the POST evaluator (small model) — not simulated here.
function landedView(prompt: string, action: string, modelView: string): string {
  // EARLY hook fires on any deterministic resolveIntentView match (rigid
  // command OR passive keyword intent), forcing VIEWS model-independently.
  const deterministic = resolveIntentView(prompt);
  if (deterministic && REGISTERED.has(deterministic)) return deterministic;
  if (action !== "VIEWS") return "none";
  if (REGISTERED.has(modelView)) return modelView;
  return "none";
}

async function main() {
  console.log(`[verify] model=${MODEL_LABEL} url=${MODEL_URL} name=${MODEL_NAME}`);
  const rows: Array<{
    c: Case; action: string; modelView: string; landed: string;
    actionOk: boolean; rawViewOk: boolean; landedOk: boolean; err?: string;
  }> = [];
  for (const c of CASES) {
    try {
      const { action, view } = await callModel(c.prompt);
      const landed = landedView(c.prompt, action, view);
      const expectNav = c.expected !== "none";
      const actionOk = expectNav ? action === "VIEWS" : action === "REPLY";
      const rawViewOk = expectNav ? view === c.expected : (action === "REPLY" || view === "none");
      const landedOk = landed === c.expected;
      rows.push({ c, action, modelView: view, landed, actionOk, rawViewOk, landedOk });
      console.log(`  [${landedOk ? "PASS" : "FAIL"}] ${c.kind.padEnd(12)} "${c.prompt}" → action=${action} view=${view} landed=${landed} (want ${c.expected})`);
    } catch (e) {
      rows.push({ c, action: "ERR", modelView: "", landed: "", actionOk: false, rawViewOk: false, landedOk: false, err: String(e) });
      console.log(`  [ERR ] ${c.prompt}: ${e}`);
    }
  }
  const n = rows.length;
  const sum = (k: "actionOk" | "rawViewOk" | "landedOk") => rows.filter((r) => r[k]).length;
  const summary = {
    model: MODEL_LABEL, modelName: MODEL_NAME, url: MODEL_URL, total: n,
    actionAccuracy: sum("actionOk") / n,
    rawViewAccuracy: sum("rawViewOk") / n,
    landedAccuracy: sum("landedOk") / n,
  };
  console.log(`\n[verify] ${MODEL_LABEL}: action ${sum("actionOk")}/${n} | rawView ${sum("rawViewOk")}/${n} | LANDED ${sum("landedOk")}/${n}`);

  const outDir = path.join(process.cwd(), "output", "view-switching-verify");
  mkdirSync(outDir, { recursive: true });
  const stamp = MODEL_LABEL.replace(/[^a-z0-9_-]/gi, "_");
  writeFileSync(path.join(outDir, `report-${stamp}.json`), JSON.stringify({ summary, rows: rows.map((r) => ({ ...r.c, action: r.action, modelView: r.modelView, landed: r.landed, actionOk: r.actionOk, rawViewOk: r.rawViewOk, landedOk: r.landedOk, err: r.err })) }, null, 2));
  const html = `<!doctype html><meta charset=utf8><title>view-switching ${MODEL_LABEL}</title>
<style>body{font:14px system-ui;margin:24px;background:#111;color:#eee}table{border-collapse:collapse;width:100%}td,th{border:1px solid #333;padding:6px 8px;text-align:left}.pass{color:#3c3}.fail{color:#f55}h1{font-size:18px}code{background:#222;padding:1px 4px;border-radius:3px}</style>
<h1>View-switching verification — ${MODEL_LABEL} (${MODEL_NAME})</h1>
<p>Landed: <b>${sum("landedOk")}/${n}</b> (${(summary.landedAccuracy * 100).toFixed(0)}%) · Action: ${sum("actionOk")}/${n} · Raw view: ${sum("rawViewOk")}/${n}</p>
<table><tr><th>kind</th><th>prompt</th><th>expected</th><th>action</th><th>model view</th><th>landed</th><th>result</th></tr>
${rows.map((r) => `<tr><td>${r.c.kind}</td><td><code>${r.c.prompt}</code></td><td>${r.c.expected}</td><td>${r.action}</td><td>${r.modelView}</td><td>${r.landed}</td><td class=${r.landedOk ? "pass" : "fail"}>${r.landedOk ? "PASS" : "FAIL"}${r.err ? " " + r.err : ""}</td></tr>`).join("\n")}
</table>`;
  writeFileSync(path.join(outDir, `report-${stamp}.html`), html);
  console.log(`[verify] wrote output/view-switching-verify/report-${stamp}.{json,html}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
