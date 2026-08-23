/**
 * Pins the runtime-contract barrel's public value and type surface while
 * exercising its re-exported cloud-topology helpers through real configs.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type {
	CharacterLanguage,
	ConnectorAdminWhitelist,
	DeploymentTargetConfig,
	MessageExample,
	RoleName,
	ServiceRouteConfig,
	StylePreset,
	WalletAddressPair,
} from "./runtime-contracts.js";
import * as runtimeContracts from "./runtime-contracts.js";

describe("runtime contracts barrel", () => {
	it("exports the complete runtime value surface", () => {
		expect(Object.keys(runtimeContracts).sort()).toEqual([
			"CHARACTER_LANGUAGES",
			"DEPLOYMENT_TARGET_RUNTIMES",
			"ELIZA_CLOUD_SERVICES",
			"LINKED_ACCOUNT_ACCOUNT_SOURCES",
			"LINKED_ACCOUNT_HEALTH_STATES",
			"LINKED_ACCOUNT_PROVIDER_IDS",
			"LINKED_ACCOUNT_SOURCES",
			"LINKED_ACCOUNT_STATUSES",
			"SERVICE_CAPABILITIES",
			"SERVICE_ROUTE_ACCOUNT_STRATEGIES",
			"SERVICE_TRANSPORTS",
			"isElizaCloudLinkedInConfig",
			"isElizaCloudServiceSelectedInConfig",
			"resolveElizaCloudTopology",
			"shouldLoadElizaCloudPluginInConfig",
		]);
	});

	it("preserves the literal vocabularies re-exported by the barrel", () => {
		expect(runtimeContracts.CHARACTER_LANGUAGES).toEqual([
			"en",
			"zh-CN",
			"ko",
			"es",
			"pt",
			"vi",
			"tl",
		]);
		expect(runtimeContracts.DEPLOYMENT_TARGET_RUNTIMES).toEqual([
			"local",
			"cloud",
			"remote",
		]);
		expect(runtimeContracts.ELIZA_CLOUD_SERVICES).toEqual([
			"inference",
			"tts",
			"media",
			"embeddings",
			"rpc",
		]);
		expect(runtimeContracts.LINKED_ACCOUNT_STATUSES).toEqual([
			"linked",
			"unlinked",
		]);
		expect(runtimeContracts.LINKED_ACCOUNT_SOURCES).toEqual([
			"api-key",
			"oauth",
			"credentials",
			"subscription",
		]);
		expect(runtimeContracts.LINKED_ACCOUNT_ACCOUNT_SOURCES).toEqual([
			"oauth",
			"api-key",
		]);
		expect(runtimeContracts.LINKED_ACCOUNT_HEALTH_STATES).toEqual([
			"ok",
			"rate-limited",
			"needs-reauth",
			"invalid",
			"unknown",
			"expired",
		]);
		expect(runtimeContracts.LINKED_ACCOUNT_PROVIDER_IDS).toEqual([
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
		expect(runtimeContracts.SERVICE_CAPABILITIES).toEqual([
			"llmText",
			"tts",
			"media",
			"embeddings",
			"rpc",
		]);
		expect(runtimeContracts.SERVICE_TRANSPORTS).toEqual([
			"direct",
			"cloud-proxy",
			"remote",
		]);
		expect(runtimeContracts.SERVICE_ROUTE_ACCOUNT_STRATEGIES).toEqual([
			"priority",
			"round-robin",
			"least-used",
			"quota-aware",
			"reset-soonest",
			"drain-soonest-reset",
		]);
	});

	it("keeps type-only contracts available from each source barrel", () => {
		expectTypeOf<CharacterLanguage>().toEqualTypeOf<
			(typeof runtimeContracts.CHARACTER_LANGUAGES)[number]
		>();
		expectTypeOf<DeploymentTargetConfig>().toMatchTypeOf<{
			runtime: "local" | "cloud" | "remote";
		}>();
		expectTypeOf<ServiceRouteConfig>().toHaveProperty("transport");
		expectTypeOf<WalletAddressPair>().toEqualTypeOf<{
			evmAddress: string | null;
			solanaAddress: string | null;
		}>();
		expectTypeOf<RoleName>().toEqualTypeOf<"OWNER" | "ADMIN" | "NONE">();
		expectTypeOf<ConnectorAdminWhitelist>().toBeObject();
		expectTypeOf<MessageExample>().toHaveProperty("content");
		expectTypeOf<StylePreset>().toHaveProperty("templates");
	});

	it("routes cloud selection through the re-exported helpers", () => {
		const config = {
			linkedAccounts: {
				elizacloud: { status: "linked", source: "oauth" },
			},
			deploymentTarget: { runtime: "local" },
			serviceRouting: {
				llmText: { backend: "elizacloud", transport: "cloud-proxy" },
				tts: { backend: "local", transport: "direct" },
			},
		};

		expect(runtimeContracts.resolveElizaCloudTopology(config)).toEqual({
			linked: true,
			provider: "elizacloud",
			runtime: "local",
			services: {
				inference: true,
				tts: false,
				media: false,
				embeddings: false,
				rpc: false,
			},
			shouldLoadPlugin: true,
		});
		expect(
			runtimeContracts.isElizaCloudServiceSelectedInConfig(config, "inference"),
		).toBe(true);
		expect(runtimeContracts.isElizaCloudLinkedInConfig(config)).toBe(true);
		expect(runtimeContracts.shouldLoadElizaCloudPluginInConfig(config)).toBe(
			true,
		);
		expect(runtimeContracts.resolveElizaCloudTopology(undefined)).toEqual({
			linked: false,
			provider: null,
			runtime: "local",
			services: {
				inference: false,
				tts: false,
				media: false,
				embeddings: false,
				rpc: false,
			},
			shouldLoadPlugin: false,
		});
	});
});
