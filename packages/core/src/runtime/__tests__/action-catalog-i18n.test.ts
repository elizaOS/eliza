import { describe, expect, it } from "vitest";
import {
	buildActionCatalog,
	type LocalizedActionExamplePair,
	type LocalizedActionExampleResolver,
} from "../action-catalog";
import type { ActionExample } from "../../types/components";

/**
 * `MultilingualPromptRegistry`-style fixture: maps composite keys to
 * localized `[user, agent]` pairs. The resolver below converts the
 * `(actionName, exampleIndex)` tuple into the registry's
 * `<actionName>.example.<index>` key shape and returns the matching pair (or
 * `null` for fall-through).
 */
type LocalizedRegistry = Map<string, LocalizedActionExamplePair>;

function makeResolver(
	registry: LocalizedRegistry,
	locale: string,
): LocalizedActionExampleResolver {
	return ({ actionName, exampleIndex }) => {
		const compositeKey = `${locale}::${actionName}.example.${exampleIndex}`;
		return registry.get(compositeKey) ?? null;
	};
}

const ENGLISH_LIFE_EXAMPLES: ActionExample[][] = [
	[
		{
			name: "{{name1}}",
			content: { text: "add a task: pick up dry cleaning tomorrow" },
		},
		{
			name: "{{agentName}}",
			content: {
				text: 'I can save "Pick up dry cleaning" for tomorrow. Confirm and I\'ll save it.',
				actions: ["LIFE"],
			},
		},
	],
	[
		{
			name: "{{name1}}",
			content: { text: "what's on my todo list today?" },
		},
		{
			name: "{{agentName}}",
			content: {
				text: "You have 2 LifeOps items pending today: pick up dry cleaning, and call mom.",
				actions: ["LIFE"],
			},
		},
	],
];

const SPANISH_LIFE_EXAMPLE_0: LocalizedActionExamplePair = [
	{
		name: "{{name1}}",
		content: { text: "agrega una tarea: recoger la tintorería mañana" },
	},
	{
		name: "{{agentName}}",
		content: {
			text: 'Puedo guardar "Recoger la tintorería" para mañana. Confirma y lo guardaré.',
			actions: ["LIFE"],
		},
	},
];

describe("action-catalog locale-aware examples", () => {
	it("swaps English example pairs for the registered Spanish translation", () => {
		const registry: LocalizedRegistry = new Map([
			["es::LIFE.example.0", SPANISH_LIFE_EXAMPLE_0],
		]);
		const catalog = buildActionCatalog(
			[
				{
					name: "LIFE",
					description: "Manage life tasks, todos, and goals.",
					examples: ENGLISH_LIFE_EXAMPLES,
				},
			],
			{ localizedExamples: makeResolver(registry, "es") },
		);

		const life = catalog.parentByName.get("LIFE");
		expect(life).toBeDefined();

		const examples = life?.examples as ActionExample[][];
		expect(examples).toBeDefined();
		// Index 0 is registered for Spanish — should be swapped.
		expect(examples[0][0].content.text).toBe(
			"agrega una tarea: recoger la tintorería mañana",
		);
		expect(examples[0][1].content.text).toContain("Recoger la tintorería");
		// Index 1 has no Spanish entry — should fall back to English.
		expect(examples[1][0].content.text).toBe("what's on my todo list today?");
	});

	it("falls back entirely to English when no translations are registered for the locale", () => {
		const registry: LocalizedRegistry = new Map([
			["es::LIFE.example.0", SPANISH_LIFE_EXAMPLE_0],
		]);
		const catalog = buildActionCatalog(
			[
				{
					name: "LIFE",
					description: "Manage life tasks, todos, and goals.",
					examples: ENGLISH_LIFE_EXAMPLES,
				},
			],
			// French resolver hits an empty-for-fr partition of the same registry.
			{ localizedExamples: makeResolver(registry, "fr") },
		);

		const life = catalog.parentByName.get("LIFE");
		const examples = life?.examples as ActionExample[][];
		expect(examples[0][0].content.text).toBe(
			"add a task: pick up dry cleaning tomorrow",
		);
		expect(examples[1][0].content.text).toBe("what's on my todo list today?");
	});

	it("preserves English examples verbatim when no resolver is provided", () => {
		const catalog = buildActionCatalog([
			{
				name: "LIFE",
				description: "Manage life tasks.",
				examples: ENGLISH_LIFE_EXAMPLES,
			},
		]);
		const life = catalog.parentByName.get("LIFE");
		expect(life?.examples).toBe(ENGLISH_LIFE_EXAMPLES);
	});

	it("passes through non-pair example shapes without invoking the resolver", () => {
		let resolverCalls = 0;
		const opaqueExamples = { kind: "custom-doc", body: "see manual" };
		const catalog = buildActionCatalog(
			[
				{
					name: "WEIRD",
					description: "Action with non-standard examples shape.",
					examples: opaqueExamples,
				},
			],
			{
				localizedExamples: () => {
					resolverCalls += 1;
					return null;
				},
			},
		);
		const weird = catalog.parentByName.get("WEIRD");
		expect(weird?.examples).toBe(opaqueExamples);
		expect(resolverCalls).toBe(0);
	});

	it("localizes sub-action examples through the same resolver", () => {
		const childSpanish: LocalizedActionExamplePair = [
			{ name: "{{name1}}", content: { text: "crea una tarea" } },
			{
				name: "{{agentName}}",
				content: { text: "Tarea creada.", actions: ["CREATE_TASK"] },
			},
		];
		const registry: LocalizedRegistry = new Map([
			["es::CREATE_TASK.example.0", childSpanish],
		]);
		const catalog = buildActionCatalog(
			[
				{
					name: "LIFE",
					description: "Parent.",
					subActions: ["CREATE_TASK"],
				},
				{
					name: "CREATE_TASK",
					description: "Create a task.",
					examples: [
						[
							{ name: "{{name1}}", content: { text: "create a task" } },
							{
								name: "{{agentName}}",
								content: { text: "Task created.", actions: ["CREATE_TASK"] },
							},
						],
					],
				},
			],
			{ localizedExamples: makeResolver(registry, "es") },
		);

		const child = catalog.childByName.get("CREATE_TASK");
		const examples = child?.examples as ActionExample[][];
		expect(examples[0][0].content.text).toBe("crea una tarea");
	});
});
