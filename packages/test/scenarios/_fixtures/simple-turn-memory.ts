/** Declares typed memory decisions only for the three named keyless smoke turns. */
import { isDeepStrictEqual } from "node:util";
import { type AgentRuntime, type JsonValue, ModelType } from "@elizaos/core";
import { requireIncrementalSourceCitations } from "@elizaos/core/services/evaluator-schema";
import type { DeterministicModelFixture } from "@elizaos/core/testing";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";

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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function simpleTurnEvaluatorFixture(
  runtime: AgentRuntime,
  context: ScenarioContext,
  kind: keyof typeof turns,
  phase: "memory" | "ftu",
): DeterministicModelFixture {
  if (!context.primaryRoomId || !context.primaryUserId) {
    throw new Error(
      "Memory fixture requires the scenario room and sender identity.",
    );
  }
  const turn = turns[kind];
  // These smoke inputs contain no personal fact, preference, identity, or
  // relationship to store. A credit balance is a transient mocked read.
  const sections: Record<string, JsonValue> =
    phase === "ftu"
      ? {
          ftu_goal_discovery: { goalFound: false, goal: "", confidence: 0 },
        }
      : {
          factMemory: { ops: [] },
          relationships: { relationships: [] },
          identities: { identities: [] },
          preferences: { ops: [] },
          experiencePatterns: { experiences: [] },
          success: {
            completed: true,
            reason: `The ${turn.action} receipt completed this smoke request.`,
          },
        };
  const schemas = new Map(
    runtime.evaluators.map((entry) => [
      entry.name,
      phase === "memory"
        ? requireIncrementalSourceCitations(entry.schema)
        : entry.schema,
    ]),
  );
  return {
    name: `${phase}-${kind}-typed-completion`,
    times: 1,
    match(call) {
      const { params } = call;
      if (
        call.modelType !== ModelType.TEXT_SMALL ||
        call.toolNames.length !== 0 ||
        params.temperature !== 0 ||
        params.prompt !== undefined ||
        !Array.isArray(params.messages) ||
        params.messages.length !== 1
      )
        return false;
      const message = params.messages[0];
      if (message.role !== "user" || typeof message.content !== "string")
        return false;
      const prompt = message.content;
      if (
        !prompt.startsWith("# Task: Post-turn evaluation") ||
        !prompt.includes(`\nAgent ID: ${runtime.agentId}\n`) ||
        !prompt.includes(`\nRoom ID: ${context.primaryRoomId}\n`) ||
        !prompt.includes(`\nSender entity ID: ${context.primaryUserId}\n`) ||
        !prompt.includes(
          `\nLatest message:\n${turn.input}\n\nAgent response messages:`,
        ) ||
        !prompt.includes(`. ${turn.action} - succeeded\n`) ||
        !prompt.includes('"success":true')
      )
        return false;
      const schema = params.responseSchema;
      if (
        !record(schema) ||
        schema.type !== "object" ||
        schema.additionalProperties !== false ||
        !record(schema.properties) ||
        !Array.isArray(schema.required) ||
        schema.required.length === 0
      )
        return false;
      if (
        phase === "ftu" &&
        (schema.required.length !== 1 ||
          schema.required[0] !== "ftu_goal_discovery")
      )
        return false;
      if (
        phase === "memory" &&
        !Object.hasOwn(schema.properties, "restoreContextBefore")
      )
        return false;
      const required = schema.required;
      const properties = schema.properties;
      if (
        !required.every(
          (key) =>
            typeof key === "string" &&
            Object.hasOwn(sections, key) &&
            isDeepStrictEqual(properties[key], schemas.get(key)),
        )
      )
        return false;
      return Object.keys(schema.properties).every(
        (key) =>
          required.includes(key) ||
          (phase === "memory" &&
            key === "restoreContextBefore" &&
            record(properties[key]) &&
            properties[key].type === "string"),
      );
    },
    response(call) {
      const schema = call.params.responseSchema;
      if (!record(schema) || !Array.isArray(schema.required))
        throw new Error("Matched memory schema is missing.");
      return Object.fromEntries(
        schema.required.map((key) => {
          if (typeof key !== "string" || !Object.hasOwn(sections, key))
            throw new Error("Unowned evaluator section.");
          return [key, sections[key]];
        }),
      );
    },
  };
}

/** Keep foreground goal discovery separate from durable incremental extraction. */
export function simpleTurnMemoryFixtures(
  runtime: AgentRuntime,
  context: ScenarioContext,
  kind: keyof typeof turns,
): DeterministicModelFixture[] {
  return [
    simpleTurnEvaluatorFixture(runtime, context, kind, "ftu"),
    simpleTurnEvaluatorFixture(runtime, context, kind, "memory"),
  ];
}
