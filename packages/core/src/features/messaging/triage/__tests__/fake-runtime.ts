/**
 * Minimal IAgentRuntime stub sufficient for triage unit tests.
 *
 * We mock at the *service* layer (getService only) — the code under test
 * does not reach the DB, model, or networking layers, so we avoid
 * constructing a full runtime. This matches the "no SQL mocks" guidance:
 * there is no SQL here, and real services for gmail/discord/etc. would be
 * cross-cutting integrations outside this unit's scope.
 */

import type {
	ContactInfo,
	RelationshipsService,
} from "../../../../services/relationships.ts";
import type { IAgentRuntime, UUID } from "../../../../types/index.ts";

export interface FakeRuntimeOptions {
	contactsByHandle?: Map<string, ContactInfo>;
	availableServices?: Set<string>;
	/** If true, no relationships service is registered. */
	noRelationships?: boolean;
}

function key(platform: string, identifier: string): string {
	return `${platform.toLowerCase()}|${identifier.toLowerCase()}`;
}

export function fakeContact(entityId: UUID, categories: string[]): ContactInfo {
	return {
		entityId,
		categories,
		tags: [],
		preferences: {},
		customFields: {},
		privacyLevel: "private",
		lastModified: new Date().toISOString(),
		handles: [],
		interactions: [],
		relationshipStatus: "active",
	};
}

export function createFakeRuntime(
	opts: FakeRuntimeOptions = {},
): IAgentRuntime {
	const services = new Map<string, unknown>();

	if (!opts.noRelationships) {
		const fakeService: Pick<RelationshipsService, "findByHandle"> = {
			findByHandle: async (platform, identifier) => {
				const k = key(platform, identifier);
				return opts.contactsByHandle?.get(k) ?? null;
			},
		};
		services.set("relationships", fakeService);
	}

	if (opts.availableServices) {
		for (const name of opts.availableServices) {
			if (!services.has(name)) services.set(name, { __stub: true });
		}
	}

	const runtime = {
		getService: (name: string) => services.get(name) ?? null,
	} as IAgentRuntime;

	return runtime;
}
