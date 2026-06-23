/**
 * Default acceptance-criteria generation (#8896).
 *
 * When a task is created with no acceptance criteria, automatic verification
 * never fires (`autoVerifyCompletion` returns early on an empty list), so a
 * sub-agent's "done" is taken on faith. This module supplies sensible,
 * task-kind-specific default criteria so verification always has something
 * concrete to check.
 *
 * Deterministic + template-based on purpose: defaults must be stable, instant,
 * and dependency-free (no model call on the task-creation hot path).
 */

/**
 * Whether to auto-fill default acceptance criteria for criteria-less tasks.
 * On by default; set `ELIZA_REQUIRE_GOAL_CONTRACT=0` to opt out.
 */
export function shouldRequireGoalContract(): boolean {
  return process.env.ELIZA_REQUIRE_GOAL_CONTRACT !== "0";
}

/** Criteria every code-touching task should satisfy before it claims done. */
const BASE_CODING_CRITERIA: readonly string[] = [
  "The change typechecks (no new type errors).",
  "Lint/format passes on the touched files.",
  "Relevant tests pass (and new behavior has a test).",
  "The diff is coherent and scoped to the goal — no unrelated edits.",
];

/** Extra criteria keyed by task kind, appended to the base set. */
const KIND_EXTRA_CRITERIA: Record<string, readonly string[]> = {
  "app-build": ["The built app serves and a smoke request returns HTTP 200."],
  "view-create": [
    "The new view is registered and appears in GET /api/views.",
    "A screenshot of the rendered view is captured.",
  ],
  deploy: ["The deployed target is reachable and healthy after rollout."],
};

/**
 * Build default acceptance criteria for a task that was created without any.
 * Returns the base coding criteria plus any kind-specific extras. The `goal`
 * is currently unused by the templates but kept in the signature so a future
 * model-assisted variant can specialize without a call-site change.
 */
export function buildDefaultAcceptanceCriteria(
  _goal: string,
  kind?: string,
): string[] {
  const extra = kind ? (KIND_EXTRA_CRITERIA[kind] ?? []) : [];
  return [...BASE_CODING_CRITERIA, ...extra];
}
