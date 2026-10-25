/** models testing capability barrel. */

export {
  CerebrasJudge,
  type CerebrasJudgeOptions,
  type CerebrasJudgeVerdict,
  extractBalancedJsonObject,
  type JudgeCallOptions,
  type JudgeResponse,
  normalizeVerdict,
  parseJudgeScore,
  tolerantJsonParse,
  verdictFromScore,
} from "../scenario-runner/src/cerebras-judge.ts";
export {
  CAPABILITY_ROUTER_PROTOCOL_FIXTURE,
  CAPABILITY_ROUTER_PROTOCOL_FIXTURE_VERSION,
} from "./capability-protocol-fixture.ts";
export {
  actionSlug,
  benignExternalMessageFixture,
  finalMessageUserText,
  matchesScenarioInput,
  type RuntimeWithScenarioModelFixtures,
  registerStrictActionRouteFixtures,
  type StrictActionRouteFixture,
  type StrictTerminalRouteFixture,
  stage1ResponseHandlerFixture,
  strictActionRouteFixtures,
  strictTerminalReplyFixture,
} from "./deterministic-action-fixtures.ts";
export {
  applyDeterministicModelFixtureBehavior,
  createDeterministicModelFixtureRegistry,
  createDeterministicModelPlugin,
  createPerfectResultPlugin,
  type DeterministicModelCall,
  type DeterministicModelCallDiagnostic,
  type DeterministicModelDiagnostics,
  type DeterministicModelFixture,
  type DeterministicModelFixtureBehavior,
  type DeterministicModelFixtureDiagnostic,
  type DeterministicModelFixtureMatch,
  type DeterministicModelFixtureRegistry,
  type DeterministicModelFixtureResolution,
  type DeterministicModelFixtureScope,
  type DeterministicModelPlugin,
  type DeterministicModelPluginOptions,
  type DeterministicModelResponse,
  type DeterministicSchemaMatcher,
  type DeterministicTextMatcher,
} from "./deterministic-model-plugin.ts";
export { postToolEvaluatorFixture } from "./post-tool-evaluator-fixture.ts";

export {
  matchesTypedTurnInput,
  type TypedTurnEvaluationContract,
  transientTurnEvaluationSeed,
  typedTurnEvaluationFixtures,
} from "./typed-turn-evaluation-fixtures.ts";
