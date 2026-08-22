/**
 * Generates measurable acceptance criteria for durable orchestrator tasks.
 * Static task-type templates provide the model-free fallback, while optional
 * model refinement specializes them without weakening validation. Goal
 * contracts are enabled unless `ELIZA_REQUIRE_GOAL_CONTRACT=0`.
 */

import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { parseJsonObjectResponse } from "./json-model-output.js";
import {
  stripInventedArtifactCriteria,
  stripUncollectableEvidenceCriteria,
} from "./producible-evidence.js";

/** Coarse task classification driving which template set is applied. */
export type OrchestratorTaskType =
  | "coding"
  | "script-run"
  | "view-create"
  | "app-build"
  | "deploy";

/** Lower bound the issue calls for: a generated set always has ≥3 criteria. */
const MIN_CRITERIA = 3;
/** Upper bound so the verifier prompt stays cheap and focused. */
const MAX_CRITERIA = 5;
/** Per-criterion length cap so a runaway model line can't bloat the record. */
const MAX_CRITERION_CHARS = 240;
/** A goal shorter than this is treated as trivial — no criteria generated. */
const MIN_GOAL_CHARS = 8;

/**
 * The base coding criteria. Every "build something in the repo" task type
 * extends this set; app-build deliberately does NOT inherit it (see the
 * template comment below).
 */
const CODING_CRITERIA: readonly string[] = [
  "typecheck passes",
  "lint passes",
  "tests pass",
  "the change is summarized in the diff",
];

/**
 * Static criteria templates keyed by task type. Each set is intentionally
 * measurable (a verifier can grill each line against concrete evidence) and
 * each set is DISTINCT so a misclassified task still gets useful, type-shaped
 * criteria rather than the generic coding default.
 */
export const DEFAULT_CRITERIA_TEMPLATES: Readonly<
  Record<OrchestratorTaskType, readonly string[]>
> = {
  coding: CODING_CRITERIA,
  // Serve-focused on purpose (#20794 live residual): a quick one-file app has
  // no test/typecheck surface, so inheriting the coding checks manufactured
  // criteria NO static deliverable could ever satisfy and burned every verify
  // attempt. A goal that genuinely involves code checks says so, and the model
  // refinement adds them back from the goal text.
  "app-build": [
    "the live URL is reachable",
    "the deliverable file exists in the workdir",
    "the page serves the requested content",
  ],
  // One-shot "write a script and run it" asks: the deliverable is the RUN
  // OUTPUT, not a maintained codebase. The coding template's lint/test-suite
  // demands parked a two-tool write+run task whose script worked on the first
  // try (live 2026-08-20: prime-numbers ask, three verify attempts burned on
  // "a test suite passes").
  "script-run": [
    "the script file exists in the workdir",
    "the script runs to completion without errors",
    "the captured run output contains the requested result",
  ],
  "view-create": [
    "a Plugin.views entry is declared with a viewKind",
    "the view appears in /api/views",
    "a screenshot of the working view is attached",
  ],
  deploy: [
    "the deployment target is reachable (non-loopback URL returns 200)",
    "rollback/undo path is documented",
    "the deploy command/log output shows a successful, non-errored run",
  ],
};

/**
 * Whether the orchestrator auto-generates default acceptance criteria for a
 * criteria-free task so the verifier always fires. Default ON; set
 * `ELIZA_REQUIRE_GOAL_CONTRACT=0` to disable (a criteria-free task then stays
 * criteria-free and behaves exactly as before). Mirrors the
 * {@link shouldAutoVerifyGoal} flag convention.
 */
export function shouldRequireGoalContract(): boolean {
  return process.env.ELIZA_REQUIRE_GOAL_CONTRACT !== "0";
}

/** Keyword groups feeding {@link detectTaskType}. Ordered most-specific-first
 *  so a goal that matches several groups gets the narrower classification. */
// "write/make a <lang> script … and run it" (or "run it for me"): a compute
// deliverable judged by its output. A creation verb directly before the
// script noun also qualifies — "write me a python script that picks a random
// dinner idea" is the same one-shot deliverable even without a run verb, and
// classifying it coding parked a working script on invented lint/test-suite
// criteria (live 2026-08-20). "add a build script to package.json" stays
// coding: "add" is not a creation-of-deliverable verb here.
const SCRIPT_RUN_RE =
  /\b(?:script|one[- ]?liner)\b[\s\S]{0,80}\b(?:run|execute)\b|\b(?:run|execute)\b[\s\S]{0,40}\bscript\b|\b(?:write|make|create)\b(?:\s+\w+){0,4}?\s+(?:script|one[- ]?liner)\b/i;

