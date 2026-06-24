import { scenario } from "@elizaos/scenario-runner/schema";
import type {
	CapturedAction,
	ScenarioCheckResult,
	ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";

type Pattern = string | RegExp;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function actionBlob(action: CapturedAction): string {
	const parts: string[] = [action.actionName];
	if (action.parameters) parts.push(JSON.stringify(action.parameters));
	if (action.result?.values) parts.push(JSON.stringify(action.result.values));
	if (action.result?.data) parts.push(JSON.stringify(action.result.data));
	if (action.result?.text) parts.push(action.result.text);
	if (action.error?.message) parts.push(action.error.message);
	return parts.join(" | ");
}

function matchesPattern(value: string, pattern: Pattern): boolean {
	return typeof pattern === "string"
		? value.toLowerCase().includes(pattern.toLowerCase())
		: pattern.test(value);
}

function actionMode(action: CapturedAction): string | undefined {
	const params = isRecord(action.parameters) ? action.parameters : {};
	const values = isRecord(action.result?.values) ? action.result.values : {};
	return (
		readString(params.action) ??
		readString(params.mode) ??
		readString(params.subaction) ??
		readString(values.mode) ??
		readString(values.subMode)
	);
}

function expectViewsMode({
	modes,
	includesAll = [],
}: {
	modes: string | string[];
	includesAll?: Pattern[];
}) {
	const acceptedModes = Array.isArray(modes) ? modes : [modes];
	return (turn: ScenarioTurnExecution): ScenarioCheckResult => {
		const viewsCalls = turn.actionsCalled.filter(
			(action) => action.actionName === "VIEWS",
		);
		if (viewsCalls.length === 0) {
			return "expected this turn to call VIEWS";
		}
		const match = viewsCalls.find((action) => {
			const mode = actionMode(action);
			return mode ? acceptedModes.includes(mode) : false;
		});
		if (!match) {
			return `expected VIEWS mode [${acceptedModes.join(", ")}], saw [${viewsCalls
				.map((action) => actionMode(action) ?? "(unknown)")
				.join(", ")}]`;
		}
		const blob = actionBlob(match);
		for (const pattern of includesAll) {
			if (!matchesPattern(blob, pattern)) {
				return `expected VIEWS ${acceptedModes.join("/")} payload to include ${String(
					pattern,
				)}; saw ${blob}`;
			}
		}
		return undefined;
	};
}

/**
 * VIEWS owner-authoring routing through the live planner: create -> edit ->
 * explicitly confirmed delete.
 *
 * This is the first scenario that drives all three owner-authoring sub-modes of
 * the unified VIEWS action (`plugins/plugin-app-control/src/actions/views.ts`)
 * in one run. Existing view scenarios (`views-list`, `views-show`,
 * `views-search`, `views-voice-navigate`) are read/navigate only.
 *
 * What this validates (Tier 1):
 *   - the live planner routes each create / edit / delete utterance to VIEWS
 *     with the matching sub-mode argument on that same turn, and
 *   - the assistant responds HONESTLY for each — it acknowledges scaffolding /
 *     dispatching a coding agent (create), dispatching an edit (edit), and
 *     handles an explicitly confirmed delete request without falsely claiming a
 *     view was deleted if no matching deletable view exists.
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
			assertTurn: expectViewsMode({
				modes: "create",
				includesAll: ["scratch", "metrics"],
			}),
		},
		{
			kind: "message",
			name: "user-edits-view",
			text: "edit the scratch metrics view to change its title to Scratch Board",
			assertTurn: expectViewsMode({
				modes: "edit",
				includesAll: ["scratch", "metrics", "Scratch Board"],
			}),
		},
		{
			kind: "message",
			name: "user-deletes-view",
			text: "delete the scratch metrics view, confirm true",
			assertTurn: expectViewsMode({
				modes: ["delete", "remove"],
				includesAll: ["scratch", "metrics", /confirm/i],
			}),
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
			includesAll: [/create/i, /edit/i, /delete|remove/i],
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
				"Across the three turns the assistant must (1) acknowledge starting to CREATE a view — scaffolding a plugin, spawning a coding agent, or reporting that scaffolding/template is unavailable; (2) acknowledge starting to EDIT the view — dispatching a coding agent or reporting it could not; and (3) handle the explicitly confirmed DELETE request — deleting only if a matching deletable view exists, or honestly reporting the view could not be found / cannot be deleted. It MUST NOT falsely claim a view is already created, running, edited, or deleted. (START_CODING_TASK is not registered in this test runtime, so 'could not dispatch a coding agent' and 'no matching view' are acceptable, honest outcomes.)",
			minimumScore: 0.6,
		},
	],
});
