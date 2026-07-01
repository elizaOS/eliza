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
import { fileURLToPath } from "node:url";
import { resolveIntentView } from "../../plugin-app-control/src/actions/views-show.ts";
import { extractPlannerView } from "../src/optimizers/scoring.ts";

// Navigable view ids exposed to the planner (domain surfaces + common builtins).
const VIEW_IDS = [
  "chat",
  "settings",
  "calendar",
  "inbox",
  "wallet",
  "finances",
  "focus",
  "goals",
  "health",
  "todos",
  "documents",
  "relationships",
  "task-coordinator",
  "help",
  "character",
  "automations",
  "none",
] as const;

// The set the deterministic resolveIntentView override knows about — landing on
// these is auto-corrected even when the model picks a wrong view name (this is
// exactly what runViewsShow does at views-show.ts:372-380). Used to mirror
// end-to-end landing.
const REGISTERED = new Set(VIEW_IDS.filter((v) => v !== "none"));

// Input modality the prompt arrives over. Today every case is typed `text`;
// `voice` exists so transcribed/dictated prompts can be tracked separately in
// the grid without changing the scoring path.
type Modality = "text" | "voice";

interface Case {
  prompt: string;
  expected: string; // expected landed view id, or "none" for no-nav
  kind: "direct" | "passive" | "contextual" | "multilingual" | "negative";
  // Grid axes. `view` defaults to `expected`, `language` to "en", `modality` to
  // "text" when omitted; multilingual cases carry an explicit BCP-47 language.
  view?: string;
  language?: string;
  modality?: Modality;
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
  // passive intent (no show-verb)
  {
    prompt: "what's on my schedule today",
    expected: "calendar",
    kind: "passive",
  },
  { prompt: "check my messages", expected: "inbox", kind: "passive" },
  { prompt: "my crypto balance", expected: "wallet", kind: "passive" },
  {
    prompt: "how much did i spend on subscriptions",
    expected: "finances",
    kind: "passive",
  },
  {
    prompt: "i need to focus and block distractions",
    expected: "focus",
    kind: "passive",
  },
  { prompt: "how did i sleep last night", expected: "health", kind: "passive" },
  {
    prompt: "who do i know at acme corp",
    expected: "relationships",
    kind: "passive",
  },
  { prompt: "change my preferences", expected: "settings", kind: "passive" },
  // contextual (situation implies a view)
  {
    prompt: "i need to fix the login bug in my app",
    expected: "task-coordinator",
    kind: "contextual",
  },
  {
    prompt: "let's build a new feature for my app",
    expected: "task-coordinator",
    kind: "contextual",
  },
  // multilingual
  {
    prompt: "muéstrame mi calendario",
    expected: "calendar",
    kind: "multilingual",
    language: "es",
  },
  {
    prompt: "abre mi correo",
    expected: "inbox",
    kind: "multilingual",
    language: "es",
  },
  {
    prompt: "我的钱包",
    expected: "wallet",
    kind: "multilingual",
    language: "zh",
  },
  // negatives (must NOT navigate)
  {
    prompt: "what's the weather like today",
    expected: "none",
    kind: "negative",
  },
  { prompt: "tell me a joke", expected: "none", kind: "negative" },
  {
    prompt: "what is the capital of France",
    expected: "none",
    kind: "negative",
  },
];

// Resolve the grid axes for a case, applying the documented defaults.
function caseView(c: Case): string {
  return c.view ?? c.expected;
}
function caseLanguage(c: Case): string {
  return c.language ?? "en";
}
function caseModality(c: Case): Modality {
  return c.modality ?? "text";
}

