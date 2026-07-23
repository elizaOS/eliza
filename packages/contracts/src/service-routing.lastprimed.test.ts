/**
 * Drift test for the `lastPrimedAt` field added to `LinkedAccountConfig`
 * (#16482). Pins the field's optional epoch-ms shape at the contracts layer
 * and re-asserts the runtime literals this module exports so the
 * subscription-priming consumers (@elizaos/shared normalizers, app-core
 * AccountPool) cannot drift from the source-of-truth type.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	LINKED_ACCOUNT_ACCOUNT_SOURCES,
	LINKED_ACCOUNT_HEALTH_STATES,
	LINKED_ACCOUNT_PROVIDER_IDS,
	type LinkedAccountConfig,
} from './service-routing.js';

describe('LinkedAccountConfig.lastPrimedAt contract', () => {
	it('declares lastPrimedAt as an optional epoch-ms number', () => {
		expectTypeOf<LinkedAccountConfig['lastPrimedAt']>().toEqualTypeOf<number | undefined>();

		const withPriming: LinkedAccountConfig = {
			id: 'acct-1',
			providerId: 'anthropic-subscription',
			label: 'Primary',
			source: 'oauth',
			enabled: true,
			priority: 1,
			createdAt: 1_700_000_000_000,
			health: 'ok',
			lastPrimedAt: 1_700_000_123_456,
		};
		expect(withPriming.lastPrimedAt).toBe(1_700_000_123_456);

		// The field stays optional: a record without it must still typecheck.
		const withoutPriming: LinkedAccountConfig = {
			...withPriming,
			id: 'acct-2',
		};
		delete withoutPriming.lastPrimedAt;
		expect(withoutPriming.lastPrimedAt).toBeUndefined();
	});

	it('keeps the priming-relevant runtime literals stable', () => {
		expect(LINKED_ACCOUNT_PROVIDER_IDS).toContain('anthropic-subscription');
		expect([...LINKED_ACCOUNT_ACCOUNT_SOURCES]).toEqual(['oauth', 'api-key']);
		expect(LINKED_ACCOUNT_HEALTH_STATES).toContain('ok');
	});
});
