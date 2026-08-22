/**
 * Compiles serializable scenario model manifests into the core strict registry.
 *
 * This is the only scenario-to-model adapter: it keeps definitions data-only,
 * starts a fresh registry scope for every attempt, and leaves a narrow worldId
 * seam for the synthetic-world state contract without depending on it.
 */

import type { AgentRuntime } from "@elizaos/core";
import type {
  DeterministicModelFixture,
  DeterministicModelFixtureRegistry,
  DeterministicTextMatcher,
} from "@elizaos/core/testing";
import type {
  ScenarioDefinition,
  ScenarioModelFixture,
  ScenarioModelFixtureDeclaration,
  ScenarioModelTextMatcher,
} from "@elizaos/scenario-runner/schema";

export type RuntimeWithScenarioModelFixtureRegistry = AgentRuntime & {
  scenarioModelFixtures?: DeterministicModelFixtureRegistry;
  setScenarioModelFixtureMode?: (mode: ScenarioModelFixtureMode) => void;
};

/** Identifies whether an attempt is strict or still uses the migration bridge. */
export type ScenarioModelFixtureMode =
  | "strict-fixtures"
  | "model-free"
  | "legacy-fallback";

export function scenarioModelFixtureMode(
  scenario: Pick<ScenarioDefinition, "modelFixtures">,
): ScenarioModelFixtureMode {
  if (scenario.modelFixtures?.mode === "fixtures") return "strict-fixtures";
  if (scenario.modelFixtures?.mode === "model-free") return "model-free";
  return "legacy-fallback";
}

function compileTextMatcher(
  matcher: ScenarioModelTextMatcher,
): DeterministicTextMatcher {
  if ("exact" in matcher) return matcher.exact;
  if ("includes" in matcher) {
    return (value) => value.includes(matcher.includes);
  }
  return new RegExp(matcher.pattern, matcher.flags);
}

function compileResponse(
  fixture: ScenarioModelFixture,
): DeterministicModelFixture["response"] {
  const response = fixture.response;
  if (!response) return undefined;
  if (response.json !== undefined) {
    return response.json as DeterministicModelFixture["response"];
  }
  if (
    response.toolCalls === undefined &&
    response.finishReason === undefined &&
    response.usage === undefined
  ) {
    return response.text ?? "";
  }
  return {
    ...(response.text !== undefined ? { text: response.text } : {}),
    ...(response.toolCalls !== undefined
      ? {
          toolCalls: response.toolCalls.map((toolCall) => ({
            id: toolCall.id ?? `call-${fixture.name}`,
            name: toolCall.name,
            type: "function",
            arguments: toolCall.arguments,
          })) as never,
        }
      : {}),
    ...(response.finishReason !== undefined
      ? { finishReason: response.finishReason }
      : {}),
    ...(response.usage !== undefined ? { usage: response.usage as never } : {}),
  } as DeterministicModelFixture["response"];
}

export function compileScenarioModelFixture(
  fixture: ScenarioModelFixture,
): DeterministicModelFixture {
  return {
    name: fixture.name,
    match: {
      modelType: [
        ...(Array.isArray(fixture.match.modelType)
          ? fixture.match.modelType
          : [fixture.match.modelType]),
      ],
      ...(fixture.match.input
        ? { input: compileTextMatcher(fixture.match.input) }
        : {}),
      ...(fixture.match.prompt
        ? { prompt: compileTextMatcher(fixture.match.prompt) }
        : {}),
      ...(fixture.match.toolNames
        ? { toolNames: [...fixture.match.toolNames] }
        : {}),
      ...(fixture.match.responseSchema !== undefined
        ? { responseSchema: fixture.match.responseSchema as never }
        : {}),
    },
    response: compileResponse(fixture),
    // Scenario manifests are exact by default; authors must opt into ranges.
    times: fixture.cardinality ?? 1,
    behavior: fixture.behavior,
  };
}

function assertModelFreeScenario(scenario: ScenarioDefinition): void {
  const modelBackedTurns = scenario.turns
    .filter((turn) => {
      const kind = turn.kind ?? "message";
      return kind === "message" || kind === "voice" || kind === "tick";
    })
    .map((turn) => `${turn.name}:${turn.kind ?? "message"}`);
  const modelBackedChecks = (scenario.finalChecks ?? [])
    .filter((check) => check.type === "judgeRubric")
    .map((check) => check.name ?? check.type);
  if (modelBackedTurns.length > 0 || modelBackedChecks.length > 0) {
    throw new Error(
      `scenario "${scenario.id}" declares model-free but contains model-backed work: ${[
        ...modelBackedTurns,
        ...modelBackedChecks,
      ].join(", ")}`,
    );
  }
}

export function beginScenarioModelFixtureAttempt(
  runtime: AgentRuntime,
  scenario: ScenarioDefinition,
  attemptId: string,
  worldId?: string,
): void {
  const declaration: ScenarioModelFixtureDeclaration | undefined =
    scenario.modelFixtures;
  if (declaration?.mode === "model-free") {
    assertModelFreeScenario(scenario);
  }
  const registry = (runtime as RuntimeWithScenarioModelFixtureRegistry)
    .scenarioModelFixtures;
  if (!registry) return;
  (
    runtime as RuntimeWithScenarioModelFixtureRegistry
  ).setScenarioModelFixtureMode?.(scenarioModelFixtureMode(scenario));
  const fixtures =
    declaration?.mode === "fixtures"
      ? declaration.fixtures.map(compileScenarioModelFixture)
      : [];
  registry.beginAttempt(
    {
      scenarioId: scenario.id,
      attemptId,
      ...(worldId ? { worldId } : {}),
    },
    fixtures,
  );
}
