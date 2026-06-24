import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * End-to-end VIEWS lifecycle through the live planner: create -> edit -> delete.
 *
 * This is the first scenario that drives all three owner-authoring sub-modes of
 * the unified VIEWS action (`plugins/plugin-app-control/src/actions/views.ts`)
 * in one run. Existing view scenarios (`views-list`, `views-show`,
 * `views-search`, `views-voice-navigate`) are read/navigate only.
 *
 * What this validates (Tier 1):
 *   - the live planner routes each create / edit / delete utterance to VIEWS
 *     with the matching sub-mode argument, and
 *   - the assistant responds HONESTLY for each — it acknowledges scaffolding /
 *     dispatching a coding agent (create), dispatching an edit (edit), and either
 *     asks to confirm or reports the view was not found (delete) — and it never
 *     claims a view is already created / running / deleted when it is not.
 *
 * What this does NOT yet validate (Tier 2 — tracked in #9478):
 *   The *materialization* of a created view in `GET /api/views`, or the
 *   *disappearance* of a deleted view, cannot be asserted here because:
 *     - create/edit dispatch a coding sub-agent via START_CODING_TASK, which is
 *       NOT registered in the scenario runtime
 *       (`packages/scenario-runner/src/runtime-factory.ts`), so a new view never
 *       actually registers in a default run; and
 *     - delete needs a non-protected installed view to remove, and the scenario
 *       runtime only has first-party (protected) plugins.
 *   Asserting the catalog membership delta needs a test-only synthetic-view
 *   registration seam in `packages/agent/src/api/views-registry.ts`. That is the
 *   follow-up enhancement; this scenario is the honest routing/dispatch floor it
 *   will build on.
 */
export default scenario({
	lane: "live-only",
	id: "views-crud-lifecycle",
	title: "VIEWS lifecycle — create, edit, then delete a view",
	domain: "app-control",
	tags: ["app-control", "views", "create", "edit", "delete", "crud"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	rooms: [
		{
			id: "main",
			source: "telegram",
			title: "Views CRUD Lifecycle",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-creates-view",
			text: "create a new scratch metrics view",
		},
		{
			kind: "message",
			name: "user-edits-view",
			text: "edit the scratch metrics view to change its title to Scratch Board",
		},
		{
			kind: "message",
			name: "user-deletes-view",
			text: "delete the scratch metrics view",
		},
	],
	finalChecks: [
		{
			type: "selectedAction",
			actionName: "VIEWS",
		},
		{
			type: "selectedActionArguments",
			actionName: "VIEWS",
			includesAny: [/create/i, /edit/i, /delete|remove/i],
		},
		{
			type: "actionCalled",
			actionName: "VIEWS",
			minCount: 3,
		},
		{
			type: "judgeRubric",
			name: "honest-crud-lifecycle",
			rubric:
				"Across the three turns the assistant must (1) acknowledge starting to CREATE a view — scaffolding a plugin, spawning a coding agent, or reporting that scaffolding/template is unavailable; (2) acknowledge starting to EDIT the view — dispatching a coding agent or reporting it could not; and (3) handle the DELETE — either asking the user to confirm deletion or reporting the view could not be found. It MUST NOT falsely claim a view is already created, running, edited, or deleted. (START_CODING_TASK is not registered in this test runtime, so 'could not dispatch a coding agent' and 'no matching view' are acceptable, honest outcomes.)",
			minimumScore: 0.6,
		},
	],
});
