/** Stable evaluator wire contracts; dynamic eligibility is validated against real trajectory evidence. */
import type {
  ChatMessage,
  ContextObject,
  EffectReceipt,
  JSONSchema,
  PlannerToolCall,
  PlannerTrajectory,
  RunEvaluatorParams,
} from "@elizaos/core";
import {
  completionContextSources,
  computePrefixHashes,
  type JsonSchema,
  ModelType,
  normalizePromptSegments,
  validateSchema,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  EVALUATOR_CONTEXT_ROUTES,
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
    prepareAttempts?: boolean;
  } = {},
) {
  let modelCalls = 0;
  const attemptOptions: unknown[] = [];
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
        modelCalls++;
        attemptOptions.push(structuredClone(input.providerOptions));
        if (options.prepareAttempts) {
          for (const provider of ["primary", "backup"]) {
            const prepared = { ...input };
            await input.prepareModelAttempt?.(
              {
                modelType: ModelType.RESPONSE_HANDLER,
                provider,
                metadata: { contextWindowTokens: 131_072 },
              },
              prepared,
            );
            expect(prepared.messages).toEqual(input.messages);
            expect(prepared.responseSchema).toEqual(input.responseSchema);
            attemptOptions.push(structuredClone(prepared.providerOptions));
          }
        }
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
    modelCalls,
    attemptOptions,
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
    expect(empty.schema?.properties?.decision.enum).toEqual([
      "FINISH",
      "NEXT_RECOMMENDED",
      "CONTINUE",
      ...Object.keys(EVALUATOR_CONTEXT_ROUTES),
    ]);
    expect(empty.schema?.properties).not.toHaveProperty("contextRequest");
    expect(empty.schema?.additionalProperties).toBe(false);
    expect(empty.schema).not.toHaveProperty("anyOf");
    expect(empty.schema).not.toHaveProperty("oneOf");
    expect(empty.text).toContain(
      "Omit file paths, internal ids and raw logs unless explicitly requested and safe to disclose; never expose secrets or internal reasoning",
    );
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

  it("keeps every violated decision contract in the retry diagnosis", async () => {
    const result = await captureSchema([], {
      output: {
        ...continuing,
        decision: "NEXT_RECOMMENDED",
        effectReceiptIds: ["invented-receipt"],
      },
    });
    expect(result.output.decision).toBe("CONTINUE");
    expect(result.output.thought).toContain("current executable queue");
    expect(result.output.thought).toContain("committed effect receipt");
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

  it("makes the case9 omitted-answer FINISH invalid on the stable wire contract", () => {
    const capturedShape = {
      thought: "All three intents complete; no queue remaining or failures.",
      success: true,
      decision: "FINISH",
      requestFullyCovered: true,
      outcomeCoverage: [
        { intentId: "1", status: "completed", evidenceStepIds: ["step:1"] },
        { intentId: "2", status: "completed", evidenceStepIds: ["step:2"] },
        { intentId: "3", status: "completed", evidenceStepIds: ["step:3"] },
      ],
      replyEffectStatus: "none",
      effectReceiptIds: [],
      recommendedToolCallId: "",
    };
    const before = {
      ...evaluatorSchema,
      required: evaluatorSchema.required?.filter(
        (key) => key !== "messageToUser",
      ),
    };
    const oldErrors: string[] = [];
    validateSchema(before as JsonSchema, capturedShape, "evaluator", oldErrors);
    expect(oldErrors).toEqual([]);
    const errors: string[] = [];
    validateSchema(
      evaluatorSchema as JsonSchema,
      capturedShape,
      "evaluator",
      errors,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("messageToUser");
  });

  it.each([undefined, ""])(
    "retains fail-closed handling for missing/empty required replies: %j",
    async (messageToUser) => {
      const result = await captureSchema([], {
        trajectory: {
          codingMode: false,
          steps: [
            {
              iteration: 1,
              toolCall: { id: "read", name: "READ" },
              result: {
                success: true,
                transcriptVisibility: "internal",
                modelReplyRequired: true,
                data: { value: "amber" },
              },
            },
          ],
        },
        output: {
          ...continuing,
          success: true,
          decision: "FINISH",
          ...(messageToUser === undefined ? {} : { messageToUser }),
        },
      });
      expect(result.schema?.required).toContain("messageToUser");
      expect(result.output).toMatchObject({
        decision: "CONTINUE",
        success: false,
      });
      expect(result.output.messageToUser).toBeUndefined();
      expect(result.modelCalls).toBe(1);
    },
  );

  it("accepts an empty CONTINUE and a grounded answer without a new planner round", async () => {
    const next = await captureSchema([], {
      output: { ...continuing, messageToUser: "" },
    });
    expect(next.output.decision).toBe("CONTINUE");
    const answer = await captureSchema([], {
      trajectory: {
        codingMode: false,
        steps: [
          {
            iteration: 1,
            toolCall: { id: "read", name: "READ" },
            result: {
              success: true,
              transcriptVisibility: "internal",
              modelReplyRequired: true,
              data: { value: "amber" },
            },
          },
        ],
      },
      output: {
        ...continuing,
        success: true,
        decision: "FINISH",
        messageToUser: "The value is amber.",
      },
    });
    expect(answer.output).toMatchObject({
      decision: "FINISH",
      success: true,
      messageToUser: "The value is amber.",
    });
    expect(answer.modelCalls).toBe(1);
    expect(answer.schema).toEqual(next.schema);
  });

  it.each([undefined, ""])(
    "preserves approval of an existing native REPLY with %j",
    async (messageToUser) => {
      const result = await captureSchema([], {
        trajectory: {
          codingMode: false,
          steps: [
            {
              iteration: 1,
              terminalOnly: true,
              terminalMessage: "The value is amber.",
              toolCall: {
                id: "reply",
                name: "REPLY",
                params: { text: "The value is amber." },
              },
              result: { success: true, text: "The value is amber." },
            },
          ],
        },
        output: {
          ...continuing,
          success: true,
          decision: "FINISH",
          ...(messageToUser === undefined ? {} : { messageToUser }),
        },
      });
      expect(result.output).toMatchObject({
        decision: "FINISH",
        success: true,
      });
      expect(result.modelCalls).toBe(1);
    },
  );

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

  it("states only honorable restoration decisions in the dynamic tail", async () => {
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
    const empty = await captureSchema([]);
    const deferred = await captureSchema([], { trajectory: { context } });
    expect(empty.messages.at(-1)?.content).toContain(
      "Available restoration routes: none",
    );
    expect(deferred.messages.at(-1)?.content).toContain(
      "Available restoration routes: RESTORE_HISTORY",
    );
    // Eligibility stays out of the reusable prefix and schema.
    expect(deferred.schema).toEqual(evaluatorSchema);
    expect(deferred.prefixHash).toBe(empty.prefixHash);
  });

  it("rejects a restoration decision when nothing was deferred", async () => {
    const { output } = await captureSchema([], {
      output: {
        thought: "Need provider bodies.",
        success: false,
        decision: "RESTORE_PROVIDERS",
        replyEffectStatus: "none",
      },
    });
    expect(output.protocolFailure).toBe(true);
    expect(output.messageToUser).toBeUndefined();
  });

  it("never mutates the reusable canonical schema", async () => {
    const original = structuredClone(evaluatorSchema);
    await captureSchema([{ id: "one", name: "LOOKUP", params: {} }]);
    await captureSchema([]);
    expect(evaluatorSchema).toEqual(original);
  });
});

it.each([
  ["none", "  exact body"],
  ["LF", "  exact body\n"],
  ["CRLF", "  exact body\r\n"],
  ["CR", "  exact body\r"],
  [undefined, "partial body"],
] as const)(
  "preserves file boundary evidence %s and complete bytes in one evaluator call",
  async (finalLineEnding, text) => {
    const data = {
      readOnlyOperation: true,
      ...(finalLineEnding === undefined ? {} : { finalLineEnding }),
    };
    const readView = {
      slice: {
        completeness:
          finalLineEnding === undefined ? "partial-recoverable" : "complete",
      },
    };
    const captured = await captureSchema([], {
      trajectory: {
        steps: [
          {
            iteration: 1,
            toolCall: {
              id: "read-file",
              name: "READ",
              params: { file_path: "/fixture.txt" },
            },
            result: { success: true, text, data, promptData: { readView } },
          },
        ],
      },
    });
    const tool = captured.messages.find((message) => message.role === "tool");
    if (!tool || !Array.isArray(tool.content))
      throw new Error("Missing complete native tool result");
    const part = tool.content.find((entry) => entry.type === "tool-result");
    if (part?.type !== "tool-result" || part.output.type !== "text")
      throw new Error("Expected native text result");
    const result = JSON.parse(part.output.value);
    expect(result.text).toBe(text);
    expect(result.data).toEqual(data);
    expect(result.promptData).toEqual({ readView });
    expect(captured.modelCalls).toBe(1);
    expect(captured.text).toContain(
      "Whole-file data.finalLineEnding=none contradicts an explicitly required final newline",
    );
    expect(captured.text).toContain("an absent field makes no boundary claim");
  },
);

it.each(["none", "terminal", "current", "archived"] as const)(
  "preserves semantic reasoning preference through attempts for %s evidence",
  async (placement) => {
    const step = {
      iteration: 1,
      toolCall: {
        id: "read-proof",
        name: "READ",
        params: { path: "/fixture" },
      },
      result: { success: true, text: "complete original evidence\n" },
    };
    const captured = await captureSchema([], {
      prepareAttempts: true,
      trajectory: {
        steps:
          placement === "current"
            ? [step]
            : placement === "terminal"
              ? [{ ...step, terminalOnly: true }]
              : [],
        archivedSteps: placement === "archived" ? [step] : [],
      },
    });
    expect(captured.modelCalls).toBe(1);
    expect(captured.attemptOptions).toHaveLength(3);
    for (const options of captured.attemptOptions) {
      expect(options).toHaveProperty("eliza.thinking", "off");
      if (placement === "none" || placement === "terminal") {
        expect(options).not.toHaveProperty("eliza.preferToolReasoning");
      } else {
        expect(options).toHaveProperty("eliza.preferToolReasoning", true);
      }
    }
    expect(captured.schema).toEqual(evaluatorSchema);
    if (placement === "current" || placement === "archived") {
      expect(captured.text).toContain("complete original evidence");
    }
  },
);

describe("applicable evaluator guidance with a stable protocol", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "offers only deferred-source guidance: history=%s providers=%s",
    async (history, providers) => {
      const context: ContextObject = {
        id: "applicable-rules",
        events: [
          ...[1, 2].map((id) => ({
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
          {
            id: "provider:guide",
            type: "provider",
            name: "GUIDE",
            text: `Complete guide ${"detail ".repeat(100)}`,
            discoveryText: "Guide reference.",
          },
        ],
        metadata: { providerDiscoveryEnabled: providers },
      };
      if (history)
        context.metadata = {
          ...context.metadata,
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
      const captured = await captureSchema([], { trajectory: { context } });
      const tail = String(captured.messages.at(-1)?.content);
      const routes = [
        ...(history ? ["RESTORE_HISTORY"] : []),
        ...(providers ? ["RESTORE_PROVIDERS"] : []),
        ...(history && providers ? ["RESTORE_FULL"] : []),
      ];
      expect(tail).toContain(
        `Available restoration routes: ${routes.join(", ") || "none"}`,
      );
      expect(tail.includes("Choose RESTORE_HISTORY only")).toBe(
        history && !providers,
      );
      expect(tail.includes("Choose RESTORE_PROVIDERS only")).toBe(
        providers && !history,
      );
      expect(tail.includes("Choose one restoration decision")).toBe(
        history && providers,
      );
      expect(captured.schema).toEqual(evaluatorSchema);
      expect(evaluatorTemplate).not.toContain(
        "Choose one restoration decision",
      );
      expect(tail).not.toContain("For every completed change claimed");
    },
  );

  it.each(["RESTORE_HISTORY", "RESTORE_PROVIDERS", "RESTORE_FULL"])(
    "rejects unavailable %s without publishing or running effects",
    async (decision) => {
      const result = await captureSchema([], {
        output: { thought: "Need a source", decision, success: false },
      });
      expect(result.modelCalls).toBe(1);
      expect(result.output).toMatchObject({
        success: false,
        protocolFailure: true,
        parseError: "Full completion context was already supplied",
      });
      expect(result.output.messageToUser).toBeUndefined();
    },
  );

  it("moves receipt-selection guidance only to a state with committed proof", async () => {
    const result = await captureSchema([], {
      trajectory: {
        steps: [
          {
            iteration: 1,
            result: { success: true, text: "Saved", effectReceipts: [receipt] },
          },
        ],
      },
    });
    expect(String(result.messages.at(-1)?.content)).toContain(
      "For every completed change claimed",
    );
    expect(evaluatorTemplate).not.toContain(
      "For every completed change claimed",
    );
    expect(result.schema).toEqual(evaluatorSchema);
  });
});
