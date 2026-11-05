/** Real runtime: the action argument extractor reads a model reply in a code fence. */
import { expect, it } from "vitest";
import { resolveActionArgs } from "../src/actions/resolve-action-args";
import type { Memory } from "../src/types/memory";
import { ModelType } from "../src/types/model";
import type { UUID } from "../src/types/primitives";
import { createInitializedRuntime } from "./initialized-runtime";

const subactions = {
	create: {
		description: "Create a goal.",
		descriptionCompressed: "create goal",
		required: ["title"],
	},
	list: {
		description: "List goals.",
		descriptionCompressed: "list goals",
		required: [],
	},
} as const;

it("reads a reply fenced as ``` json with a space before the label", async () => {
	const runtime = await createInitializedRuntime({
		character: { name: "Fence reader", bio: [] },
		logLevel: "fatal",
	});
	const reply = JSON.stringify({
		action: "create",
		params: { title: "Run a marathon" },
		missing: [],
		confidence: 0.9,
	});
	let modelCalls = 0;
	let fence = "";
	runtime.registerModel(
		ModelType.TEXT_LARGE,
		async () => {
			modelCalls++;
			return `${fence}\n${reply}\n${fence.match(/^`+/)?.[0]}`;
		},
		"test",
	);
	const message: Memory = {
		id: "44444444-4444-4444-8444-444444444444" as UUID,
		agentId: runtime.agentId,
		entityId: "33333333-3333-4333-8333-333333333333" as UUID,
		roomId: "22222222-2222-4222-8222-222222222222" as UUID,
		content: { text: "Add a goal to run a marathon", source: "test" },
	};

	// CommonMark trims spaces and tabs before the info string, so each of
	// these fences is labelled json.
	const openings = ["```json", "``` json", "```\tJSON", "````  json"];
	const results = [];
	for (const opening of openings) {
		fence = opening;
		modelCalls = 0;
		const result = await resolveActionArgs({
			runtime,
			message,
			actionName: "GOAL",
			subactions,
		});
		results.push({ opening, result, modelCalls });
	}
	expect(results).toEqual(
		openings.map((opening) => ({
			opening,
			result: {
				ok: true,
				subaction: "create",
				params: { title: "Run a marathon" },
			},
			modelCalls: 1,
		})),
	);
});
