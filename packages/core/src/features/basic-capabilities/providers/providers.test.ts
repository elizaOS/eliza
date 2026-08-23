/**
 * Unit tests for the legacy PROVIDERS catalog renderer, exercising the real
 * ordering, context filtering, description fallbacks, and empty-state output.
 */
import { describe, expect, it } from "vitest";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	State,
	UUID,
} from "../../../types/index.ts";
import { providersProvider } from "./providers.ts";

const message: Memory = {
	agentId: "00000000-0000-0000-0000-000000000001" as UUID,
	entityId: "00000000-0000-0000-0000-000000000002" as UUID,
	roomId: "00000000-0000-0000-0000-000000000003" as UUID,
	content: { text: "What context is available?" },
};

const state: State = { values: {}, data: {}, text: "" };

function provider(name: string, options: Partial<Provider> = {}): Provider {
	return {
		name,
		get: async () => ({ text: "" }),
		...options,
	};
}

function runtime(providers: Provider[]): IAgentRuntime {
	return { providers } as IAgentRuntime;
}

describe("providersProvider", () => {
	it("exposes the generated provider contract and turn-scoped gates", () => {
		expect(providersProvider).toMatchObject({
			name: "PROVIDERS",
			description: "Available context providers",
			contexts: ["general"],
			contextGate: { anyOf: ["general"] },
			cacheStable: true,
			cacheScope: "turn",
			roleGate: { minRole: "USER" },
		});
	});

	it("renders the complete designed empty catalog", async () => {
		const result = await providersProvider.get(runtime([]), message, state);
		const expectedHints = [
			"images, attachments, or visual content -> ATTACHMENTS",
			"uploaded files or stored documents -> DOCUMENTS",
			"specific people or agents -> ENTITIES",
			"connections between people -> RELATIONSHIPS",
			"current platform chat or user identity -> PLATFORM_CHAT_CONTEXT, PLATFORM_USER_CONTEXT",
			"factual lookup -> FACTS",
			"world or environment context -> WORLD",
		];
		const emptyCatalog = [
			"# Providers",
			"providers: 0",
			"- none",
			"provider_hints: 7",
			...expectedHints.map((hint) => `- ${hint}`),
		].join("\n");

		expect(result).toEqual({
			text: emptyCatalog,
			data: { dynamicProviders: [], allProviders: [] },
			values: {
				providersWithDescriptions: emptyCatalog.replace(
					"# Providers",
					"# Available Providers",
				),
			},
		});
	});

	it("sorts by position then name and applies every reachable description fallback", async () => {
		const result = await providersProvider.get(
			runtime([
				provider("ZULU", {
					position: 4,
					descriptionCompressed: "compressed custom description",
				}),
				provider("TIME", { dynamic: true }),
				provider("BETA", { description: "explicit description" }),
				provider("ALPHA"),
				provider("FIRST", { position: -2, dynamic: true }),
			]),
			message,
			state,
		);

		expect(result.data).toEqual({
			dynamicProviders: [
				{ name: "FIRST", description: "No description available" },
				{
					name: "TIME",
					description:
						"Provides the current date and time in UTC for time-based operations or responses",
				},
			],
			allProviders: [
				{
					name: "FIRST",
					description: "No description available",
					dynamic: true,
				},
				{
					name: "ALPHA",
					description: "No description available",
					dynamic: false,
				},
				{
					name: "BETA",
					description: "explicit description",
					dynamic: false,
				},
				{
					name: "TIME",
					description:
						"Provides the current date and time in UTC for time-based operations or responses",
					dynamic: true,
				},
				{
					name: "ZULU",
					description: "compressed custom description",
					dynamic: false,
				},
			],
		});
		expect(result.text).toContain("providers: 2\n- FIRST:");
		expect(result.text).not.toContain("- ALPHA:");
		expect(result.values?.providersWithDescriptions).toContain(
			"providers: 5\n- FIRST: No description available\n- ALPHA: No description available\n- BETA: explicit description",
		);
	});

	it("keeps general and matching providers while excluding other explicit contexts", async () => {
		const routedState: State = {
			...state,
			values: {
				__contextRouting: {
					primaryContext: "wallet",
				},
			},
		};
		const result = await providersProvider.get(
			runtime([
				provider("DOCUMENT_ONLY", {
					contexts: ["documents"],
					dynamic: true,
				}),
				provider("GENERAL", { contexts: ["general"] }),
				provider("WALLET_ONLY", {
					contexts: ["wallet"],
					dynamic: true,
				}),
			]),
			message,
			routedState,
		);

		expect(result.data).toEqual({
			dynamicProviders: [
				{ name: "WALLET_ONLY", description: "No description available" },
			],
			allProviders: [
				{
					name: "GENERAL",
					description: "No description available",
					dynamic: false,
				},
				{
					name: "WALLET_ONLY",
					description: "No description available",
					dynamic: true,
				},
			],
		});
		expect(result.values?.providersWithDescriptions).not.toContain(
			"DOCUMENT_ONLY",
		);
	});
});
