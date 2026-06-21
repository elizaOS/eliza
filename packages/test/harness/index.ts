/**
 * `@elizaos/test-harness` — the zero-cost end-to-end test substrate.
 *
 * One import gives a plugin author a real PGLite-backed AgentRuntime driven by
 * the deterministic mock LLM, with correct *and* incorrect response fixtures.
 *
 * See `./README.md` for the full guide.
 */

export {
  createDeterministicLlmFixtureRegistry,
  createDeterministicLlmProxyPlugin,
  type DeterministicLlmFixtureRegistry,
  type DeterministicLlmProxyOptions,
  type DeterministicLlmProxyPlugin,
  type LlmProxyFixture,
  type LlmProxyFixtureDiagnostics,
  type LlmProxyFixtureMatch,
  type LlmProxyResponse,
} from "../mocks/helpers/llm-proxy-plugin.ts";

export {
  actionSlug,
  finalMessageUserText,
  matchesScenarioInput,
  type RuntimeWithScenarioLlmFixtures,
  registerStrictActionRouteFixtures,
  type StrictActionRouteFixture,
  stage1ResponseHandlerFixture,
  strictActionRouteFixtures,
} from "./action-route-fixtures.ts";

export {
  ADVERSARIAL_KIND_DESCRIPTIONS,
  ADVERSARIAL_KINDS,
  type AdversarialFixtureSpec,
  type AdversarialKind,
  adversarialActionRouteFixtures,
  adversarialPlannerFixture,
} from "./negative-fixtures.ts";
export {
  type MockLlmRuntime,
  type WithMockLlmRuntimeOptions,
  withMockLlmRuntime,
} from "./with-mock-llm-runtime.ts";
