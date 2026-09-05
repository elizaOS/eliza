/**
 * Typed partial runtime for isolated unit tests.
 *
 * This is the unit-test counterpart to {@link ./integration-runtime}. Integration
 * tests use a real {@link AgentRuntime} backed by real infrastructure (the
 * "NO MOCKS" rule in `./index.ts`); unit tests that exercise a single
 * action/provider/service in isolation legitimately need a lightweight stand-in
 * runtime instead.
 *
 * Before this helper, ~200 unit tests each hand-rolled
 * `{ getSetting: () => …, useModel: vi.fn() } as unknown as IAgentRuntime`.
 * Every one of those was an `as unknown as` escape with zero type-checking on the
 * mocked surface. `createMockRuntime` replaces them with a single, typed factory:
 *
 * - The `overrides` parameter is `Partial<IAgentRuntime>`, so the fields a test
 *   supplies are now **type-checked** against the real runtime contract.
 * - The unavoidable partial→full cast lives in exactly one audited place here
 *   (a plain `as`, since `IAgentRuntime` is assignable to `Partial<IAgentRuntime>`),
 *   instead of being copy-pasted as `as unknown as` across the suite.
 *
 * @example
 * ```ts
 * import { createMockRuntime } from "@elizaos/core/testing";
 *
 * const runtime = createMockRuntime({
 *   getSetting: (key) => (key === "MODE" ? "chatty" : undefined),
 *   useModel: vi.fn(async () => "ok"),
 * });
 * ```
 */

import { jsonValueEquals } from "../database/cas-values";
import type { Character, IAgentRuntime, UUID } from "../types";

/** Stable zero-UUID used as the default agent/entity id in unit tests. */
export const MOCK_AGENT_ID = "00000000-0000-0000-0000-000000000000" as UUID;

/** Minimal character; override via `createMockRuntime({ character })` when a test needs specific fields. */
const MOCK_CHARACTER: Character = {
	name: "MockAgent",
	bio: [],
	templates: {},
	messageExamples: [],
	postExamples: [],
	topics: [],
	adjectives: [],
	knowledge: [],
	plugins: [],
	secrets: {},
	settings: {},
};

/**
 * Build a typed mock {@link IAgentRuntime} for a unit test. Only the structural
 * required properties (`agentId`, `character`, the registry arrays/maps) are
 * defaulted, along with the diagnostic sink required by service code. Pass
 * behavior-bearing methods a test needs via `overrides` so they remain explicit
 * and type-checked against `IAgentRuntime`.
 */
export function createMockRuntime(
	overrides: Partial<IAgentRuntime> = {},
): IAgentRuntime {
	// Shared backing map so the default cache trio behaves like one store
	// (getCache sees setCache writes; CAS compares against the same snapshot).
	const cache = new Map<string, unknown>();
	const base: Partial<IAgentRuntime> = {
		agentId: MOCK_AGENT_ID,
		character: MOCK_CHARACTER,
		providers: [],
		actions: [],
		evaluators: [],
		plugins: [],
		routes: [],
		services: new Map(),
		stateCache: new Map(),
		reportError: () => undefined,
		// An unset setting reads as null on the real runtime; defaulting it here
		// keeps setting-gated code paths on their default branch in unit tests
		// unless a test overrides specific keys.
		getSetting: () => null,
		getCache: async <T>(key: string): Promise<T | undefined> =>
			cache.get(key) as T | undefined,
		setCache: async <T>(key: string, value: T): Promise<boolean> => {
			cache.set(key, value);
			return true;
		},
		deleteCache: async (key: string): Promise<boolean> => cache.delete(key),
		compareAndSetCache: async <T>(
			key: string,
			expected: unknown,
			replacement: T,
		): Promise<boolean> => {
			const stored = cache.get(key);
			const matches =
				expected === undefined
					? stored === undefined
					: stored !== undefined && jsonValueEquals(stored, expected);
			if (!matches) return false;
			cache.set(key, replacement);
			return true;
		},
		...overrides,
	};

	// `IAgentRuntime` is assignable to `Partial<IAgentRuntime>`, so this downcast
	// is a plain `as` (not `as unknown as`) — the one audited mock-completion cast.
	return base as IAgentRuntime;
}
