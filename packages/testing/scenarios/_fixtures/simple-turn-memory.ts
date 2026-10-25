/** Named acceptance fixtures for the local greeting, echo and balance smoke scenarios. */
import type { AgentRuntime } from "@elizaos/core";
import type { ScenarioContext } from "@elizaos/testing";
import {
  type DeterministicModelFixture,
  typedTurnEvaluationFixtures,
} from "@elizaos/testing/models";

const turns = {
  echo: {
    input: "Please echo this message back to me: hello world",
    action: "ECHO_TEST",
  },
  greeting: { input: "Hello!", action: "GREET_USER" },
  balance: {
    input: "How many Eliza Cloud credits do I have left?",
    action: "CLOUD_ACCOUNT_STATUS",
  },
} as const;

export function simpleTurnMemoryFixtures(
  runtime: AgentRuntime,
  context: ScenarioContext,
  kind: keyof typeof turns,
): DeterministicModelFixture[] {
  const turn = turns[kind];
  return typedTurnEvaluationFixtures(runtime, context, {
    ...turn,
    name: kind,
    goal: { goalFound: false, goal: "", confidence: 0 },
    memory: {
      factMemory: { ops: [] },
      relationships: { relationships: [] },
      identities: { identities: [] },
      preferences: { ops: [] },
      experiencePatterns: { experiences: [] },
      success: {
        completed: true,
        reason: `The ${turn.action} receipt completed this smoke request.`,
      },
    },
  });
}
