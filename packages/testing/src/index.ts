/** Dependency-light scenario authoring and assertions. */

export * from "../scenario-runner/schema/index.ts";
export {
  actionMatchesScenarioExpectation,
  actionsAreScenarioEquivalent,
} from "../scenario-runner/src/action-families.ts";
export { expectMissingInputTerminalRelay } from "../scenario-runner/src/missing-input-terminal-relay.ts";
export * from "../scenario-runner/src/scenario-assertions/action-assertions.ts";
export * from "../scenario-runner/src/scenario-assertions/action-result-assertions.ts";
export * from "../scenario-runner/src/scenario-assertions/browser-task-assertions.ts";
export * from "../scenario-runner/src/scenario-assertions/calendar-assertions.ts";
export * from "../scenario-runner/src/scenario-assertions/effect-assertions.ts";
export { contextBenchProvider } from "./benchmark-context-provider.ts";
export { createMockRuntime, MOCK_AGENT_ID } from "./mock-runtime.ts";
