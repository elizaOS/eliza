/** Declares explicit typed evaluator decisions for named deterministic turns. */
import { isDeepStrictEqual } from "node:util";
import { type AgentRuntime, type JsonValue, ModelType } from "@elizaos/core";
import { wrapExternalContent } from "@elizaos/core/security/external-content";
import type {
  ScenarioContext,
  ScenarioSeedStep,
} from "@elizaos/scenario-runner/schema";
import type { DeterministicModelFixture } from "@elizaos/testing";
import { requireIncrementalSourceCitations } from "../../../../plugins/plugin-assistant/src/services/evaluator-schema.ts";

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

export interface TypedTurnEvaluationContract {
  name: string;
  input: string;
  action: string | null;
  responseText?: string;
  memory:
    | Record<string, JsonValue>
    | ((evidence: { sourceMessageIds: string[] }) => Record<string, JsonValue>);
  actionSuccess?: boolean;
  goal: JsonValue;
}

function typedTurnInputRepresentations(input: string): string[] {
  // Storage may omit the canonical warning while retaining the complete envelope.
  return [
    input,
    wrapExternalContent(input, { source: "api" }),
    wrapExternalContent(input, { source: "api", includeWarning: false }),
  ];
}

/** Matches complete fixture input bytes, including the runtime's canonical envelopes. */
export function matchesTypedTurnInput(
  content: unknown,
  input: string,
): boolean {
  return (
    typeof content === "string" &&
    typedTurnInputRepresentations(input).includes(content)
  );
}

function typedTurnEvaluatorFixture(
  runtime: AgentRuntime,
  context: ScenarioContext,
  turn: TypedTurnEvaluationContract,
  phase: "memory" | "ftu",
): DeterministicModelFixture {
  if (!context.primaryRoomId || !context.primaryUserId) {
    throw new Error(
      "Memory fixture requires the scenario room and sender identity.",
    );
  }
  const inputRepresentations = typedTurnInputRepresentations(turn.input);
  // A callback declares the same section keys with no citations at registration;
  // only the response path supplies IDs from the complete selected evidence.
  const sections =
    phase === "ftu"
      ? { ftu_goal_discovery: turn.goal }
      : typeof turn.memory === "function"
        ? turn.memory({ sourceMessageIds: [] })
        : turn.memory;
  const schemas = new Map(
    runtime.evaluators.map((entry) => [
      entry.name,
      phase === "memory"
        ? requireIncrementalSourceCitations(entry.schema)
        : entry.schema,
    ]),
  );
  return {
    name: `${phase}-${turn.name}-typed-completion`,
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
      const currentInput = inputRepresentations.some((input) =>
        prompt.includes(
          `\nLatest message:\n${input}\n\nAgent response messages:`,
        ),
      );
      if (
        !prompt.startsWith("# Task: Post-turn evaluation") ||
        !prompt.includes(`\nAgent ID: ${runtime.agentId}\n`) ||
        !prompt.includes(`\nRoom ID: ${context.primaryRoomId}\n`) ||
        !prompt.includes(`\nSender entity ID: ${context.primaryUserId}\n`) ||
        !currentInput ||
        !(turn.action === null
          ? turn.responseText !== undefined &&
            prompt.includes(
              `\nAgent response messages:\n${turn.responseText}\n`,
            )
          : prompt.includes(
              `. ${turn.action} - ${turn.actionSuccess === false ? "failed" : "succeeded"}\n`,
            ) && prompt.includes(`"success":${turn.actionSuccess !== false}`))
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
      const exactProperties = Object.keys(schema.properties).every(
        (key) =>
          required.includes(key) ||
          (phase === "memory" &&
            key === "restoreContextBefore" &&
            record(properties[key]) &&
            properties[key].type === "string"),
      );
      return exactProperties;
    },
    response(call) {
      const schema = call.params.responseSchema;
      if (!record(schema) || !Array.isArray(schema.required))
        throw new Error("Matched memory schema is missing.");
      let responseSections = sections;
      if (phase === "memory" && typeof turn.memory === "function") {
        const prompt = call.latestUserText;
        const marker =
          "Room transcript (complete pending evidence records; processed history remains in storage):\n";
        const start = prompt.indexOf(marker);
        if (start < 0)
          throw new Error("Memory fixture has no canonical evidence records.");
        const end = prompt.indexOf("\nHistorical context is available", start);
        if (end < 0)
          throw new Error("Memory fixture has no canonical evidence boundary.");
        const records: unknown = JSON.parse(
          prompt.substring(start + marker.length, end),
        );
        if (!Array.isArray(records))
          throw new Error("Memory evidence is not an array.");
        const sourceMessageIds = records
          .filter(
            (entry) =>
              record(entry) &&
              entry.entityId === context.primaryUserId &&
              record(entry.content) &&
              typeof entry.content.text === "string" &&
              inputRepresentations.includes(entry.content.text) &&
              typeof entry.id === "string",
          )
          .map((entry) => entry.id as string);
        if (sourceMessageIds.length === 0)
          throw new Error(
            "Declared memory turn is absent from selected user evidence.",
          );
        responseSections = turn.memory({ sourceMessageIds });
      }
      return Object.fromEntries(
        schema.required.map((key) => {
          if (
            typeof key !== "string" ||
            !Object.hasOwn(sections, key) ||
            !Object.hasOwn(responseSections, key)
          )
            throw new Error("Unowned evaluator section.");
          return [key, responseSections[key]];
        }),
      );
    },
  };
}

/** Bind separately scheduled foreground and background calls to one declared turn. */
export function typedTurnEvaluationFixtures(
  runtime: AgentRuntime,
  context: ScenarioContext,
  turn: TypedTurnEvaluationContract,
): DeterministicModelFixture[] {
  return [
    typedTurnEvaluatorFixture(runtime, context, turn, "ftu"),
    typedTurnEvaluatorFixture(runtime, context, turn, "memory"),
  ];
}

/** The three smoke inputs contain no durable personal facts or standing goals. */
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

/** Declares no personal-memory changes for explicitly listed transient tool requests. */
export function transientTurnEvaluationSeed(
  turns: Array<{
    input: string;
    action: string | null;
    responseText?: string;
    completed: boolean;
    reason: string;
    actionSuccess?: boolean;
  }>,
  noPersonalMemoryReason: string,
): ScenarioSeedStep {
  if (!noPersonalMemoryReason.trim())
    throw new Error("A scoped memory decision requires its rationale.");
  return {
    type: "custom",
    name: `typed evaluator decisions: ${noPersonalMemoryReason}`,
    apply(context) {
      const runtime = context.runtime as AgentRuntime & {
        scenarioModelFixtures?: {
          register(...fixtures: DeterministicModelFixture[]): void;
        };
      };
      if (!runtime.scenarioModelFixtures)
        throw new Error("Scenario model fixture registry unavailable.");
      for (const turn of turns)
        runtime.scenarioModelFixtures.register(
          ...typedTurnEvaluationFixtures(runtime, context, {
            ...turn,
            name: turn.input,
            goal: { goalFound: false, goal: "", confidence: 0 },
            memory: {
              factMemory: { ops: [] },
              relationships: { relationships: [] },
              identities: { identities: [] },
              preferences: { ops: [] },
              experiencePatterns: { experiences: [] },
              success: { completed: turn.completed, reason: turn.reason },
            },
          }),
        );
    },
  };
}
