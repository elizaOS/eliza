import { describe, expect, it } from "vitest";
import { actionsProvider } from "../features/basic-capabilities/providers/actions";
import { providersProvider } from "../features/basic-capabilities/providers/providers";
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
					name: "SEND_TOKEN",
					description: "A1",
					handler: async () => ({
						success: true,
						text: "",
					}),
					validate: async () => true,
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
					name: "knowledge",
					description: "P1",
					position: 0,
					get: async () => ({}),
					dynamic: true,
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

		expect(contexts).toEqual(["automation", "general", "knowledge", "wallet"]);
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

	it("treats missing routing as unfiltered", () => {
		expect(getActiveRoutingContexts({})).toEqual([]);
		expect(shouldIncludeByContext(["wallet"], [])).toBe(true);
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
					name: "SEND_TOKEN",
					description: "wallet",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
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
			"SEND_TOKEN",
			"GenericAction",
		]);
	});

	it("collapses domain child actions behind parent action groups in main chat", async () => {
		const runtime = {
			agentId: "agent",
			actions: [
				{
					name: "WALLET_ACTIONS",
					description: "wallet parent",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
					contexts: ["general", "wallet"],
					actionGroup: { contexts: ["wallet"] },
				},
				{
					name: "CHECK_BALANCE",
					description: "wallet child",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
				},
				{
					name: "REPLY",
					description: "reply",
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
			"WALLET_ACTIONS",
			"REPLY",
		]);
	});

	it("keeps page-scoped child actions and removes parent groups", async () => {
		const runtime = {
			agentId: "agent",
			actions: [
				{
					name: "WALLET_ACTIONS",
					description: "wallet parent",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
					contexts: ["general", "wallet"],
					actionGroup: { contexts: ["wallet"] },
				},
				{
					name: "CHECK_BALANCE",
					description: "wallet child",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
				},
				{
					name: "REPLY",
					description: "reply",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
				},
			],
		} as unknown as IAgentRuntime;

		const result = await actionsProvider.get(
			runtime,
			message,
			createState({
				primaryContext: "wallet",
				secondaryContexts: ["page", "page-wallet"],
			}),
		);

		expect(result.data?.actionsData?.map((action) => action.name)).toEqual([
			"CHECK_BALANCE",
			"REPLY",
		]);
	});

	it("filters providers by active context", async () => {
		const runtime = {
			agentId: "agent",
			actions: [],
			providers: [
				{
					name: "walletBalance",
					description: "wallet",
					get: async () => ({ text: "" }),
					dynamic: true,
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
		).toEqual(["GeneralProvider", "walletBalance"]);
		expect(
			result.data?.dynamicProviders?.map((provider: Provider) => provider.name),
		).toEqual(["GeneralProvider", "walletBalance"]);
	});

	it("keeps only generic chat actions for non-actionable chatter", async () => {
		const runtime = {
			agentId: "agent",
			actions: [
				{
					name: "SCREEN_TIME",
					description: "screen time lookup",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
				},
				{
					name: "REPLY",
					description: "reply",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
				},
				{
					name: "IGNORE",
					description: "ignore",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
				},
				{
					name: "NONE",
					description: "none",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
				},
			],
		} as unknown as IAgentRuntime;

		const result = await actionsProvider.get(
			runtime,
			{
				...message,
				content: { text: "I think I spend too much time on my phone" },
			},
			createState({}),
		);

		expect(result.data?.actionsData?.map((action) => action.name)).toEqual([
			"REPLY",
			"IGNORE",
			"NONE",
		]);
	});

	it("hides providers for non-actionable chatter", async () => {
		const runtime = {
			agentId: "agent",
			actions: [],
			providers: [
				{
					name: "appBlocker",
					description: "mobile app blocker",
					get: async () => ({ text: "" }),
					dynamic: true,
				},
				{
					name: "CURRENT_TIME",
					description: "time",
					get: async () => ({ text: "" }),
					dynamic: true,
				},
			],
		} as unknown as IAgentRuntime;

		const result = await providersProvider.get(
			runtime,
			{
				...message,
				content: { text: "I think I spend too much time on my phone" },
			},
			createState({}),
		);

		expect(result.data?.allProviders).toEqual([]);
		expect(result.data?.dynamicProviders).toEqual([]);
		expect(result.text).toContain("providers[0]");
	});

	it("prefers OWNER_RELATIONSHIP for person-specific follow-up reminders", async () => {
		const runtime = {
			agentId: "agent",
			actions: [
				{
					name: "OWNER_RELATIONSHIP",
					description: "relationship follow-up",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
				},
				{
					name: "LIFE",
					description: "life reminders",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
				},
				{
					name: "SCHEDULING",
					description: "meeting scheduling",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
				},
				{
					name: "REPLY",
					description: "reply",
					handler: async () => ({ success: true, text: "ok" }),
					validate: async () => true,
				},
			],
		} as unknown as IAgentRuntime;

		const result = await actionsProvider.get(
			runtime,
			{
				...message,
				content: {
					text: "remind me to follow up with David next week about the project",
				},
			},
			createState({}),
		);

		expect(result.data?.actionsData?.map((action) => action.name)).toEqual([
			"OWNER_RELATIONSHIP",
			"REPLY",
		]);
	});
});
