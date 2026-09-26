/** Stable evaluator wire contracts; dynamic eligibility is validated against real trajectory evidence. */
import type {
  ChatMessage,
  EffectReceipt,
  JSONSchema,
  PlannerToolCall,
  PlannerTrajectory,
  RunEvaluatorParams,
} from "@elizaos/core";
import { computePrefixHashes, normalizePromptSegments } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  evaluatorSchema,
  evaluatorTemplate,
  evaluatorTemplateForQueue,
} from "../../prompts/evaluator";
import { runEvaluator } from "../evaluator";

const receipt: EffectReceipt = {
  receiptId: "note-proof",
  operation: "notes.create",
  outcome: "applied",
  resource: { kind: "note", id: "picnic" },
  artifacts: [],
  idempotency: { key: "picnic-request", replayed: false },
  observedAt: "2026-09-04T12:00:00.000Z",
  commit: {
    kind: "durable",
    id: "note-write",
    committedAt: "2026-09-04T12:00:00.000Z",
  },
};
const continuing = {
  thought: "More work needs planning.",
  success: false,
  decision: "CONTINUE",
  replyEffectStatus: "none",
};
async function captureSchema(
  plannedQueue: PlannerToolCall[],
  options: {
    redactSecrets?: (text: string) => string;
    trajectory?: Partial<PlannerTrajectory>;
    output?: Record<string, unknown>;
    unresolvedFailure?: boolean;
    effects?: RunEvaluatorParams["effects"];
  } = {},
) {
  let schema: JSONSchema | undefined;
  let messages: ChatMessage[] = [];
  let prefixHash: string | undefined;
  const trajectory: PlannerTrajectory = {
    context: { id: "queue-contract", events: [] },
    steps: [],
    archivedSteps: [],
    plannedQueue,
    evaluatorOutputs: [],
    ...options.trajectory,
  };
  const before = structuredClone(trajectory);
  const output = await runEvaluator({
    runtime: {
      redactSecrets: options.redactSecrets ?? ((text) => text),
      useModel: async (_type, input) => {
        schema = input.responseSchema as JSONSchema;
        messages = input.messages as ChatMessage[];
        prefixHash = (
          input.providerOptions?.eliza as { prefixHash?: string } | undefined
        )?.prefixHash;
        return JSON.stringify(options.output ?? continuing);
      },
    },
    context: trajectory.context,
    trajectory,
    hasUnresolvedToolFailure: options.unresolvedFailure,
    effects: options.effects,
  });
  expect(trajectory).toEqual(before);
  return {
    schema,
    messages,
    output,
    prefixHash,
    text: JSON.stringify(messages),
  };
}

it("keeps evaluator instructions identical for queue, clipboard and reply states", () => {
  for (const queue of [false, true])
    for (const clipboard of [false, true])
      for (const reply of [false, true])
        expect(evaluatorTemplateForQueue(queue, clipboard, reply)).toBe(
          evaluatorTemplate,
        );
});

