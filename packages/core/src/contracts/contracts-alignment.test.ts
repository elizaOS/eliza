/**
 * Guards that core's contract implementations stay aligned with the
 * `@elizaos/contracts` literals they mirror: service capabilities/transports,
 * deployment runtimes, linked-account and wallet-RPC normalizers, and resolved
 * cloud-topology keys. Pure deterministic assertions over fixture configs.
 */
import {
	type BscWalletRpcProvider,
	SERVICE_CAPABILITIES as CONTRACT_SERVICE_CAPABILITIES,
	DEPLOYMENT_TARGET_RUNTIMES,
	ELIZA_CLOUD_SERVICES,
	type EvmWalletRpcProvider,
	LINKED_ACCOUNT_PROVIDER_IDS,
	type LinkedAccountAccountSource,
	type LinkedAccountConfig,
	type LinkedAccountHealth,
	SERVICE_TRANSPORTS,
	type ServiceRouteAccountStrategy,
	type ServiceRouteConfig,
	type SolanaWalletRpcProvider,
	type WalletRpcCredentialKey,
} from "@elizaos/contracts";
import { describe, expect, it } from "vitest";
import {
	buildWalletRpcUpdateRequest,
	normalizeWalletRpcSelections as normalizeSharedWalletRpcSelections,
	DEFAULT_WALLET_RPC_SELECTIONS as SHARED_DEFAULT_WALLET_RPC_SELECTIONS,
	WALLET_RPC_PROVIDER_OPTIONS as SHARED_WALLET_RPC_PROVIDER_OPTIONS,
} from "../../../shared/src/contracts/wallet.js";
import { resolveElizaCloudTopology } from "./cloud-topology.js";
import {
	normalizeDeploymentTargetConfig,
	normalizeLinkedAccountRecord,
	normalizeLinkedAccountsRecords,
	normalizeServiceRoutingConfig,
	SERVICE_CAPABILITIES,
} from "./service-routing.js";
import {
	DEFAULT_WALLET_RPC_SELECTIONS,
	normalizeWalletRpcProviderId,
	normalizeWalletRpcSelections,
	WALLET_RPC_PROVIDER_OPTIONS,
} from "./wallet.js";

const linkedAccountHealthValues = [
	"ok",
	"rate-limited",
	"needs-reauth",
	"invalid",
	"unknown",
] as const satisfies readonly LinkedAccountHealth[];

const linkedAccountSources = [
	"oauth",
	"api-key",
] as const satisfies readonly LinkedAccountAccountSource[];

const serviceRouteStrategies = [
	"priority",
	"round-robin",
	"least-used",
	"quota-aware",
] as const satisfies readonly ServiceRouteAccountStrategy[];

const walletCredentialKeys = [
	"ALCHEMY_API_KEY",
	"INFURA_API_KEY",
	"ANKR_API_KEY",
	"NODEREAL_BSC_RPC_URL",
	"QUICKNODE_BSC_RPC_URL",
	"HELIUS_API_KEY",
	"BIRDEYE_API_KEY",
	"ETHEREUM_RPC_URL",
	"BASE_RPC_URL",
	"AVALANCHE_RPC_URL",
	"BSC_RPC_URL",
	"SOLANA_RPC_URL",
] as const satisfies readonly WalletRpcCredentialKey[];

function providerIds<T extends { id: string }>(
	options: readonly T[],
): string[] {
	return options.map((option) => option.id);
}

function validLinkedAccount(
	overrides: Partial<LinkedAccountConfig> = {},
): LinkedAccountConfig {
	return {
		id: "acct-1",
		providerId: "openai-codex",
		label: "OpenAI Codex",
		source: "oauth",
		enabled: true,
		priority: 10,
		createdAt: 1_700_000_000_000,
		health: "ok",
		...overrides,
	};
}

