/**
 * Routes LifeOps scenarios through the canonical correlated action evaluator.
 * Actions, persistence, and delivery assertions remain real; the evaluator
 * requires the declared successful tool receipt before completing a turn.
 */
import {
  type RuntimeWithScenarioModelFixtures,
  registerStrictActionRouteFixtures,
  type StrictActionRouteFixture,
} from "@elizaos/core/testing";

export function registerLifeOpsActionFixtures(
  runtime: RuntimeWithScenarioModelFixtures,
  specs: readonly StrictActionRouteFixture[],
): void {
  registerStrictActionRouteFixtures(
    runtime,
    specs.map((spec) => ({ ...spec, messageToUser: "I will check that." })),
  );
}
