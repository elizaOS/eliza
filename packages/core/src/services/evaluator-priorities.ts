/**
 * Canonical evaluator + processor priorities.
 *
 * Lower runs first inside `EvaluatorService.run` after the unified LLM call
 * returns. The ordering reflects data dependencies between evaluators:
 *
 *  1. FORM        — apply form intents/extractions first; the rest of
 *                   the response shape may depend on the resulting session
 *                   state.
 *  2. REFLECTION  — facts → relationships → identity → success.
 *                   Facts are written first so identity / success can read
 *                   the freshly extracted state. Relationships reference
 *                   the entities those facts attach to.
 *  3. MEMORY      — summary then long-term. Summary is rolling text;
 *                   long-term may incorporate items the summary just merged.
 *  4. EXPERIENCE  — the agent's self-knowledge, distilled from facts and
 *                   relationships already extracted by reflection.
 *  5. SKILL       — proposal / refinement on the just-completed trajectory.
 *                   Runs last because skill files are the most expensive
 *                   side effect and the trajectory must be in stable state.
 *
 * Numbers are spaced by 10s so adjacent additions don't require a re-number.
 */
export const EvaluatorPriority = {
	// Form state mutations come first — downstream evaluators may want to see
	// the post-update form session.
	FORM: 50,

	// Reflection group: ordered by dependency (facts before identity, etc.).
	REFLECTION_FACTS: 100,
	REFLECTION_RELATIONSHIPS: 110,
	REFLECTION_IDENTITY: 120,
	REFLECTION_SUCCESS: 130,

	// Memory group: rolling summary, then long-term per-entity facts.
	MEMORY_SUMMARY: 300,
	MEMORY_LONG_TERM: 310,

	// Experience: agent's distilled lessons from the just-extracted state.
	EXPERIENCE: 320,

	// Skill: trajectory-derived; runs last because writes go to disk.
	SKILL_PROPOSAL: 400,
	SKILL_REFINEMENT: 410,
} as const;

export type EvaluatorPriorityName = keyof typeof EvaluatorPriority;