describe("core contract implementation alignment", () => {
	it("keeps service capability literals aligned with @elizaos/contracts", () => {
		expect([...SERVICE_CAPABILITIES]).toEqual([
			...CONTRACT_SERVICE_CAPABILITIES,
		]);

		for (const capability of CONTRACT_SERVICE_CAPABILITIES) {
			expect(
				normalizeServiceRoutingConfig({
					[capability]: {
						backend: "local",
						transport: "direct",
					},
				}),
			).toEqual({
				[capability]: {
					backend: "local",
					transport: "direct",
				},
			});
		}

		expect(
			normalizeServiceRoutingConfig({
				notAService: { backend: "local", transport: "direct" },
			}),
		).toBeNull();
	});

	it("keeps service transport literals accepted and strips unknown transports", () => {
		for (const transport of SERVICE_TRANSPORTS) {
			expect(
				normalizeServiceRoutingConfig({
					llmText: {
						backend: "local",
						transport,
					},
				})?.llmText?.transport,
			).toBe(transport);
		}

		expect(
			normalizeServiceRoutingConfig({
				llmText: {
					backend: "local",
					transport: "unsafe-transport",
				},
			}),
		).toEqual({ llmText: { backend: "local" } });
	});

	it("preserves all service route contract fields accepted by core", () => {
		const route = {
			backend: " elizacloud ",
			transport: "cloud-proxy",
			accountId: " acct-primary ",
			accountIds: [" acct-primary ", "acct-primary", "", 1, "acct-backup"],
			strategy: "quota-aware",
			primaryModel: " primary ",
			nanoModel: " nano ",
			smallModel: " small ",
			mediumModel: " medium ",
			largeModel: " large ",
			megaModel: " mega ",
			responseHandlerModel: " response-handler ",
			shouldRespondModel: " should-respond ",
			actionPlannerModel: " action-planner ",
			plannerModel: " planner ",
			responseModel: " response ",
			mediaDescriptionModel: " media-description ",
			remoteApiBase: " https://remote.example ",
		};

		expect(normalizeServiceRoutingConfig({ llmText: route })).toEqual({
			llmText: {
				backend: "elizacloud",
				transport: "cloud-proxy",
				accountId: "acct-primary",
				accountIds: ["acct-primary", "acct-backup"],
				strategy: "quota-aware",
				primaryModel: "primary",
				nanoModel: "nano",
				smallModel: "small",
				mediumModel: "medium",
				largeModel: "large",
				megaModel: "mega",
				responseHandlerModel: "response-handler",
				shouldRespondModel: "should-respond",
				actionPlannerModel: "action-planner",
				plannerModel: "planner",
				responseModel: "response",
				mediaDescriptionModel: "media-description",
				remoteApiBase: "https://remote.example",
			} satisfies ServiceRouteConfig,
		});

		for (const strategy of serviceRouteStrategies) {
			expect(
				normalizeServiceRoutingConfig({
					llmText: {
						backend: "local",
						strategy,
					},
				})?.llmText?.strategy,
			).toBe(strategy);
		}

		expect(
			normalizeServiceRoutingConfig({
				llmText: {
					strategy: "unknown",
				},
			}),
		).toBeNull();
	});

	it("keeps deployment runtimes accepted and rejects unknown runtimes", () => {
		for (const runtime of DEPLOYMENT_TARGET_RUNTIMES) {
			expect(normalizeDeploymentTargetConfig({ runtime })).toEqual({ runtime });
		}

		expect(normalizeDeploymentTargetConfig({ runtime: "edge" })).toBeNull();
	});

	it("preserves deployment provider and remote fields while failing closed", () => {
		expect(
			normalizeDeploymentTargetConfig({
				runtime: "remote",
				provider: "remote",
				remoteApiBase: " https://runtime.example ",
				remoteAccessToken: " token ",
			}),
		).toEqual({
			runtime: "remote",
			provider: "remote",
			remoteApiBase: "https://runtime.example",
			remoteAccessToken: "token",
		});

		expect(
			normalizeDeploymentTargetConfig({
				runtime: "local",
				provider: "unsupported",
			}),
		).toEqual({ runtime: "local" });
		expect(normalizeDeploymentTargetConfig(null)).toBeNull();
		expect(normalizeDeploymentTargetConfig([])).toBeNull();
		expect(normalizeDeploymentTargetConfig({})).toBeNull();
	});

	it("accepts linked account contract literals and preserves optional fields", () => {
		for (const providerId of LINKED_ACCOUNT_PROVIDER_IDS) {
			expect(
				normalizeLinkedAccountRecord(validLinkedAccount({ providerId }))
					?.providerId,
			).toBe(providerId);
		}
		for (const health of linkedAccountHealthValues) {
			expect(
				normalizeLinkedAccountRecord(validLinkedAccount({ health }))?.health,
			).toBe(health);
		}
		for (const source of linkedAccountSources) {
			expect(
				normalizeLinkedAccountRecord(validLinkedAccount({ source }))?.source,
			).toBe(source);
		}

		expect(
			normalizeLinkedAccountRecord(
				validLinkedAccount({
					lastUsedAt: 1_700_000_001_000,
					healthDetail: {
						until: 1_700_000_002_000,
						lastError: " rate limited ",
						lastChecked: 1_700_000_003_000,
					},
					usage: {
						sessionPct: 50,
						weeklyPct: 75,
						resetsAt: 1_700_000_004_000,
						refreshedAt: 1_700_000_005_000,
					},
					organizationId: " org-1 ",
					userId: " user-1 ",
					email: " user@example.com ",
				}),
			),
		).toEqual({
			id: "acct-1",
			providerId: "openai-codex",
			label: "OpenAI Codex",
			source: "oauth",
			enabled: true,
			priority: 10,
			createdAt: 1_700_000_000_000,
			health: "ok",
			lastUsedAt: 1_700_000_001_000,
			healthDetail: {
				until: 1_700_000_002_000,
				lastError: "rate limited",
				lastChecked: 1_700_000_003_000,
			},
			usage: {
				sessionPct: 50,
				weeklyPct: 75,
				resetsAt: 1_700_000_004_000,
				refreshedAt: 1_700_000_005_000,
			},
			organizationId: "org-1",
			userId: "user-1",
			email: "user@example.com",
		});

		expect(
			normalizeLinkedAccountRecord(
				validLinkedAccount({
					providerId: "unknown" as LinkedAccountProviderId,
				}),
			),
		).toBeNull();
		expect(
			normalizeLinkedAccountRecord(
				validLinkedAccount({
					source: "credentials" as LinkedAccountAccountSource,
				}),
			),
		).toBeNull();
		expect(
			normalizeLinkedAccountsRecords({
				"acct-1": validLinkedAccount({ id: "acct-2" }),
			}),
		).toBeNull();
	});

	it("keeps resolved Eliza Cloud topology keys aligned with the contract", () => {
		const topology = resolveElizaCloudTopology({
			serviceRouting: {
				llmText: { backend: "elizacloud", transport: "cloud-proxy" },
				tts: { backend: "elizacloud", transport: "cloud-proxy" },
				media: { backend: "local", transport: "direct" },
				embeddings: { backend: "elizacloud", transport: "cloud-proxy" },
				rpc: { backend: "elizacloud", transport: "cloud-proxy" },
			},
		});

		expect(Object.keys(topology.services).sort()).toEqual(
			[...ELIZA_CLOUD_SERVICES].sort(),
		);
		expect(topology.services).toEqual({
			inference: true,
			tts: true,
			media: false,
			embeddings: true,
			rpc: true,
		});
	});

	it("resolves cloud topology state from deployment, routing, and linkage", () => {
		expect(
			resolveElizaCloudTopology({
				deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
			}),
		).toMatchObject({
			linked: false,
			provider: "elizacloud",
			runtime: "cloud",
			shouldLoadPlugin: true,
		});

		expect(
			resolveElizaCloudTopology({
				serviceRouting: {
					llmText: { backend: "elizacloud", transport: "direct" },
					tts: { backend: "local", transport: "cloud-proxy" },
				},
			}).services,
		).toMatchObject({ inference: false, tts: false });

		expect(
			resolveElizaCloudTopology({
				linkedAccounts: { elizacloud: { status: "linked" } },
			}).linked,
		).toBe(true);
		expect(
			resolveElizaCloudTopology({ cloud: { apiKey: " key " } }).linked,
		).toBe(true);
		expect(
			resolveElizaCloudTopology({ cloud: { apiKey: " [REDACTED] " } }).linked,
		).toBe(false);
		expect(resolveElizaCloudTopology({ cloud: { apiKey: " " } }).linked).toBe(
			false,
		);
	});

	it("keeps wallet RPC helpers aligned across core, shared, and contracts", () => {
		expect(providerIds(WALLET_RPC_PROVIDER_OPTIONS.evm)).toEqual([
			"eliza-cloud",
			"alchemy",
			"infura",
			"ankr",
		] satisfies EvmWalletRpcProvider[]);
		expect(providerIds(WALLET_RPC_PROVIDER_OPTIONS.bsc)).toEqual([
			"eliza-cloud",
			"alchemy",
			"ankr",
			"nodereal",
			"quicknode",
		] satisfies BscWalletRpcProvider[]);
		expect(providerIds(WALLET_RPC_PROVIDER_OPTIONS.solana)).toEqual([
			"eliza-cloud",
			"helius-birdeye",
		] satisfies SolanaWalletRpcProvider[]);
		expect(WALLET_RPC_PROVIDER_OPTIONS).toEqual(
			SHARED_WALLET_RPC_PROVIDER_OPTIONS,
		);
		expect(DEFAULT_WALLET_RPC_SELECTIONS).toEqual(
			SHARED_DEFAULT_WALLET_RPC_SELECTIONS,
		);

		const selections = {
			evm: " ALCHEMY ",
			bsc: "quicknode",
			solana: "helius",
		};
		expect(normalizeWalletRpcSelections(selections)).toEqual({
			evm: "alchemy",
			bsc: "quicknode",
			solana: "helius-birdeye",
		});
		expect(normalizeSharedWalletRpcSelections(selections)).toEqual(
			normalizeWalletRpcSelections(selections),
		);
		expect(normalizeWalletRpcProviderId("evm", "elizacloud")).toBe(
			"eliza-cloud",
		);

		const request = buildWalletRpcUpdateRequest({
			walletConfig: {
				evmAddress: null,
				solanaAddress: null,
				selectedRpcProviders: DEFAULT_WALLET_RPC_SELECTIONS,
				legacyCustomChains: ["evm", "bsc", "solana"],
				alchemyKeySet: true,
				infuraKeySet: true,
				ankrKeySet: true,
				nodeRealBscRpcSet: true,
				quickNodeBscRpcSet: true,
				heliusKeySet: true,
				birdeyeKeySet: true,
				evmChains: [],
			},
			selectedProviders: {
				evm: "infura",
				bsc: "nodereal",
				solana: "helius-birdeye",
			},
			rpcFieldValues: {
				INFURA_API_KEY: " infura ",
				NODEREAL_BSC_RPC_URL: " nodereal ",
				HELIUS_API_KEY: " helius ",
				BIRDEYE_API_KEY: " birdeye ",
			},
		});

		expect(Object.keys(request.credentials ?? {}).sort()).toEqual(
			[...walletCredentialKeys].sort(),
		);
		expect(request.credentials).toMatchObject({
			INFURA_API_KEY: "infura",
			NODEREAL_BSC_RPC_URL: "nodereal",
			HELIUS_API_KEY: "helius",
			BIRDEYE_API_KEY: "birdeye",
			ALCHEMY_API_KEY: "",
			ANKR_API_KEY: "",
			QUICKNODE_BSC_RPC_URL: "",
			ETHEREUM_RPC_URL: "",
			BASE_RPC_URL: "",
			AVALANCHE_RPC_URL: "",
			BSC_RPC_URL: "",
			SOLANA_RPC_URL: "",
		});
	});
});