const SYSTEM_PROMPT = [
  "You route a user's chat message to an app view, or reply normally.",
  `Available views: ${VIEW_IDS.filter((v) => v !== "none").join(", ")}.`,
  "If the message asks to open/show/go to a view, or the situation clearly calls for one, respond with action VIEWS and the best matching view id.",
  'If it\'s small talk, a general question, or no view clearly helps, respond with action REPLY and view "none".',
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

async function postChat(
  prompt: string,
  structured: boolean,
): Promise<Response> {
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
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${MODEL_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

async function callModel(
  prompt: string,
): Promise<{ action: string; view: string; raw: string }> {
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
    if (ev) {
      view = ev;
      action = "VIEWS";
    }
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

export type GridStatus = "pass" | "fail" | "absent";

// Minimal row shape the grid cross-tabulates over. The verify harness rows are
// a superset of this; tests build the fixture directly from this interface.
export interface GridRow {
  view: string;
  language: string;
  modality: string;
  landedOk: boolean;
}

export interface GridCell {
  view: string;
  language: string;
  modality: string;
  status: GridStatus;
}

export interface ResultGrid {
  views: string[];
  languages: string[];
  modalities: string[];
  // grid[view][language][modality] -> "pass" | "fail" | "absent". A combo with
  // no row is "absent"; a combo with any failing row is "fail" (fail dominates).
  grid: Record<string, Record<string, Record<string, GridStatus>>>;
  cells: GridCell[];
}

// Pure, model-free cross-tabulation of result rows into a per-(view, language,
// modality) pass/fail grid. Every (view × language × modality) combination that
// appears across the axes gets a cell: "absent" when no row covers it, "fail"
// when any covering row failed, otherwise "pass".
export function buildResultGrid(rows: GridRow[]): ResultGrid {
  const uniqueSorted = (values: string[]): string[] =>
    [...new Set(values)].sort();
  const views = uniqueSorted(rows.map((r) => r.view));
  const languages = uniqueSorted(rows.map((r) => r.language));
  const modalities = uniqueSorted(rows.map((r) => r.modality));

  const grid: Record<string, Record<string, Record<string, GridStatus>>> = {};
  const cells: GridCell[] = [];
  for (const view of views) {
    grid[view] = {};
    for (const language of languages) {
      grid[view][language] = {};
      for (const modality of modalities) {
        const covering = rows.filter(
          (r) =>
            r.view === view &&
            r.language === language &&
            r.modality === modality,
        );
        const status: GridStatus =
          covering.length === 0
            ? "absent"
            : covering.every((r) => r.landedOk)
              ? "pass"
              : "fail";
        grid[view][language][modality] = status;
        cells.push({ view, language, modality, status });
      }
    }
  }
  return { views, languages, modalities, grid, cells };
}

// Accuracy summary the gate scores against. `landedAccuracy` is always present;
// `directAccuracy` (direct "open X" commands) and `negativeControlPrecision`
// (negatives that correctly did NOT navigate) are cheaply derivable from the
// run and let the gate guard the two most regression-prone axes.
export interface AccuracySummary {
  total: number;
  landedAccuracy: number;
  directAccuracy?: number;
  negativeControlPrecision?: number;
}

// Floors are opt-in: a metric is only gated when its floor is a finite number.
export interface AccuracyFloors {
  minLandedAccuracy?: number;
  minDirectAccuracy?: number;
  minNegativeControlPrecision?: number;
}

// Pure, model-free accuracy gate. Compares the run's accuracy metrics against
// the provided floors and returns whether every gated metric cleared its floor,
// plus a human-readable failure list. A metric with no floor (or a non-finite
// floor) is not gated. With no floors at all the gate always passes (opt-in).
export function evaluateAccuracyGate(
  summary: AccuracySummary,
  floors: AccuracyFloors,
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  const check = (
    label: string,
    actual: number | undefined,
    floor: number | undefined,
  ): void => {
    if (floor === undefined || !Number.isFinite(floor)) return;
    if (actual === undefined || !Number.isFinite(actual)) {
      failures.push(`${label}: no value to compare against floor ${floor}`);
      return;
    }
    if (actual < floor) {
      failures.push(
        `${label} ${(actual * 100).toFixed(1)}% below floor ${(floor * 100).toFixed(1)}%`,
      );
    }
  };
  check("landedAccuracy", summary.landedAccuracy, floors.minLandedAccuracy);
  check("directAccuracy", summary.directAccuracy, floors.minDirectAccuracy);
  check(
    "negativeControlPrecision",
    summary.negativeControlPrecision,
    floors.minNegativeControlPrecision,
  );
  return { pass: failures.length === 0, failures };
}

// Read opt-in accuracy floors from the environment. A metric is only gated when
// its env var parses to a finite number.
function readAccuracyFloors(env: NodeJS.ProcessEnv): AccuracyFloors {
  const num = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === "") return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    minLandedAccuracy: num(env.MIN_LANDED_ACCURACY),
    minDirectAccuracy: num(env.MIN_DIRECT_ACCURACY),
    minNegativeControlPrecision: num(env.MIN_NEGATIVE_CONTROL_PRECISION),
  };
}

// True when at least one floor is configured.
function anyFloorConfigured(floors: AccuracyFloors): boolean {
  return (
    floors.minLandedAccuracy !== undefined ||
    floors.minDirectAccuracy !== undefined ||
    floors.minNegativeControlPrecision !== undefined
  );
}

async function main() {
  console.log(
    `[verify] model=${MODEL_LABEL} url=${MODEL_URL} name=${MODEL_NAME}`,
  );
  const rows: Array<{
    c: Case;
    action: string;
    modelView: string;
    landed: string;
    actionOk: boolean;
    rawViewOk: boolean;
    landedOk: boolean;
    err?: string;
  }> = [];
  for (const c of CASES) {
    try {
      const { action, view } = await callModel(c.prompt);
      const landed = landedView(c.prompt, action, view);
      const expectNav = c.expected !== "none";
      const actionOk = expectNav ? action === "VIEWS" : action === "REPLY";
      const rawViewOk = expectNav
        ? view === c.expected
        : action === "REPLY" || view === "none";
      const landedOk = landed === c.expected;
      rows.push({
        c,
        action,
        modelView: view,
        landed,
        actionOk,
        rawViewOk,
        landedOk,
      });
      console.log(
        `  [${landedOk ? "PASS" : "FAIL"}] ${c.kind.padEnd(12)} "${c.prompt}" → action=${action} view=${view} landed=${landed} (want ${c.expected})`,
      );
    } catch (e) {
      rows.push({
        c,
        action: "ERR",
        modelView: "",
        landed: "",
        actionOk: false,
        rawViewOk: false,
        landedOk: false,
        err: String(e),
      });
      console.log(`  [ERR ] ${c.prompt}: ${e}`);
    }
  }
  const n = rows.length;
  const sum = (k: "actionOk" | "rawViewOk" | "landedOk") =>
    rows.filter((r) => r[k]).length;
  // Per-kind accuracy on the two most regression-prone axes: direct "open X"
  // commands (must land) and negatives (must NOT navigate).
  const accuracyOver = (predicate: (r: (typeof rows)[number]) => boolean) => {
    const subset = rows.filter(predicate);
    return subset.length === 0
      ? undefined
      : subset.filter((r) => r.landedOk).length / subset.length;
  };
  const directAccuracy = accuracyOver((r) => r.c.kind === "direct");
  const negativeControlPrecision = accuracyOver((r) => r.c.kind === "negative");
  const summary = {
    model: MODEL_LABEL,
    modelName: MODEL_NAME,
    url: MODEL_URL,
    total: n,
    actionAccuracy: sum("actionOk") / n,
    rawViewAccuracy: sum("rawViewOk") / n,
    landedAccuracy: sum("landedOk") / n,
    directAccuracy,
    negativeControlPrecision,
  };
  console.log(
    `\n[verify] ${MODEL_LABEL}: action ${sum("actionOk")}/${n} | rawView ${sum("rawViewOk")}/${n} | LANDED ${sum("landedOk")}/${n}`,
  );

  const grid = buildResultGrid(
    rows.map((r) => ({
      view: caseView(r.c),
      language: caseLanguage(r.c),
      modality: caseModality(r.c),
      landedOk: r.landedOk,
    })),
  );

  const outDir = path.join(process.cwd(), "output", "view-switching-verify");
  mkdirSync(outDir, { recursive: true });
  const stamp = MODEL_LABEL.replace(/[^a-z0-9_-]/gi, "_");
  writeFileSync(
    path.join(outDir, `report-${stamp}.json`),
    JSON.stringify(
      {
        summary,
        rows: rows.map((r) => ({
          ...r.c,
          action: r.action,
          modelView: r.modelView,
          landed: r.landed,
          actionOk: r.actionOk,
          rawViewOk: r.rawViewOk,
          landedOk: r.landedOk,
          err: r.err,
        })),
        grid,
      },
      null,
      2,
    ),
  );
  const gridCols = grid.languages.flatMap((language) =>
    grid.modalities.map((modality) => ({ language, modality })),
  );
  const gridSym: Record<GridStatus, string> = {
    pass: "✓",
    fail: "✗",
    absent: "·",
  };
  const gridTable = `<h2>Grid — view × language × modality</h2>
<table class=grid><tr><th>view</th>${gridCols.map((col) => `<th>${col.language}·${col.modality}</th>`).join("")}</tr>
${grid.views
  .map(
    (view) =>
      `<tr><td>${view}</td>${gridCols
        .map((col) => {
          const s = grid.grid[view][col.language][col.modality];
          return `<td class=${s} title="${view} / ${col.language} / ${col.modality}: ${s}">${gridSym[s]}</td>`;
        })
        .join("")}</tr>`,
  )
  .join("\n")}
</table>`;
  const html = `<!doctype html><meta charset=utf8><title>view-switching ${MODEL_LABEL}</title>
<style>body{font:14px system-ui;margin:24px;background:#111;color:#eee}table{border-collapse:collapse;width:100%;margin-bottom:24px}td,th{border:1px solid #333;padding:6px 8px;text-align:left}.pass{color:#3c3}.fail{color:#f55}.absent{color:#777}table.grid td{text-align:center}h1{font-size:18px}h2{font-size:15px}code{background:#222;padding:1px 4px;border-radius:3px}</style>
<h1>View-switching verification — ${MODEL_LABEL} (${MODEL_NAME})</h1>
<p>Landed: <b>${sum("landedOk")}/${n}</b> (${(summary.landedAccuracy * 100).toFixed(0)}%) · Action: ${sum("actionOk")}/${n} · Raw view: ${sum("rawViewOk")}/${n}</p>
${gridTable}
<table><tr><th>kind</th><th>prompt</th><th>expected</th><th>action</th><th>model view</th><th>landed</th><th>result</th></tr>
${rows.map((r) => `<tr><td>${r.c.kind}</td><td><code>${r.c.prompt}</code></td><td>${r.c.expected}</td><td>${r.action}</td><td>${r.modelView}</td><td>${r.landed}</td><td class=${r.landedOk ? "pass" : "fail"}>${r.landedOk ? "PASS" : "FAIL"}${r.err ? ` ${r.err}` : ""}</td></tr>`).join("\n")}
</table>`;
  writeFileSync(path.join(outDir, `report-${stamp}.html`), html);
  console.log(
    `[verify] wrote output/view-switching-verify/report-${stamp}.{json,html}`,
  );

  // Opt-in accuracy gate. A model regression must fail the script — but only
  // when a floor is configured AND a model endpoint was actually reached (the
  // run produced at least one non-error result). Ad-hoc runs with no floor, and
  // runs that never reached an endpoint, never fail here.
  const floors = readAccuracyFloors(process.env);
  if (anyFloorConfigured(floors)) {
    const reached = rows.some((r) => r.action !== "ERR");
    if (!reached) {
      console.warn(
        "[verify] accuracy floors set but no model endpoint was reached — skipping gate",
      );
      return;
    }
    const gate = evaluateAccuracyGate(summary, floors);
    if (!gate.pass) {
      console.error(
        `[verify] accuracy gate FAILED:\n${gate.failures.map((f) => `  - ${f}`).join("\n")}`,
      );
      process.exit(1);
    }
    console.log("[verify] accuracy gate passed");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
