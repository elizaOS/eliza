/**
 * Regression: the post-turn evaluator sends every active evaluator's response
 * schema flattened into ONE merged structured-output request. Anthropic's
 * grammar compiler hard-400s any request whose schema carries more than 24
 * optional (non-required) parameters counted recursively
 * (`Schemas contains too many optional parameters (N) ... (limit: 24)`), so the
 * default advanced-capabilities bundle failed the evaluator EVERY turn before
 * the json_object fallback retried — three logged 400s and ~4.5s of waste per
 * turn (#16499 budgeted the tool path; the structured-output/evaluator path was
 * never budgeted).
 *
 * These tests pin two invariants:
 *  1. The real merged evaluator schema DOES exceed the strict optional-param
 *     limit (documents the bug — a single strict request cannot carry every
 *     evaluator's optional fields).
 *  2. `generateEvaluationOutput` must NOT attempt the doomed structured
 *     (`responseSchema`) request when the merged schema is over budget; it must
 *     go straight to the json_object protocol and still return output. On clean
 *     develop the structured request is always attempted first, so (2) fails
 *     there and passes with the pre-flight budget guard.
 */
import {
  countSchemaOptionalParameters,
  DEFAULT_STRUCTURED_OUTPUT_OPTIONAL_PARAM_LIMIT,
  type IAgentRuntime,
  type JSONSchema,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { advancedEvaluators } from "../features/advanced-capabilities/index.ts";
import { longTermMemoryEvaluator } from "../features/advanced-memory/evaluators/memory-items.ts";
import {
  generateEvaluationOutput,
  mergeEvaluatorSchemas,
} from "./evaluator.ts";

function realMergedSchema(): JSONSchema {
  const active = [...advancedEvaluators, longTermMemoryEvaluator].map(
    (evaluator) => ({
      name: evaluator.name,
      schema: evaluator.schema as JSONSchema,
    }),
  );
  return mergeEvaluatorSchemas(active);
}

type ModelCall = {
  hasResponseSchema: boolean;
  hasJsonObjectFormat: boolean;
};

function makeRuntime(
  onCall: (call: ModelCall) => void,
  overrides: { setting?: string | undefined } = {},
): IAgentRuntime {
  const noop = () => {};
  return {
    getSetting: (key: string) =>
      key === "ELIZA_STRUCTURED_OUTPUT_OPTIONAL_PARAM_LIMIT"
        ? overrides.setting
        : undefined,
    logger: { warn: noop, debug: noop, info: noop, error: noop },
    async useModel(_type: unknown, params: Record<string, unknown>) {
      onCall({
        hasResponseSchema: "responseSchema" in params,
        hasJsonObjectFormat:
          typeof params.responseFormat === "object" &&
          params.responseFormat !== null &&
          (params.responseFormat as { type?: string }).type === "json_object",
      });
      // Minimal well-formed evaluator object output.
      return { extracted: [] };
    },
  } as unknown as IAgentRuntime;
}

const RENDERED = {
  structured: {
    prompt: "structured prompt",
    promptSegments: [],
    providerOptions: undefined,
  },
  text: {
    prompt: "json-object prompt with inline schema",
    promptSegments: [],
    providerOptions: undefined,
  },
  // biome-ignore lint/suspicious/noExplicitAny: minimal test stub for the rendered prompt shape.
} as any;

describe("post-turn evaluator structured-output optional-param budget", () => {
  it("the real merged evaluator schema exceeds the strict optional-parameter limit (documents the bug)", () => {
    const merged = realMergedSchema();
    const count = countSchemaOptionalParameters(merged);
    // Sanity: the merge produced a non-trivial object.
    expect(merged.type).toBe("object");
    expect(count).toBeGreaterThan(
      DEFAULT_STRUCTURED_OUTPUT_OPTIONAL_PARAM_LIMIT,
    );
  });

  it("skips the doomed structured request when the merged schema is over budget", async () => {
    const calls: ModelCall[] = [];
    const runtime = makeRuntime((call) => calls.push(call));
    const schema = realMergedSchema();
    expect(countSchemaOptionalParameters(schema)).toBeGreaterThan(
      DEFAULT_STRUCTURED_OUTPUT_OPTIONAL_PARAM_LIMIT,
    );

    const out = await generateEvaluationOutput({
      runtime,
      rendered: RENDERED,
      schema,
    });

    // The pre-flight guard must have prevented any structured (responseSchema)
    // model call. On clean develop the first call carries responseSchema, so
    // this expectation fails there — the bidirectional proof.
    expect(calls.some((c) => c.hasResponseSchema)).toBe(false);
    // Output still lands via the json_object protocol.
    expect(calls.some((c) => c.hasJsonObjectFormat)).toBe(true);
    expect(out).toEqual({ extracted: [] });
  });

  it("still uses the structured request for an under-budget schema", async () => {
    const calls: ModelCall[] = [];
    const runtime = makeRuntime((call) => calls.push(call));
    const smallSchema: JSONSchema = {
      type: "object",
      properties: {
        note: { type: "string" },
        score: { type: "number" },
      },
      required: [],
      additionalProperties: false,
    };
    expect(countSchemaOptionalParameters(smallSchema)).toBeLessThanOrEqual(
      DEFAULT_STRUCTURED_OUTPUT_OPTIONAL_PARAM_LIMIT,
    );

    await generateEvaluationOutput({
      runtime,
      rendered: RENDERED,
      schema: smallSchema,
    });

    // Under budget: the strict structured request is still attempted first.
    expect(calls[0]?.hasResponseSchema).toBe(true);
  });

  it("honors an operator-raised limit (guard disabled)", async () => {
    const calls: ModelCall[] = [];
    const runtime = makeRuntime((call) => calls.push(call), {
      setting: "1000",
    });
    const schema = realMergedSchema();

    await generateEvaluationOutput({ runtime, rendered: RENDERED, schema });

    // Limit raised above the merged count → structured request attempted again.
    expect(calls[0]?.hasResponseSchema).toBe(true);
  });
});
