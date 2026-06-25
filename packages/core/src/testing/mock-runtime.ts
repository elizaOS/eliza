/**
 * @fileoverview Typed mock runtime for **unit** tests.
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
 * defaulted; methods are intentionally left unset so the factory is a
 * behavior-preserving drop-in for the minimal cast-mocks it replaces. Pass the
 * methods (and any other fields) a test needs via `overrides` — now type-checked
 * against `IAgentRuntime`, unlike the `as unknown as` casts.
 */
export function createMockRuntime(
	overrides: Partial<IAgentRuntime> = {},
): IAgentRuntime {
	// Only structural, required properties are defaulted. Methods are deliberately
	// NOT pre-stubbed: the cast-mocks this replaces were minimal by design, and a
	// method a test never set must stay `undefined` so migrating to this factory
	// is behavior-preserving. Tests pass the methods they need via `overrides`
	// (now type-checked), exactly as the hand-rolled cast-mocks did.
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
		...overrides,
	};

	// `IAgentRuntime` is assignable to `Partial<IAgentRuntime>`, so this downcast
	// is a plain `as` (not `as unknown as`) — the one audited mock-completion cast.
	return base as IAgentRuntime;
}
