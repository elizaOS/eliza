/**
 * Covers the basic-capabilities providers barrel — the runtime contract its
 * consumers depend on: importing the module registers the
 * FEATURES_BASIC_CAPABILITIES_PROVIDERS_INDEX bundle-safety anchor holding a
 * live value for every retained binding, each public export is the same
 * reference its source module exports, and every provider binding appears in
 * the anchor so a future export cannot silently escape mobile tree-shaking
 * (incidents #10727, #11030, #11248, #11276). Deterministic; drives the real
 * module graph with no mocks.
 */
import { describe, expect, it } from "vitest";
import * as providersBarrel from "./index.ts";

const ANCHOR_KEY =
	"__bundle_safety_FEATURES_BASIC_CAPABILITIES_PROVIDERS_INDEX__";

const barrel = providersBarrel as unknown as Record<string, unknown>;

/**
 * Source-module layout observed on the barrel: each entry lists the bindings
 * the barrel re-exports from that leaf module. `resolveMessageTimeZone` is the
 * one export deliberately absent from the anchor array — the currentTime module
 * body is already retained through `currentTimeProvider`, so the function
 * survives bundling without its own anchor slot.
 */
const SOURCE_MODULES: Array<[module: string, bindings: string[]]> = [
	["./actionState.ts", ["actionStateProvider"]],
	["./actions.ts", ["actionsProvider"]],
	["./anxiety.ts", ["anxietyProvider"]],
	["./attachments.ts", ["attachmentsProvider"]],
	["./botAwareness.ts", ["botAwarenessProvider"]],
	["./channelTopics.ts", ["channelTopicsProvider"]],
	["./character.ts", ["characterProvider"]],
	["./choice.ts", ["choiceProvider"]],
	["./contextBench.ts", ["contextBenchProvider"]],
	["./currentTime.ts", ["currentTimeProvider", "resolveMessageTimeZone"]],
	["./entities.ts", ["entitiesProvider"]],
	[
		"./platformContext.ts",
		[
			"PLATFORM_CHAT_CONTEXT_PROVIDER_NAME",
			"PLATFORM_USER_CONTEXT_PROVIDER_NAME",
			"platformChatContextProvider",
			"platformUserContextProvider",
		],
	],
	["./providers.ts", ["providersProvider"]],
	["./recentMessages.ts", ["recentMessagesProvider"]],
	["./replyContext.ts", ["replyContextProvider"]],
	["./runtimeModelContext.ts", ["runtimeModelContextProvider"]],
	["./uiContext.ts", ["uiContextProvider"]],
	["./userEmotionSignal.ts", ["userEmotionSignalProvider"]],
	["./world.ts", ["worldProvider"]],
];

function getAnchor(): unknown[] {
	const stashed = (globalThis as Record<string, unknown>)[ANCHOR_KEY];
	expect(
		Array.isArray(stashed),
		"anchor global must hold the value array",
	).toBe(true);
	const values = stashed as unknown[];
	expect(
		values.length,
		"anchor must retain every binding the barrel stashes",
	).toBeGreaterThan(0);
	return values;
}

describe("basic-capabilities providers barrel", () => {
	it("registers the bundle-safety anchor global when the barrel module initializes", () => {
		const anchor = getAnchor();
		for (const [index, entry] of anchor.entries()) {
			expect(
				entry,
				`anchor slot ${index} must be a retained live value, not undefined`,
			).toBeDefined();
		}
	});

	it("keeps every anchor entry pointed at a current barrel export", () => {
		const anchor = getAnchor();
		for (const [index, entry] of anchor.entries()) {
			const matched = Object.values(barrel).some((value) => value === entry);
			expect(
				matched,
				`anchor slot ${index} must reference a binding the barrel still exports`,
			).toBe(true);
		}
	});

	it("retains every exported provider binding in the anchor array", () => {
		const anchor = getAnchor();
		for (const [moduleName, bindings] of SOURCE_MODULES) {
			for (const binding of bindings) {
				if (binding === "resolveMessageTimeZone") continue;
				expect(
					barrel[binding],
					`${moduleName}:${binding} must be defined on the barrel`,
				).toBeDefined();
				expect(
					anchor.includes(barrel[binding]),
					`${moduleName}:${binding} must be retained by the bundle-safety anchor`,
				).toBe(true);
			}
		}
	});

	it("re-exports each binding as the same live reference its source module exports", async () => {
		for (const [moduleName, bindings] of SOURCE_MODULES) {
			const source = (await import(moduleName)) as Record<string, unknown>;
			for (const binding of bindings) {
				expect(
					source[binding],
					`${moduleName} must actually export ${binding}`,
				).toBeDefined();
				expect(
					barrel[binding],
					`${moduleName}:${binding} must reach consumers as the source module's own reference`,
				).toBe(source[binding]);
			}
		}
	});
});
