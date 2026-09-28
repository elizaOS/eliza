/** Verifies completion output schemas against real queue construction with a captured model boundary. */

import {
  type ContextObject,
  completionContextSources,
  type JSONSchema,
  type PlannerToolCall,
  type PlannerTrajectory,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  EVALUATOR_CONTEXT_ROUTES,
  evaluatorSchema,
  evaluatorTemplate,
  evaluatorTemplateForQueue,
} from "../../prompts/evaluator";
import { runEvaluator } from "../evaluator";

async function captureSchema(
  plannedQueue: PlannerToolCall[],
  redactSecrets = (text: string) => text,
  context: ContextObject = { id: "queue-contract" },
) {
  let schema: JSONSchema | undefined;
  let messages = "";
  const trajectory: PlannerTrajectory = {
    context,
    steps: [],
    plannedQueue,
    evaluatorOutputs: [],
  };
  const before = structuredClone(trajectory);
  await runEvaluator({
    runtime: {
      redactSecrets,
      useModel: async (_type, options) => {
        schema = options.responseSchema as JSONSchema;
        messages = JSON.stringify(options.messages);
        return JSON.stringify({
          thought: "More work needs planning.",
          success: false,
          decision: "CONTINUE",
        });
      },
    },
    context: trajectory.context,
    trajectory,
  });
  expect(trajectory).toEqual(before);
  return { schema, messages };
}

it("keeps every non-queue instruction unchanged", () => {
  const full = evaluatorTemplateForQueue(true);
  const empty = evaluatorTemplateForQueue(false);
  expect(full).toBe(evaluatorTemplate);
  expect(empty.length).toBeLessThan(full.length);
  for (const line of full.split("\n")) {
    if (!line.includes("NEXT_RECOMMENDED"))
      expect(empty.split("\n")).toContain(line);
  }
});

describe("completion recommendations describe the current planner queue", () => {
  it("does not advertise a queued-call decision when no calls remain", async () => {
    const { schema, messages } = await captureSchema([]);
    // Nothing was deferred, so no restoration decision can be honored.
    expect(schema?.properties?.decision.enum).toEqual(["FINISH", "CONTINUE"]);
    expect(schema?.properties).not.toHaveProperty("recommendedToolCallId");
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.properties).not.toHaveProperty("contextRequest");
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema).not.toHaveProperty("oneOf");
    expect(messages).not.toContain("NEXT_RECOMMENDED");
    expect(messages).toContain("No executable calls remain queued");
    expect(messages).toContain("more_work_pending");
    // No committed receipt exists to cite, so neither the field nor its
    // selection rule is offered.
    expect(messages).not.toContain("effectReceiptIds");
    expect(schema?.properties).not.toHaveProperty("effectReceiptIds");
    expect(messages).not.toContain("RESTORE_");
    expect(messages).not.toContain("Choose one restoration decision");
    expect(messages).toContain(
      "Omit file paths, internal ids and raw logs unless explicitly requested and safe to disclose; never expose secrets or internal reasoning",
    );
    expect(messages).not.toContain("no file paths, internal ids or raw logs");
  });

  it("distinguishes two calls to the same tool by their exact queue IDs", async () => {
    const { schema, messages } = await captureSchema([
      { id: "read-left", name: "NOTES_GET", params: { noteId: "left" } },
      { id: "read-right", name: "NOTES_GET", params: { noteId: "right" } },
    ]);
    expect(schema?.properties?.decision.enum).toEqual([
      "FINISH",
      "NEXT_RECOMMENDED",
      "CONTINUE",
    ]);
    expect(messages).toContain(
      "NEXT_RECOMMENDED when the next queued tool remains grounded",
    );
    expect(schema?.properties?.recommendedToolCallId.enum).toEqual([
      "read-left",
      "read-right",
    ]);
  });

  it("keeps the existing name fallback for callers without generated IDs", async () => {
    const { schema } = await captureSchema([
      { name: "LOOKUP", params: {} },
      { id: "next-call", name: "LOOKUP", params: {} },
    ]);
    expect(schema?.properties?.recommendedToolCallId.enum).toEqual([
      "LOOKUP",
      "next-call",
    ]);
  });

  it("does not disclose redacted queue IDs through schema enums", async () => {
    const { schema, messages } = await captureSchema(
      [{ id: "private-call-id", name: "LOOKUP", params: {} }],
      (text) => text.replaceAll("private-call-id", "[REDACTED]"),
    );
    expect(JSON.stringify(schema)).not.toContain("private-call-id");
    expect(messages).not.toContain("NEXT_RECOMMENDED");
    expect(schema?.properties?.decision.enum).toEqual(["FINISH", "CONTINUE"]);
  });

  it("advertises only the restoration its deferred context supports", async () => {
    const context: ContextObject = {
      id: "deferred-history",
      events: [1, 2].map((id) => ({
        id: `history:${id}`,
        type: "segment" as const,
        source: "prior-dialogue",
        createdAt: id,
        segment: {
          id: `history:${id}`,
          label: "prior_message:user",
          content: `Original ${id}`,
          stable: false,
        },
      })),
    };
    context.metadata = {
      completionContext: {
        mode: "selected",
        complete: true,
        sourceSetId: completionContextSources(context).sourceSetId,
        relevantSourceIds: ["h1"],
        constraintSourceIds: [],
        referentSourceIds: [],
        pendingIntentSourceIds: [],
      },
    };
    const { schema, messages } = await captureSchema([], undefined, context);
    expect(schema?.properties?.decision.enum).toEqual([
      "FINISH",
      "CONTINUE",
      "RESTORE_HISTORY",
    ]);
    expect(messages).toContain(
      "RESTORE_HISTORY: read missing original dialogue",
    );
    expect(messages).toContain(
      "Choose RESTORE_HISTORY only for missing evidence",
    );
    expect(messages).not.toContain("RESTORE_PROVIDERS");
    expect(messages).not.toContain("RESTORE_FULL");
  });

  it("renders every restoration route when both sources are deferred", () => {
    const template = evaluatorTemplateForQueue(false, true, false, {
      history: true,
      providers: true,
    });
    for (const route of Object.keys(EVALUATOR_CONTEXT_ROUTES))
      expect(template).toContain(`- ${route}:`);
    expect(template).toBe(evaluatorTemplateForQueue(false));
  });

  it("does not mutate the reusable canonical schema across turns", async () => {
    const original = structuredClone(evaluatorSchema);
    await captureSchema([{ id: "one", name: "LOOKUP", params: {} }]);
    await captureSchema([]);
    expect(evaluatorSchema).toEqual(original);
  });
});
