/**
 * Locale-wiring integration test — proves the end-to-end path
 *   OwnerFactStore.locale → LocalizedExamplesProvider →
 *   buildActionCatalog → localized ActionExamples
 * against the real `MultilingualPromptRegistry` + the real
 * `OwnerFactStore`.
 *
 * The action under test is a synthetic stand-in shaped like LIFE — it
 * carries the *English* example pairs that source action would. The
 * registry is loaded with the real default pack via
 * `registerDefaultPromptPack`, which is what `plugin.ts` does at
 * runtime. Importing `lifeAction` directly would drag in `@elizaos/agent`
 * and its peer plugins, which the integration suite doesn't load.
 */

import {
	type ActionExample,
	buildActionCatalog,
	type IAgentRuntime,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createOwnerLocaleExamplesProvider } from "../src/lifeops/i18n/localized-examples-provider.ts";
import {
	createMultilingualPromptRegistry,
	registerDefaultPromptPack,
	registerMultilingualPromptRegistry,
} from "../src/lifeops/i18n/prompt-registry.ts";
import {
	createOwnerFactStore,
	registerOwnerFactStore,
} from "../src/lifeops/owner/fact-store.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

const LIFE_ENGLISH_EXAMPLES: ActionExample[][] = [
	[
		{
			name: "{{name1}}",
			content: { text: "add a todo: pick up dry cleaning tomorrow" },
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
				text: "You have 2 LifeOps items due today: pick up dry cleaning and call mom.",
				actions: ["LIFE"],
			},
		},
	],
];

interface FixtureRuntime {
	runtime: IAgentRuntime;
}

async function setupRuntimeWithLocale(
	locale: string | null,
): Promise<FixtureRuntime> {
	const runtime = createMinimalRuntimeStub();

	const factStore = createOwnerFactStore(runtime);
	registerOwnerFactStore(runtime, factStore);
	if (locale) {
		await factStore.update(
			{ locale },
			{ source: "first_run", recordedAt: new Date().toISOString() },
		);
	}

	const registry = createMultilingualPromptRegistry();
	registerDefaultPromptPack(registry);
	registerMultilingualPromptRegistry(runtime, registry);

	return { runtime };
}

function getExamplesAsPairs(value: unknown): ActionExample[][] {
	if (!Array.isArray(value)) {
		throw new Error("LIFE action examples were not in pair-array shape");
	}
	return value as ActionExample[][];
}

describe("locale wiring (OwnerFactStore.locale → buildActionCatalog)", () => {
	it("swaps LIFE example pairs for Spanish when owner locale is `es`", async () => {
		const { runtime } = await setupRuntimeWithLocale("es");
		const provider = createOwnerLocaleExamplesProvider(runtime);
		const resolver = await provider({ recentMessage: null });
		expect(resolver).not.toBeNull();

		const catalog = buildActionCatalog(
			[
				{
					name: "LIFE",
					description: "Manage life tasks, todos, and goals.",
					examples: LIFE_ENGLISH_EXAMPLES,
				},
			],
			{ localizedExamples: resolver ?? undefined },
		);
		const life = catalog.parentByName.get("LIFE");
		expect(life).toBeDefined();

		const examples = getExamplesAsPairs(life?.examples);
		// Index 0 is registered for `es` in life.es.ts → must localize.
		expect(examples[0][0].content.text).toBe(
			"agrega una tarea: recoger la tintorería mañana",
		);
		expect(examples[0][1].content.text).toContain("Recoger la tintorería");
	});

	it("swaps LIFE example pairs for French when owner locale is `fr`", async () => {
		const { runtime } = await setupRuntimeWithLocale("fr");
		const provider = createOwnerLocaleExamplesProvider(runtime);
		const resolver = await provider({ recentMessage: null });
		expect(resolver).not.toBeNull();

		const catalog = buildActionCatalog(
			[
				{
					name: "LIFE",
					description: "Manage life tasks, todos, and goals.",
					examples: LIFE_ENGLISH_EXAMPLES,
				},
			],
			{ localizedExamples: resolver ?? undefined },
		);
		const life = catalog.parentByName.get("LIFE");
		const examples = getExamplesAsPairs(life?.examples);

		// Index 0 must differ from the English source and the Spanish pair.
		const userText = examples[0][0].content.text ?? "";
		expect(userText).not.toContain("add a todo:");
		expect(userText).not.toContain("agrega una tarea");
		expect(userText.length).toBeGreaterThan(0);
	});

	it("falls back to English when owner locale has no registered pack (de)", async () => {
		const { runtime } = await setupRuntimeWithLocale("de");
		const provider = createOwnerLocaleExamplesProvider(runtime);
		const resolver = await provider({ recentMessage: null });
		// Unsupported locale → resolver is a no-op resolver returning null
		// for every key, so the catalog stays on the English source.
		expect(resolver).not.toBeNull();

		const catalog = buildActionCatalog(
			[
				{
					name: "LIFE",
					description: "Manage life tasks, todos, and goals.",
					examples: LIFE_ENGLISH_EXAMPLES,
				},
			],
			{ localizedExamples: resolver ?? undefined },
		);
		const life = catalog.parentByName.get("LIFE");
		const examples = getExamplesAsPairs(life?.examples);

		expect(examples[0][0].content.text).toBe(
			"add a todo: pick up dry cleaning tomorrow",
		);
	});

	it("first-message detection: provider uses recentMessage when owner locale is unset", async () => {
		const { runtime } = await setupRuntimeWithLocale(null);
		const provider = createOwnerLocaleExamplesProvider(runtime);
		const resolver = await provider({
			recentMessage:
				"hola, ¿puedes recordarme cepillarme los dientes mañana?",
		});
		expect(resolver).not.toBeNull();

		const catalog = buildActionCatalog(
			[
				{
					name: "LIFE",
					description: "Manage life tasks, todos, and goals.",
					examples: LIFE_ENGLISH_EXAMPLES,
				},
			],
			{ localizedExamples: resolver ?? undefined },
		);
		const life = catalog.parentByName.get("LIFE");
		const examples = getExamplesAsPairs(life?.examples);
		expect(examples[0][0].content.text).toBe(
			"agrega una tarea: recoger la tintorería mañana",
		);
	});

	it("returns no resolver when owner locale resolves to default (en)", async () => {
		const { runtime } = await setupRuntimeWithLocale("en");
		const provider = createOwnerLocaleExamplesProvider(runtime);
		const resolver = await provider({ recentMessage: null });
		expect(resolver).toBeNull();
	});
});
