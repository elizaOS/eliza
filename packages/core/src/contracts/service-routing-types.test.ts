/**
 * Runtime and compile-time coverage for the service-routing contract surface.
 * The suite exercises the real exported literals and pins every public type
 * without substituting mocks for the contract module.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	type DeploymentTargetConfig,
	type DeploymentTargetRuntime,
	LINKED_ACCOUNT_ACCOUNT_SOURCES,
	LINKED_ACCOUNT_HEALTH_STATES,
	LINKED_ACCOUNT_PROVIDER_IDS,
	LINKED_ACCOUNT_SOURCES,
	LINKED_ACCOUNT_STATUSES,
	type LinkedAccountAccountSource,
	type LinkedAccountConfig,
	type LinkedAccountFlagConfig,
	type LinkedAccountFlagsConfig,
	type LinkedAccountHealth,
	type LinkedAccountHealthDetail,
	type LinkedAccountProviderId,
	type LinkedAccountSource,
	type LinkedAccountStatus,
	type LinkedAccountsConfig,
	type LinkedAccountUsage,
	SERVICE_CAPABILITIES,
	SERVICE_ROUTE_ACCOUNT_STRATEGIES,
	SERVICE_TRANSPORTS,
	type ServiceCapability,
	type ServiceRouteAccountStrategy,
	type ServiceRouteConfig,
	type ServiceRoutingConfig,
	type ServiceTransport,
} from "./service-routing-types.js";

describe("service-routing type contracts", () => {
	it("exports each linked-account literal in canonical order", () => {
		expect(LINKED_ACCOUNT_STATUSES).toEqual(["linked", "unlinked"]);
		expect(LINKED_ACCOUNT_SOURCES).toEqual([
			"api-key",
			"oauth",
			"credentials",
			"subscription",
		]);
		expect(LINKED_ACCOUNT_PROVIDER_IDS).toEqual([
			"anthropic-subscription",
			"openai-codex",
			"gemini-cli",
			"zai-coding",
			"kimi-coding",
			"deepseek-coding",
			"anthropic-api",
			"openai-api",
			"deepseek-api",
			"zai-api",
			"moonshot-api",
			"cerebras-api",
		]);
		expect(LINKED_ACCOUNT_ACCOUNT_SOURCES).toEqual(["oauth", "api-key"]);
		expect(LINKED_ACCOUNT_HEALTH_STATES).toEqual([
			"ok",
			"rate-limited",
			"needs-reauth",
			"invalid",
			"unknown",
			"expired",
		]);
	});

	it("exports each routing literal in canonical order", () => {
		expect(SERVICE_CAPABILITIES).toEqual([
			"llmText",
			"tts",
			"media",
			"embeddings",
			"rpc",
		]);
		expect(SERVICE_TRANSPORTS).toEqual(["direct", "cloud-proxy", "remote"]);
		expect(SERVICE_ROUTE_ACCOUNT_STRATEGIES).toEqual([
			"priority",
			"round-robin",
			"least-used",
			"quota-aware",
			"reset-soonest",
			"drain-soonest-reset",
		]);
	});

	it("derives readonly literal unions from the runtime constants", () => {
		expectTypeOf<
			(typeof LINKED_ACCOUNT_STATUSES)[number]
		>().toEqualTypeOf<LinkedAccountStatus>();
		expectTypeOf<
			(typeof LINKED_ACCOUNT_SOURCES)[number]
		>().toEqualTypeOf<LinkedAccountSource>();
		expectTypeOf<
			(typeof LINKED_ACCOUNT_PROVIDER_IDS)[number]
		>().toEqualTypeOf<LinkedAccountProviderId>();
		expectTypeOf<
			(typeof LINKED_ACCOUNT_ACCOUNT_SOURCES)[number]
		>().toEqualTypeOf<LinkedAccountAccountSource>();
		expectTypeOf<
			(typeof LINKED_ACCOUNT_HEALTH_STATES)[number]
		>().toEqualTypeOf<LinkedAccountHealth>();
		expectTypeOf<
			(typeof SERVICE_CAPABILITIES)[number]
		>().toEqualTypeOf<ServiceCapability>();
		expectTypeOf<
			(typeof SERVICE_TRANSPORTS)[number]
		>().toEqualTypeOf<ServiceTransport>();
		expectTypeOf<
			(typeof SERVICE_ROUTE_ACCOUNT_STRATEGIES)[number]
		>().toEqualTypeOf<ServiceRouteAccountStrategy>();
	});

	it("represents legacy flags and complete linked-account records", () => {
		const flag: LinkedAccountFlagConfig = {
			status: "linked",
			source: "subscription",
			userId: "user-1",
			organizationId: "org-1",
		};
		const flags: LinkedAccountFlagsConfig = { elizacloud: flag };
		const account: LinkedAccountConfig = {
			id: "account-1",
			providerId: "openai-codex",
			label: "Primary",
			source: "oauth",
			enabled: true,
			priority: 1,
			prioritySource: "explicit",
			createdAt: 1_700_000_000_000,
			lastUsedAt: 1_700_000_000_100,
			lastPrimedAt: 1_700_000_000_200,
			health: "rate-limited",
			healthDetail: {
				until: 1_700_000_000_300,
				lastError: "quota exhausted",
				lastChecked: 1_700_000_000_250,
			},
			usage: {
				sessionPct: 50,
				weeklyPct: 25,
				weeklyModelBuckets: {
					"gpt-5": { pct: 10, resetsAt: 1_700_000_000_400 },
				},
				resetsAt: 1_700_000_000_500,
				refreshedAt: 1_700_000_000_260,
			},
			subscriptionEndsAt: 1_800_000_000_000,
			organizationId: "org-1",
			userId: "user-1",
			email: "owner@example.com",
		};
		const accounts: LinkedAccountsConfig = { [account.id]: account };

		expect(flags.elizacloud).toBe(flag);
		expect(accounts[account.id]).toBe(account);
		expectTypeOf(account.healthDetail).toEqualTypeOf<
			LinkedAccountHealthDetail | undefined
		>();
		expectTypeOf(account.usage).toEqualTypeOf<LinkedAccountUsage | undefined>();
	});

	it("represents empty and fully configured service routing", () => {
		const empty: ServiceRoutingConfig = {};
		const route: ServiceRouteConfig = {
			backend: "openai",
			transport: "remote",
			accountId: "account-1",
			accountIds: ["account-1", "account-2"],
			strategy: "round-robin",
			primaryModel: "primary",
			nanoModel: "nano",
			smallModel: "small",
			mediumModel: "medium",
			largeModel: "large",
			megaModel: "mega",
			remoteApiBase: "https://api.example.com",
			responseHandlerModel: "response-handler",
			shouldRespondModel: "should-respond",
			actionPlannerModel: "action-planner",
			plannerModel: "planner",
			responseModel: "response",
			mediaDescriptionModel: "media-description",
		};
		const routing: ServiceRoutingConfig = {
			llmText: route,
			tts: {},
			media: {},
			embeddings: {},
			rpc: {},
		};

		expect(empty).toEqual({});
		expect(routing.llmText).toBe(route);
		expect(Object.keys(routing)).toEqual(SERVICE_CAPABILITIES);
	});

	it("re-exports deployment target contracts", () => {
		const runtime: DeploymentTargetRuntime = "remote";
		const config: DeploymentTargetConfig = {
			runtime,
			provider: "remote",
			remoteApiBase: "https://api.example.com",
			remoteAccessToken: "token",
		};

		expect(config.runtime).toBe("remote");
		expectTypeOf(config).toEqualTypeOf<DeploymentTargetConfig>();
	});
});
