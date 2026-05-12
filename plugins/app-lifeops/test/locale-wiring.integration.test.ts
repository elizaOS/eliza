/**
 * Locale-wiring integration test — proves the end-to-end path
 *   OwnerFactStore.locale -> LocalizedExamplesProvider ->
 *   buildActionCatalog -> localized ActionExamples
 * against the real `MultilingualPromptRegistry` + the real
 * `OwnerFactStore`.
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

const OWNER_ROUTINES_ENGLISH_EXAMPLES: ActionExample[][] = [
	[
		{
			name: "{{name1}}",
			content: {
				text: "help me brush my teeth at 8 am and 9 pm every day",
			},
		},
		{
			name: "{{agentName}}",
			content: {
				text: 'I can set up a habit named "Brush teeth" for 8 am and 9 pm daily. Confirm and I\'ll save it.',
				actions: ["OWNER_ROUTINES"],
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
		throw new Error("OWNER_ROUTINES examples were not in pair-array shape");
	}
	return value as ActionExample[][];
}

function buildRoutinesCatalog(
	resolver: Awaited<ReturnType<ReturnType<typeof createOwnerLocaleExamplesProvider>>>,
) {
	return buildActionCatalog(
		[
			{
				name: "OWNER_ROUTINES",
				description: "Manage owner routines and habits.",
				examples: OWNER_ROUTINES_ENGLISH_EXAMPLES,
			},
		],
		{ localizedExamples: resolver ?? undefined },
	);
}

describe("locale wiring (OwnerFactStore.locale -> buildActionCatalog)", () => {
	it("swaps OWNER_ROUTINES example pairs for Spanish when owner locale is `es`", async () => {
		const { runtime } = await setupRuntimeWithLocale("es");
		const provider = createOwnerLocaleExamplesProvider(runtime);
		const resolver = await provider({ recentMessage: null });
		expect(resolver).not.toBeNull();

		const catalog = buildRoutinesCatalog(resolver);
		const routines = catalog.parentByName.get("OWNER_ROUTINES");
		expect(routines).toBeDefined();

		const examples = getExamplesAsPairs(routines?.examples);
		expect(examples[0][0].content.text).toBe(
			"recuérdame cepillarme los dientes por la mañana y por la noche",
		);
		expect(examples[0][1].content.actions).toEqual(["OWNER_ROUTINES"]);
	});

	it("swaps OWNER_ROUTINES example pairs for French when owner locale is `fr`", async () => {
		const { runtime } = await setupRuntimeWithLocale("fr");
		const provider = createOwnerLocaleExamplesProvider(runtime);
		const resolver = await provider({ recentMessage: null });
		expect(resolver).not.toBeNull();

		const catalog = buildRoutinesCatalog(resolver);
		const routines = catalog.parentByName.get("OWNER_ROUTINES");
		const examples = getExamplesAsPairs(routines?.examples);

		const userText = examples[0][0].content.text ?? "";
		expect(userText).toContain("brosser les dents");
		expect(userText).not.toContain("help me brush");
	});

	it("falls back to English when owner locale has no registered pack (de)", async () => {
		const { runtime } = await setupRuntimeWithLocale("de");
		const provider = createOwnerLocaleExamplesProvider(runtime);
		const resolver = await provider({ recentMessage: null });
		expect(resolver).not.toBeNull();

		const catalog = buildRoutinesCatalog(resolver);
		const routines = catalog.parentByName.get("OWNER_ROUTINES");
		const examples = getExamplesAsPairs(routines?.examples);

		expect(examples[0][0].content.text).toBe(
			"help me brush my teeth at 8 am and 9 pm every day",
		);
	});

	it("first-message detection uses recentMessage when owner locale is unset", async () => {
		const { runtime } = await setupRuntimeWithLocale(null);
		const provider = createOwnerLocaleExamplesProvider(runtime);
		const resolver = await provider({
			recentMessage:
				"hola, puedes recordarme cepillarme los dientes manana?",
		});
		expect(resolver).not.toBeNull();

		const catalog = buildRoutinesCatalog(resolver);
		const routines = catalog.parentByName.get("OWNER_ROUTINES");
		const examples = getExamplesAsPairs(routines?.examples);
		expect(examples[0][0].content.text).toBe(
			"recuérdame cepillarme los dientes por la mañana y por la noche",
		);
	});

	it("returns no resolver when owner locale resolves to default (en)", async () => {
		const { runtime } = await setupRuntimeWithLocale("en");
		const provider = createOwnerLocaleExamplesProvider(runtime);
		const resolver = await provider({ recentMessage: null });
		expect(resolver).toBeNull();
	});
});
