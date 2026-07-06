/**
 * Live-only guard for the factMemory evaluator's structured field contract.
 * It calls the production evaluator prompt/schema through the scenario
 * runtime's real TEXT_SMALL provider, then asserts the parsed output contains
 * the multilingual profile fields consumed by LifeOps projections.
 */

import {
  type IAgentRuntime,
  type Memory,
  ModelType,
  type UUID,
} from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import { factMemoryEvaluator } from "../../../core/src/features/advanced-capabilities/evaluators/reflection-items.ts";

const agentId = "00000000-0000-0000-0000-0000000000aa" as UUID;
const entityId = "00000000-0000-0000-0000-0000000000bb" as UUID;
const roomId = "00000000-0000-0000-0000-0000000000cc" as UUID;

function message(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000dd" as UUID,
    entityId,
    agentId,
    roomId,
    content: { text },
    createdAt: Date.now(),
  };
}

function asRuntime(value: unknown): IAgentRuntime {
  if (!value || typeof value !== "object" || !("useModel" in value)) {
    throw new Error("scenario runtime did not expose useModel");
  }
  return value as IAgentRuntime;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function requestFactOps(runtime: IAgentRuntime, prompt: string) {
  const messages = [{ role: "user" as const, content: prompt }];
  try {
    return await runtime.useModel(ModelType.TEXT_SMALL, {
      messages,
      responseSchema: factMemoryEvaluator.schema,
      responseFormat: { type: "json_object" },
      temperature: 0,
    });
  } catch (error) {
    runtime.logger.warn(
      { error },
      "[live-fact-memory-structured-fields] schema request failed; retrying json_object fallback",
    );
    return runtime.useModel(ModelType.TEXT_SMALL, {
      messages,
      responseFormat: { type: "json_object" },
      temperature: 0,
    });
  }
}

function includesExpectedProfileFields(output: unknown): string | undefined {
  const parsed = factMemoryEvaluator.parse?.(output);
  if (!parsed || !Array.isArray(parsed.ops)) {
    return `expected parsed ops array, saw ${JSON.stringify(output)}`;
  }

  const fields = parsed.ops
    .filter((op) => op.op === "add_durable")
    .map((op) => readRecord(op.structured_fields));
  const hasPreferredName = fields.some(
    (field) => field.preferredName === "Camille",
  );
  const hasTimezone = fields.some((field) => field.timezone === "Europe/Paris");
  const hasManager = fields.some(
    (field) =>
      field.person === "Pat" &&
      (field.relationshipType === "manager" ||
        field.role === "manager" ||
        field.role === "boss"),
  );
  const hasSlackHandle = fields.some(
    (field) =>
      typeof field.platform === "string" &&
      field.platform.toLowerCase() === "slack" &&
      field.handle === "@pat-ops",
  );

  if (hasPreferredName && hasTimezone && hasManager && hasSlackHandle) {
    return undefined;
  }
  return `expected preferredName=Camille, timezone=Europe/Paris, person=Pat, manager/boss role, platform=slack, handle=@pat-ops in structured_fields; saw ${JSON.stringify(parsed.ops)}`;
}

export default scenario({
  id: "live-fact-memory-structured-fields",
  lane: "live-only",
  title: "Fact memory live extraction emits structured LifeOps fields",
  domain: "lifeops",
  tags: ["lifeops", "fact-memory", "live-llm"],
  description:
    "Calls the production factMemory evaluator prompt/schema with multilingual owner facts and verifies the live model returns structured_fields consumed by LifeOps.",
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "run-live-fact-memory-extraction",
      apply: async (ctx) => {
        const runtime = asRuntime(ctx.runtime);
        const ownerMessage = message(
          "Je m'appelle Camille, mi jefe es Pat y su Slack es @pat-ops. Mi zona horaria es Europe/Paris.",
        );
        const prompt = factMemoryEvaluator.prompt?.({
          runtime,
          message: ownerMessage,
          state: { values: {}, data: {}, text: "" },
          options: {},
          evaluatorName: "factMemory",
          prepared: {
            recentMessages: [ownerMessage],
            existingRelationships: [],
            entities: [],
            knownFacts: [],
          },
        });
        if (!prompt) return "factMemory evaluator did not produce a prompt";
        const output = await requestFactOps(runtime, prompt);
        return includesExpectedProfileFields(output);
      },
    },
  ],
  turns: [],
});