const VIEW_RE =
  /\b(view|views|viewkind|widget|dashboard\s+(?:card|panel|tile)|render\s+a\s+view)\b/i;
const DEPLOY_RE =
  /\b(deploy|deployment|release\s+to\s+prod|ship\s+to\s+prod|production\s+rollout|provision\s+infra|autoscal\w*|hetzner|cloudflare\s+worker|publish\s+the\s+(?:site|app))\b/i;
// Deliberately does NOT match a bare "app"/"application": "refactor the app" or
// "fix the application startup" is coding, not an app-BUILD. Only web-app /
// site / landing-page phrasing — or an explicit build/create/make-a(n)-…-app —
// qualifies, which is what gates the app-build-only live-URL criterion. The
// verb branch accepts "a" OR "an" plus up to two
// intervening words so canonical phrasing like "build an app" and
// "create a checklist app" classifies correctly (a bare `build\s+a\s+app` never
// matches grammatical English and silently regressed those to coding).
// The trailing alternative catches verb-less goals that are just a noun
// phrase ending in page/site ("quote generator page" — the planner's task
// title became the goal and classified coding, resurrecting the diff-summary
// criterion on a slug-dir app, live 2026-08-19).
const APP_BUILD_RE =
  /\b(website|web\s*site|web\s?page|landing\s+page|web\s+app|webapp|frontend\s+app|(?:build|create|make)\s+(?:me\s+)?an?\s+(?:[\w'-]+[ -]){0,5}(?:site|page|app|application)\b|^[\w'’-]+(?:\s+[\w'’-]+){0,5}\s+(?:page|site|webpage)\s*$)/im;

/**
 * Classify a task from its goal text. Defaults to `coding` — the safest
 * superset, since every other type extends or specializes the coding checks.
 * Pure and deterministic so the static path is fully testable without a model.
 */
// File names and paths are not intent: "/etc/nubs-deploy-settings.yaml"
// classified a read-a-config script as a DEPLOY task (deploy criteria, two
// lanes, live 2026-08-22). Strip path-like tokens before the keyword groups.
const PATH_TOKEN_RE =
  /(?:(?:\/|~\/|\.\/|[A-Za-z]:\\)[\w.\\/-]+)|\b[\w-]+\.(?:ya?ml|json|csv|tsv|txt|toml|ini|cfg|conf|xml|env|log|md|db|sqlite3?|py|js|ts|sh|html|css)\b/gi;

export function detectTaskType(goal: string): OrchestratorTaskType {
  const text = (goal ?? "").replace(PATH_TOKEN_RE, " ").trim();
  if (text.length === 0) return "coding";
  // View creation is the most specific signal — check it first.
  if (VIEW_RE.test(text)) return "view-create";
  if (DEPLOY_RE.test(text)) return "deploy";
  if (APP_BUILD_RE.test(text)) return "app-build";
  if (SCRIPT_RUN_RE.test(text)) return "script-run";
  return "coding";
}

/** Whether a goal is substantive enough to warrant generated criteria. A blank
 *  or near-blank goal gets none (the caller leaves criteria empty). */
export function isNonTrivialGoal(goal: string): boolean {
  return (goal ?? "").trim().length >= MIN_GOAL_CHARS;
}

/** Normalize, de-dupe, length-cap and bound a candidate criteria list to the
 *  [MIN, MAX] window, topping up from the static fallback when the model
 *  returned too few usable lines. Always returns ≥{@link MIN_CRITERIA} when the
 *  fallback set itself has that many. */
function normalizeCriteria(
  candidates: readonly string[],
  fallback: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string): void => {
    const trimmed = raw.trim().slice(0, MAX_CRITERION_CHARS).trim();
    if (trimmed.length === 0) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  for (const candidate of candidates) {
    if (out.length >= MAX_CRITERIA) break;
    push(candidate);
  }
  // Top up to the minimum from the static fallback if the model was stingy.
  for (const item of fallback) {
    if (out.length >= MIN_CRITERIA) break;
    push(item);
  }
  return out.slice(0, MAX_CRITERIA);
}

/**
 * The static, model-free criteria for a goal. Always returns the template set
 * for the detected (or hinted) task type — the deterministic fallback that
 * {@link generateDefaultAcceptanceCriteria} returns whenever the model path is
 * unavailable or fails.
 */
export function staticAcceptanceCriteria(
  goal: string,
  taskTypeHint?: OrchestratorTaskType,
): string[] {
  const type = taskTypeHint ?? detectTaskType(goal);
  return [...DEFAULT_CRITERIA_TEMPLATES[type]];
}

/** Build the refinement prompt: hand the model the goal + the static template
 *  and ask it to return 3-5 concrete, measurable criteria as a JSON object. */
function buildRefinePrompt(
  goal: string,
  type: OrchestratorTaskType,
  template: readonly string[],
): string {
  return [
    "You are setting the acceptance criteria a coding sub-agent must PROVE before its task is accepted.",
    "Turn the goal below into 3-5 concrete, measurable, independently-verifiable criteria.",
    "Each criterion must be checkable from concrete evidence (a passing build/test/typecheck line, a diff hunk, a reachable URL, a screenshot) — never a vague aspiration.",
    "NEVER invent concrete file paths, filenames, or directory names the goal does not state verbatim — the worker legitimately chooses its own layout. When the goal names no path, express the criterion as an observable outcome (a file exists in the workdir, a URL serves the requested content).",
    "",
    `Detected task type: ${type}`,
    "Goal:",
    goal.trim() || "(no goal text)",
    "",
    "Baseline criteria for this task type (keep the ones that still apply, specialize them to the goal, and add any goal-specific ones):",
    template.map((c, i) => `${i + 1}. ${c}`).join("\n"),
    "",
    'Respond with a SINGLE JSON object and nothing else, no markdown fences. Schema: { "criteria": ["<criterion>", "<criterion>", ...] }',
    `Return between ${MIN_CRITERIA} and ${MAX_CRITERIA} criteria.`,
  ].join("\n");
}

/** Pull a string[] from the parsed model object, tolerating the common shapes
 *  a small model produces ({criteria:[…]} or a bare array under another key). */
function extractCriteriaArray(parsed: Record<string, unknown>): string[] {
  const direct = parsed.criteria;
  const source = Array.isArray(direct)
    ? direct
    : (Object.values(parsed).find((value): value is unknown[] =>
        Array.isArray(value),
      ) ?? []);
  return source
    .map((entry) => (typeof entry === "string" ? entry : ""))
    .filter((entry) => entry.length > 0);
}

/**
 * Generate default acceptance criteria for a goal.
 *
 * - When `runtime` exposes `useModel`, attempts ONE cheap
 *   `ModelType.TEXT_SMALL` refinement of the static template into concrete,
 *   measurable criteria. The call is fully defensive: any failure (missing
 *   `useModel`, throw, unparseable / empty response, too-few usable lines)
 *   falls back to the static template — it NEVER throws.
 * - When `runtime` is omitted, returns the static template directly (the
 *   deterministic path the unit tests pin).
 *
 * Always returns ≥{@link MIN_CRITERIA} criteria for a non-trivial goal.
 */
export async function generateDefaultAcceptanceCriteria(
  goal: string,
  taskTypeHint?: OrchestratorTaskType,
  runtime?: IAgentRuntime,
): Promise<string[]> {
  const type = taskTypeHint ?? detectTaskType(goal);
  const fallback = [...DEFAULT_CRITERIA_TEMPLATES[type]];

  // Static app builds keep the deterministic serve-focused template with NO
  // model refine: every refine pass invented runtime-behavior demands in new
  // phrasings ("browser console shows zero errors", "interaction updates the
  // DOM", "timer changes its value") that no headless pipeline can evidence,
  // and each parked a live, working page (2026-08-19, four distinct parks).
  // The template criteria — reachable URL, files on disk, served content —
  // are exactly what the evidence pipeline can prove.
  if (type === "app-build") return fallback;
  // Same purity rule for script-run: refinement re-invents the lint/test-suite
  // demands the template exists to avoid.
  if (type === "script-run") return fallback;

  if (!runtime || typeof runtime.useModel !== "function") return fallback;

  try {
    const prompt = buildRefinePrompt(goal, type, fallback);
    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      stopSequences: [],
    });
    const raw = typeof result === "string" ? result : String(result ?? "");
    const parsed = parseJsonObjectResponse(raw);
    if (!parsed) return fallback;
    const candidates = extractCriteriaArray(parsed);
    if (candidates.length === 0) return fallback;
    // The prompt forbids invented paths, but the filter is the enforcement:
    // a criterion pinning a path the goal never named is unsatisfiable by
    // design (#20794), so it is dropped and the template tops the set back up.
    const producible = stripUncollectableEvidenceCriteria(
      stripInventedArtifactCriteria(candidates, goal).kept,
      type,
    ).kept;
    const refined = normalizeCriteria(producible, fallback);
    return refined.length >= MIN_CRITERIA ? refined : fallback;
  } catch {
    // error-policy:J4 optional model refinement of an external dep; any failure degrades to the designed deterministic static template
    // Defensive: criteria generation must never break task creation.
    return fallback;
  }
}
