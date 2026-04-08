import { describe, expect, it } from "vitest";
import { actionsProvider } from "../basic-capabilities/providers/actions";
import { providersProvider } from "../basic-capabilities/providers/providers";
import type { IAgentRuntime, Memory } from "../types";
import type { Action, Provider } from "../types/components";
import type { State } from "../types/state";
import {
	AVAILABLE_CONTEXTS_STATE_KEY,
	CONTEXT_ROUTING_STATE_KEY,
	deriveAvailableContexts,
	getActiveRoutingContexts,
	mergeContextRouting,
	parseContextRoutingMetadata,
	shouldIncludeByContext,
} from "../utils/context-routing";

describe("context-routing utilities", () => {
	it("parses context routing metadata from mixed input shapes", () => {
		expect(
			parseContextRoutingMetadata({
				primaryContext: "Wallet",
				secondaryContexts: "knowledge, media ,media",
				evidenceTurnIds: "m1, m2 ,m1",
			}),
		).toEqual({
			primaryContext: "wallet",
			secondaryContexts: ["knowledge", "media"],
			evidenceTurnIds: ["m1", "m2"],
		});
	});

	it("merges state + message routing with fallback primary", () => {
		const state: State = {
			data: {},
			values: {
				[CONTEXT_ROUTING_STATE_KEY]: {
					primaryContext: "wallet",
					secondaryContexts: ["knowledge"],
				},
			},
		};

		const merged = mergeContextRouting(state, {
			id: "123e4567-e89b-12d3-a456-426614174001",
			content: {
				text: "hello",
				metadata: {
					__responseContext: {
						primaryContext: "knowledge",
						secondaryContexts: ["automation", "wallet"],
					},
				},
			},
			entityId: "agent",
			roomId: "room",
			agentId: "agent",
			createdAt: Date.now(),
		});

		expect(merged).toEqual({
			primaryContext: "knowledge",
			secondaryContexts: ["knowledge", "automation", "wallet"],
			evidenceTurnIds: [],
		});
	});

	it("derives sorted available contexts with general fallback", () => {
		const contexts = deriveAvailableContexts(
			[
				{
					name: "A1",
					description: "A1",
					handler: async () => ({
						success: true,
						text: "",
					}),
					validate: async () => true,
					contexts: ["wallet", "media"],
				},
				{
					name: "A2",
					description: "A2",
					handler: async () => ({
						success: true,
						text: "",
					}),
					validate: async () => true,
					contexts: ["automation"],
				},
			] as Action[],
			[
				{
					name: "P1",
					description: "P1",
					position: 0,
					get: async () => ({}),
					dynamic: true,
					contexts: ["knowledge"],
				},
				{
					name: "P2",
					description: "P2",
					position: 0,
					get: async () => ({}),
					dynamic: true,
					contexts: ["wallet", "automation"],
				},
			] as Provider[],
		);

		expect(contexts).toEqual([
			"automation",
			"general",
			"knowledge",
			"media",
			"wallet",
		]);
	});

	it("classifies inclusion by context", () => {
		const activeContexts = getActiveRoutingContexts(
			parseContextRoutingMetadata({
				primaryContext: "wallet",
				secondaryContexts: "media",
			}),
		);
		expect(shouldIncludeByContext(["media"], activeContexts)).toBe(true);
		expect(shouldIncludeByContext(["social"], activeContexts)).toBe(false);
		expect(shouldIncludeByContext(undefined, activeContexts)).toBe(true);
		expect(shouldIncludeByContext(["wallet"], ["general"] as string[])).toBe(
			false,
		);
	});
});

describe("context-gated providers", () => {
	const message: Memory = {
		id: "123e4567-e89b-12d3-a456-426614174001",
		content: {
			text: "what is my wallet balance?",
		},
		entityId: "agent",
		roomId: "room",
		agentId: "agent",
		createdAt: Date.now(),
	};

	const createState = (activeRouting: {
		primaryContext?: string;
		secondaryContexts?: string[];
	}) =>
		({
			data: {},
			values: {
				[AVAILABLE_CONTEXTS_STATE_KEY]: "general, wallet",
				[CONTEXT_ROUTING_STATE_KEY]: activeRouting,
			},
		}) as State;

	it("filters actions by active context", async () => {
		const runtime = {
			agentId: "agent",
			actions: [
				{
					name: "WalletAction",
					description: "wallet",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
					contexts: ["wallet"],
				},
				{
					name: "SocialAction",
					description: "social",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
					contexts: ["social"],
				},
				{
					name: "GenericAction",
					description: "generic",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
				},
			],
		} as unknown as IAgentRuntime;

		const result = await actionsProvider.get(
			runtime,
			message,
			createState({ primaryContext: "wallet" }),
		);

		expect(result.data?.actionsData?.map((action) => action.name)).toEqual([
			"WalletAction",
			"GenericAction",
		]);
	});

	it("filters providers by active context", async () => {
		const runtime = {
			agentId: "agent",
			actions: [],
			providers: [
				{
					name: "WalletProvider",
					description: "wallet",
					get: async () => ({ text: "" }),
					dynamic: true,
					contexts: ["wallet"],
				},
				{
					name: "GeneralProvider",
					description: "general",
					get: async () => ({ text: "" }),
					dynamic: true,
				},
			],
		} as unknown as IAgentRuntime;

		const result = await providersProvider.get(
			runtime,
			message,
			createState({ primaryContext: "wallet" }),
		);

		expect(
			result.data?.allProviders?.map((provider: Provider) => provider.name),
		).toEqual(["GeneralProvider", "WalletProvider"]);
		expect(
			result.data?.dynamicProviders?.map((provider: Provider) => provider.name),
		).toEqual(["GeneralProvider", "WalletProvider"]);
	});
});