describe("stable evaluator schema with authoritative decision state", () => {
  it("keeps schema and earlier messages identical when only queue eligibility changes", async () => {
    const empty = await captureSchema([]);
    const queued = await captureSchema([
      { id: "read-left", name: "NOTES_GET", params: { noteId: "left" } },
      { id: "read-right", name: "NOTES_GET", params: { noteId: "right" } },
    ]);
    expect(JSON.stringify(empty.schema)).toBe(JSON.stringify(queued.schema));
    expect(empty.schema).toEqual(evaluatorSchema);
    expect(empty.prefixHash).toBe(queued.prefixHash);
    expect(empty.prefixHash).toBe(
      computePrefixHashes(
        normalizePromptSegments([
          {
            content: `evaluator_stage:\n${evaluatorTemplate.split("context_object:")[0].trim()}`,
            stable: true,
          },
          { content: JSON.stringify(evaluatorSchema), stable: true },
        ]),
      ).at(-1)?.hash,
    );
    expect(empty.messages.slice(0, -1)).toEqual(queued.messages.slice(0, -1));
    expect(empty.messages.at(-1)?.content).toContain("Queued call IDs: []");
    expect(queued.messages.at(-1)?.content).toContain(
      'Queued call IDs: ["read-left","read-right"]',
    );
    expect(empty.text).toContain("more_work_pending");
  });

  it("keeps the complete evidence prefix and schema while receipt/failure/reply/clipboard state changes", async () => {
    const modelHistory: ChatMessage[] = [
      { role: "assistant", content: "Checking the saved note." },
    ];
    const common = {
      modelHistory,
      steps: [
        {
          iteration: 1,
          result: {
            success: true,
            text: "Saved picnic note",
            transcriptVisibility: "internal" as const,
            modelReplyRequired: true,
            effectReceipts: [receipt],
          },
        },
      ],
    };
    const enabled = await captureSchema([], {
      trajectory: { ...common, codingMode: false },
    });
    const disabled = await captureSchema([], {
      trajectory: { ...common, codingMode: true, steps: [] },
      unresolvedFailure: true,
      effects: { copyToClipboard: false },
    });
    expect(JSON.stringify(enabled.schema)).toBe(
      JSON.stringify(disabled.schema),
    );
    expect(enabled.messages.slice(0, -1)).toEqual(
      disabled.messages.slice(0, -1),
    );
    expect(enabled.messages.at(-2)).toEqual(modelHistory[0]);
    expect(enabled.messages.at(-1)?.content).toContain(
      'Committed effect receipt IDs: ["note-proof"]',
    );
    expect(disabled.messages.at(-1)?.content).toContain(
      "Committed effect receipt IDs: []",
    );
    expect(disabled.messages.at(-1)?.content).toContain(
      "hasUnresolvedToolFailure: true",
    );
    expect(enabled.messages.at(-1)?.content).toContain(
      "requiresReplyField: true",
    );
  });

  it("keeps exact queue IDs and the legacy no-ID name fallback in the dynamic tail", async () => {
    const { schema, messages } = await captureSchema([
      { name: "LOOKUP", params: {} },
      { id: "next-call", name: "LOOKUP", params: {} },
    ]);
    expect(schema?.properties?.recommendedToolCallId).toEqual({
      type: "string",
    });
    expect(messages.at(-1)?.content).toContain(
      'Queued call IDs: ["LOOKUP","next-call"]',
    );
  });

  it("never exposes redacted queue IDs or allows their selection", async () => {
    const result = await captureSchema(
      [{ id: "private-call-id", name: "LOOKUP", params: {} }],
      {
        redactSecrets: (text) =>
          text.replaceAll("private-call-id", "[REDACTED]"),
        output: {
          ...continuing,
          decision: "NEXT_RECOMMENDED",
          recommendedToolCallId: "private-call-id",
        },
      },
    );
    expect(JSON.stringify(result.schema)).not.toContain("private-call-id");
    expect(result.text).not.toContain("private-call-id");
    expect(result.output.decision).toBe("CONTINUE");
  });

  it.each([undefined, "invented"])(
    "rejects a recommendation without a usable queue: %s",
    async (recommendedToolCallId) => {
      let deliveries = 0;
      const result = await captureSchema([], {
        output: {
          ...continuing,
          decision: "NEXT_RECOMMENDED",
          recommendedToolCallId,
          messageToUser: "Running it now.",
        },
        effects: {
          messageToUser: async () => {
            deliveries++;
          },
        },
      });
      expect(result.output).toMatchObject({
        decision: "CONTINUE",
        success: false,
      });
      expect(result.output.messageToUser).toBeUndefined();
      expect(deliveries).toBe(0);
    },
  );

  it("accepts a current queued call and rejects invented or expired IDs", async () => {
    const queue = [{ id: "next-call", name: "LOOKUP", params: {} }];
    for (const id of ["next-call", "past-call", "LOOKUP"]) {
      const result = await captureSchema(queue, {
        output: {
          ...continuing,
          decision: "NEXT_RECOMMENDED",
          recommendedToolCallId: id,
        },
      });
      expect(result.output.decision).toBe(
        id === "next-call" ? "NEXT_RECOMMENDED" : "CONTINUE",
      );
    }
  });

  it("requires current committed evidence even if the model ignores native schema guidance", async () => {
    const trajectory = {
      steps: [
        {
          iteration: 1,
          result: {
            success: true,
            text: "Saved picnic note",
            effectReceipts: [receipt],
          },
        },
      ],
    };
    for (const id of ["note-proof", "invented"]) {
      const result = await captureSchema([], {
        trajectory,
        output: {
          thought: "The write is complete.",
          success: true,
          decision: "FINISH",
          replyEffectStatus: "applied",
          effectReceiptIds: [id],
          messageToUser: "Saved the picnic note.",
        },
      });
      expect(result.output.decision).toBe(
        id === "note-proof" ? "FINISH" : "CONTINUE",
      );
    }
  });

  it("rejects invented receipt selections even when the model labels the reply as a read", async () => {
    const result = await captureSchema([], {
      output: { ...continuing, effectReceiptIds: ["invented"] },
    });
    expect(result.output.effectReceiptIds).toBeUndefined();
    expect(result.output.thought).toContain(
      "not a current committed effect receipt",
    );
  });

  it("cannot report success with an unresolved failure", async () => {
    const result = await captureSchema([], {
      unresolvedFailure: true,
      output: {
        thought: "The attempt failed.",
        success: true,
        decision: "FINISH",
        replyEffectStatus: "non_applied",
        messageToUser: "The write failed; the service rejected it.",
      },
    });
    expect(result.output).toMatchObject({
      decision: "FINISH",
      success: false,
      messageToUser: "The write failed; the service rejected it.",
    });
  });

  it("rejects a blank required internal-result reply without emitting effects", async () => {
    const result = await captureSchema([], {
      trajectory: {
        codingMode: false,
        steps: [
          {
            iteration: 1,
            result: {
              success: true,
              text: "Value is 42",
              transcriptVisibility: "internal",
              modelReplyRequired: true,
            },
          },
        ],
      },
      output: {
        thought: "Complete.",
        success: true,
        decision: "FINISH",
        replyEffectStatus: "none",
        messageToUser: "",
      },
    });
    expect(result.output).toMatchObject({
      decision: "CONTINUE",
      success: false,
    });
    expect(result.output.thought).toContain(
      "without repeating completed effects",
    );
  });

  it("preserves clipboard host denial despite the static schema", async () => {
    const result = await captureSchema([], {
      effects: { copyToClipboard: false },
      output: {
        ...continuing,
        copyToClipboard: { title: "Note", content: "42" },
      },
    });
    expect(result.schema?.properties).toHaveProperty("copyToClipboard");
    expect(result.output).toMatchObject({
      protocolFailure: true,
      parseError: "Clipboard output is unavailable in this host",
    });
  });

  it("never mutates the reusable canonical schema", async () => {
    const original = structuredClone(evaluatorSchema);
    await captureSchema([{ id: "one", name: "LOOKUP", params: {} }]);
    await captureSchema([]);
    expect(evaluatorSchema).toEqual(original);
  });
});
