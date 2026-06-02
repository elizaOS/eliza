import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	DEPLOYMENT_TARGET_RUNTIMES,
	type DeploymentTargetRuntime,
	ELIZA_CLOUD_SERVICES,
	type ElizaCloudService,
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
	SERVICE_CAPABILITIES,
	SERVICE_ROUTE_ACCOUNT_STRATEGIES,
	SERVICE_TRANSPORTS,
	type ServiceCapability,
	type ServiceRouteAccountStrategy,
	type ServiceTransport,
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
});
