import { scenario } from "@elizaos/scenario-schema";

/**
 * Single-turn create when no installed app fuzzy-matches the intent. The
 * APP action skips the picker and goes straight to the scaffold + dispatch
 * path. The orchestrator is not actually exercised in this scenario — we
 * only assert the action selection and that the assistant's response makes
 * sense.
 */
export default scenario({
	id: "app-create-no-existing",
	title: "APP create — no fuzzy matches, scaffold path",
	domain: "app-control",
	tags: ["app-control", "app", "create"],
	isolation: "per-scenario",
	requires: {
		plugins: ["@elizaos/plugin-app-control"],
	},
	rooms: [
		{
			id: "main",
			source: "telegram",
			title: "App Create No Existing",
		},
	],
	turns: [
		{
			kind: "message",
			name: "user-asks-create",
			text: "scaffold a brand-new quantum cryptography ascii visualizer app",
		},
	],
	finalChecks: [
		{
			type: "selectedAction",
			actionName: "APP",
		},
		{
			type: "selectedActionArguments",
			actionName: "APP",
			includesAny: [/create/i],
		},
		{
			type: "actionCalled",
			actionName: "APP",
			minCount: 1,
		},
		{
			type: "judgeRubric",
			name: "scaffold-or-dispatch-acknowledgement",
				rubric:
					"The assistant should acknowledge starting the create flow — mentioning that it scaffolded an app, spawned a coding agent, or that template/scaffolding is unavailable. It must NOT claim the app is already running. (START_CODING_TASK is not registered in this test runtime, so a 'could not dispatch' style failure is acceptable.)",
			minimumScore: 0.6,
		},
	],
});
