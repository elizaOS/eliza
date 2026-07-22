/**
 * Drift tests for literal contract exports consumed outside @elizaos/contracts.
 *
 * Runtime assertions pin the exported tuple values while expectTypeOf checks
 * keep their public union types aligned with those literals.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	type BscTradeRoutePreference,
	type BscTradeRouteProvider,
	type BscTradeSide,
	type BscTradeTxStatus,
	CHARACTER_LANGUAGES,
	type CharacterLanguage,
	DEFAULT_TASK_EXECUTION_PROFILE,
	DEPLOYMENT_TARGET_RUNTIMES,
	type DeploymentTargetRuntime,
	ELIZA_CLOUD_SERVICES,
	type ElizaCloudService,
	type EvmSigningCapabilityKind,
	LINKED_ACCOUNT_ACCOUNT_SOURCES,
	LINKED_ACCOUNT_HEALTH_STATES,
	LINKED_ACCOUNT_PROVIDER_IDS,
	LINKED_ACCOUNT_SOURCES,
	LINKED_ACCOUNT_STATUSES,
	type LinkedAccountAccountSource,
	type LinkedAccountHealth,
	type LinkedAccountProviderId,
	type LinkedAccountSource,
	type LinkedAccountStatus,
	type ResolvedElizaCloudTopology,
	type RoleGrantSource,
	type RoleName,
	SERVICE_CAPABILITIES,
	SERVICE_ROUTE_ACCOUNT_STRATEGIES,
	SERVICE_TRANSPORTS,
	type ServiceCapability,
	type ServiceRouteAccountStrategy,
	type ServiceTransport,
	type StewardWebhookEventType,
	TASK_EXECUTION_PROFILES,
	type TaskExecutionProfile,
	type TradePermissionMode,
	type WalletChainKind,
	type WalletMarketOverviewProviderId,
	type WalletNetworkMode,
	type WalletProviderKind,
	type WalletSource,
} from './index.js';

describe('@elizaos/contracts public literals', () => {
	it('exports the service capability literals consumed by routing configs', () => {
		expect([...SERVICE_CAPABILITIES]).toEqual(['llmText', 'tts', 'media', 'embeddings', 'rpc']);
		expect(new Set(SERVICE_CAPABILITIES).size).toBe(SERVICE_CAPABILITIES.length);

		expectTypeOf<ServiceCapability>().toEqualTypeOf<(typeof SERVICE_CAPABILITIES)[number]>();
	});

	it('exports the linked account literals consumed by account configs', () => {
		expect([...LINKED_ACCOUNT_STATUSES]).toEqual(['linked', 'unlinked']);
		expect([...LINKED_ACCOUNT_SOURCES]).toEqual([
			'api-key',
			'oauth',
			'credentials',
			'subscription',
		]);
		expect([...LINKED_ACCOUNT_ACCOUNT_SOURCES]).toEqual(['oauth', 'api-key']);
		expect([...LINKED_ACCOUNT_HEALTH_STATES]).toEqual([
			'ok',
			'rate-limited',
			'needs-reauth',
			'invalid',
			'unknown',
			'expired',
		]);
		expect([...LINKED_ACCOUNT_PROVIDER_IDS]).toEqual([
			'anthropic-subscription',
			'openai-codex',
			'gemini-cli',
			'zai-coding',
			'kimi-coding',
			'deepseek-coding',
			'anthropic-api',
			'openai-api',
			'deepseek-api',
			'zai-api',
			'moonshot-api',
			'cerebras-api',
		]);

		expect(new Set(LINKED_ACCOUNT_PROVIDER_IDS).size).toBe(LINKED_ACCOUNT_PROVIDER_IDS.length);
		expectTypeOf<LinkedAccountStatus>().toEqualTypeOf<(typeof LINKED_ACCOUNT_STATUSES)[number]>();
		expectTypeOf<LinkedAccountSource>().toEqualTypeOf<(typeof LINKED_ACCOUNT_SOURCES)[number]>();
		expectTypeOf<LinkedAccountAccountSource>().toEqualTypeOf<
			(typeof LINKED_ACCOUNT_ACCOUNT_SOURCES)[number]
		>();
		expectTypeOf<LinkedAccountHealth>().toEqualTypeOf<
			(typeof LINKED_ACCOUNT_HEALTH_STATES)[number]
		>();
		expectTypeOf<LinkedAccountProviderId>().toEqualTypeOf<
			(typeof LINKED_ACCOUNT_PROVIDER_IDS)[number]
		>();
	});

	it('exports the transport literals accepted by service routes', () => {
		expect([...SERVICE_TRANSPORTS]).toEqual(['direct', 'cloud-proxy', 'remote']);
		expect(new Set(SERVICE_TRANSPORTS).size).toBe(SERVICE_TRANSPORTS.length);

		expectTypeOf<ServiceTransport>().toEqualTypeOf<(typeof SERVICE_TRANSPORTS)[number]>();
	});

	it('exports the route account strategy literals', () => {
		expect([...SERVICE_ROUTE_ACCOUNT_STRATEGIES]).toEqual([
			'priority',
			'round-robin',
			'least-used',
			'quota-aware',
			'reset-soonest',
			'drain-soonest-reset',
		]);
		expect(new Set(SERVICE_ROUTE_ACCOUNT_STRATEGIES).size).toBe(
			SERVICE_ROUTE_ACCOUNT_STRATEGIES.length
		);

		expectTypeOf<ServiceRouteAccountStrategy>().toEqualTypeOf<
			(typeof SERVICE_ROUTE_ACCOUNT_STRATEGIES)[number]
		>();
	});

	it('exports the deployment runtime literals', () => {
		expect([...DEPLOYMENT_TARGET_RUNTIMES]).toEqual(['local', 'cloud', 'remote']);
		expect(new Set(DEPLOYMENT_TARGET_RUNTIMES).size).toBe(DEPLOYMENT_TARGET_RUNTIMES.length);

		expectTypeOf<DeploymentTargetRuntime>().toEqualTypeOf<
			(typeof DEPLOYMENT_TARGET_RUNTIMES)[number]
		>();
	});

	it('exports exhaustive Eliza Cloud topology service literals', () => {
		expect([...ELIZA_CLOUD_SERVICES]).toEqual(['inference', 'tts', 'media', 'embeddings', 'rpc']);
		expect(new Set(ELIZA_CLOUD_SERVICES).size).toBe(ELIZA_CLOUD_SERVICES.length);

		const services = {
			inference: true,
			tts: true,
			media: false,
			embeddings: true,
			rpc: true,
		} satisfies ResolvedElizaCloudTopology['services'];

		expect(Object.keys(services).sort()).toEqual([...ELIZA_CLOUD_SERVICES].sort());
		expectTypeOf<ElizaCloudService>().toEqualTypeOf<(typeof ELIZA_CLOUD_SERVICES)[number]>();
	});

	it('exports character language literals consumed by style presets', () => {
		expect([...CHARACTER_LANGUAGES]).toEqual(['en', 'zh-CN', 'ko', 'es', 'pt', 'vi', 'tl']);
		expect(new Set(CHARACTER_LANGUAGES).size).toBe(CHARACTER_LANGUAGES.length);

		expectTypeOf<CharacterLanguage>().toEqualTypeOf<(typeof CHARACTER_LANGUAGES)[number]>();
	});

	it('keeps scheduled-task execution profile literals exhaustive for runner + host probe', () => {
		expect([...TASK_EXECUTION_PROFILES]).toEqual([
			'foreground',
			'bg-light-30s',
			'bg-heavy-fgs',
			'notify-only',
		]);
		expect(new Set(TASK_EXECUTION_PROFILES).size).toBe(TASK_EXECUTION_PROFILES.length);
		expect(DEFAULT_TASK_EXECUTION_PROFILE).toBe('foreground');

		expectTypeOf<TaskExecutionProfile>().toEqualTypeOf<(typeof TASK_EXECUTION_PROFILES)[number]>();
	});

	it('keeps role unions exhaustive for role-resolution consumers', () => {
		const roleNames = ['OWNER', 'ADMIN', 'USER', 'GUEST'] as const;
		const roleGrantSources = ['owner', 'manual', 'connector_admin'] as const;

		expectTypeOf<RoleName>().toEqualTypeOf<(typeof roleNames)[number]>();
		expectTypeOf<RoleGrantSource>().toEqualTypeOf<(typeof roleGrantSources)[number]>();
	});

	it('keeps wallet union contracts exhaustive for wallet API consumers', () => {
		const networkModes = ['mainnet', 'testnet'] as const;
		const walletSources = ['local', 'cloud'] as const;
		const chainKinds = ['evm', 'solana'] as const;
		const providerKinds = ['local', 'privy', 'steward'] as const;
		const tradePermissionModes = [
			'user-sign-only',
			'manual-local-key',
			'agent-auto',
			'disabled',
		] as const;
		const bscTradeSides = ['buy', 'sell'] as const;
		const bscTradeRouteProviders = ['pancakeswap-v2', '0x'] as const;
		const bscTradeRoutePreferences = ['pancakeswap-v2', '0x', 'auto'] as const;
		const bscTradeStatuses = ['pending', 'success', 'reverted', 'not_found'] as const;
		const evmSigningCapabilityKinds = [
			'local',
			'steward-self',
			'steward-cloud',
			'cloud-view-only',
			'none',
		] as const;
		const marketOverviewProviders = ['coingecko', 'polymarket'] as const;
		const stewardWebhookEvents = [
			'tx.pending',
			'tx.approved',
			'tx.denied',
			'tx.confirmed',
		] as const;

		expectTypeOf<WalletNetworkMode>().toEqualTypeOf<(typeof networkModes)[number]>();
		expectTypeOf<WalletSource>().toEqualTypeOf<(typeof walletSources)[number]>();
		expectTypeOf<WalletChainKind>().toEqualTypeOf<(typeof chainKinds)[number]>();
		expectTypeOf<WalletProviderKind>().toEqualTypeOf<(typeof providerKinds)[number]>();
		expectTypeOf<TradePermissionMode>().toEqualTypeOf<(typeof tradePermissionModes)[number]>();
		expectTypeOf<BscTradeSide>().toEqualTypeOf<(typeof bscTradeSides)[number]>();
		expectTypeOf<BscTradeRouteProvider>().toEqualTypeOf<(typeof bscTradeRouteProviders)[number]>();
		expectTypeOf<BscTradeRoutePreference>().toEqualTypeOf<
			(typeof bscTradeRoutePreferences)[number]
		>();
		expectTypeOf<BscTradeTxStatus>().toEqualTypeOf<(typeof bscTradeStatuses)[number]>();
		expectTypeOf<EvmSigningCapabilityKind>().toEqualTypeOf<
			(typeof evmSigningCapabilityKinds)[number]
		>();
		expectTypeOf<WalletMarketOverviewProviderId>().toEqualTypeOf<
			(typeof marketOverviewProviders)[number]
		>();
		expectTypeOf<StewardWebhookEventType>().toEqualTypeOf<(typeof stewardWebhookEvents)[number]>();
	});
});
