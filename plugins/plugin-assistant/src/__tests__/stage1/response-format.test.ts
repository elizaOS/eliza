import { CONNECTOR_ACCOUNT_SERVICE_TYPE } from "@elizaos/core";
import type {
  Action,
  IAgentRuntime,
  Memory,
  ResponseHandlerEvaluator,
  State,
} from "@elizaos/core/protocol";
import {
  ChannelType,
  ContextRegistry,
  effectDeliveryBindingProvesApplication,
  ModelType,
  registerDirectActionRoutingRule,
  type UUID,
} from "@elizaos/core/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_RESPONSE_HANDLER_EVALUATORS,
  messageContinuesAfterRecentAgentCorrection,
  messageHandlerFromFieldResult,
  runV5MessageRuntimeStage1,
} from "../../services/message.js";
import {
  acceptedRecoveryReview,
  makeAttachmentState,
  makeMemorySearchAction,
  makeMessage,
  makeRuntime,
  makeState,
  plannerReplyRejectedByEgress,
  reportErrorCalls,
  runStage1,
  stage1Response,
  useModelCalls,
  withReplyGateMode,
  withReplyGateSlots,
} from "./fixtures.js";

describe("Stage 1 response format", () => {
  it.each([ChannelType.DM, ChannelType.VOICE_DM])(
    "reviews navigation with no pending intent before effects (%s)",
    async (channelType) => {
      const conflict = stage1Response({
        contexts: ["simple"],
        intents: [],
        candidateActionNames: ["VIEWS_SHOW"],
        replyText: "Hey. What's up?",
        facts: ["Unaccepted draft extraction"],
        extra: {
          replyEffectStatus: "applied",
          visualContinuation: {
            disposition: "direct",
            viewId: "chat",
          },
        },
      });
      const corrected = stage1Response({
        contexts: ["simple"],
        intents: [],
        replyText: "Hey. What's up?",
        extra: {
          replyEffectStatus: "none",
          visualContinuation: { disposition: "none" },
        },
      });
      const runtime = makeRuntime([conflict, corrected]);
      const dispatch = vi.spyOn(
        runtime.responseHandlerFieldRegistry,
        "dispatch",
      );
      const result = await runStage1({
        runtime,
        message: makeMessage({ text: "Hey.", channelType }),
      });
      expect(result.kind).toBe("direct_reply");
      if (result.kind === "direct_reply")
        expect(result.result.responseContent?.text).toBe("Hey. What's up?");
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]?.[0].rawParsed.facts).toEqual([]);
      expect(useModelCalls(runtime).map(([model]) => model)).toEqual([
        ModelType.RESPONSE_HANDLER,
        ModelType.RESPONSE_HANDLER,
      ]);
      const repeated = makeRuntime([conflict, conflict]);
      const repeatedDispatch = vi.spyOn(
        repeated.responseHandlerFieldRegistry,
        "dispatch",
      );
      await expect(
        runStage1({
          runtime: repeated,
          message: makeMessage({
            text: "A new conversational turn.",
            channelType,
          }),
        }),
      ).rejects.toMatchObject({ code: "STAGE1_ROUTING_CONFLICT" });
      expect(repeatedDispatch).not.toHaveBeenCalled();
      expect(useModelCalls(repeated)).toHaveLength(2);
    },
  );

  it.each([ChannelType.DM, ChannelType.VOICE_DM, ChannelType.GROUP])(
    "keeps the system prefix identical when loading a stable provider reference on %s",
    async (channelType) => {
      const full =
        "Complete character preferences: use plain language and address the user as Sam.";
      const runtime = makeRuntime([
        stage1Response({
          contextRequests: ["userPersonalityPreferences"],
          contexts: ["simple"],
        }),
        stage1Response({
          contexts: ["simple"],
          replyText: "Here is the form.",
        }),
      ]);
      runtime.providers = [
        { name: "userPersonalityPreferences", cacheStable: true, get: vi.fn() },
      ];
      const state = makeState();
      state.data.providers = {
        userPersonalityPreferences: {
          text: full,
          discoveryText: "context_discovery: userPersonalityPreferences",
        },
      };
      runtime.composeState = vi.fn(async () => structuredClone(state));
      await runStage1({
        runtime,
        message: makeMessage({ channelType }),
        state,
      });
      const calls = useModelCalls(runtime).map(
        ([, params]) =>
          params as {
            messages: Array<{ role: string; content: string }>;
            providerOptions: {
              eliza: { prefixHash: string };
              cerebras: { prompt_cache_key: string };
              openai: { parallelToolCalls: boolean };
            };
          },
      );
      expect(calls).toHaveLength(2);
      expect(calls[0]?.providerOptions.cerebras.prompt_cache_key).toBeTruthy();
      expect(calls[1]?.providerOptions.cerebras.prompt_cache_key).toBe(
        calls[0]?.providerOptions.cerebras.prompt_cache_key,
      );
      expect(calls[0]?.messages[0]).toEqual(calls[1]?.messages[0]);
      expect(calls[0]?.providerOptions.eliza.prefixHash).toEqual(
        calls[1]?.providerOptions.eliza.prefixHash,
      );
      expect(JSON.stringify(calls[0]?.messages)).not.toContain(full);
      expect(
        calls[1]?.messages.find((message) => message.role === "user")?.content,
      ).toContain(full);
    },
  );

  it("separates shared-room agents while preserving resumed Stage 1 affinity", async () => {
    const captures: Array<{ key: string; messages: unknown }> = [];
    for (const suffix of ["3", "4", "3"]) {
      const runtime = makeRuntime([
        stage1Response({ contexts: ["simple"], replyText: "Ready." }),
      ]);
      runtime.agentId = `00000000-0000-0000-0000-00000000000${suffix}` as UUID;
      await runStage1({
        runtime,
        message: makeMessage(),
        responseId: "00000000-0000-0000-0000-000000000006" as UUID,
      });
      const params = useModelCalls(runtime)[0]?.[1] as {
        messages: unknown;
        providerOptions: { cerebras: { prompt_cache_key: string } };
      };
      captures.push({
        key: params.providerOptions.cerebras.prompt_cache_key,
        messages: params.messages,
      });
    }
    expect(captures[0]?.key).toBeTruthy();
    expect(captures[0]?.key).not.toBe(captures[1]?.key);
    expect(captures[0]?.key).toBe(captures[2]?.key);
    expect(captures[0]?.messages).toEqual(captures[2]?.messages);
  });

  it("tolerates a partial runtime without model registration introspection", async () => {
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "Hello from a partial runtime.",
      }),
    ]);
    delete (runtime as Partial<IAgentRuntime>).getModelRegistrations;

    const result = await runStage1({
      runtime,
      message: makeMessage(),
    });

    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe(
        "Hello from a partial runtime.",
      );
    }
  });

  it.each<{
    name: string;
    thought: string;
    plannerThought: string;
    actionName: string;
    reply: string;
    responseId: UUID;
    actionOverrides: Partial<Action> | null;
  }>([
    {
      name: "keeps a MIXED disclosure+role rejection set on the planner path (#20679)",
      thought: "The user asked for an owner read and a restricted action.",
      plannerThought: "Explain the role limitation for the non-private action.",
      actionName: "ADMIN_TASK",
      reply: "This action requires an administrator role.",
      responseId: "00000000-0000-0000-0000-000000000009",
      actionOverrides: { roleGate: { minRole: "OWNER" } },
    },
    {
      name: "keeps a MIXED disclosure+validate-false rejection set on the planner path (#20869)",
      thought: "The user asked for an owner read and an unavailable action.",
      plannerThought:
        "Explain that the second action is not available right now.",
      actionName: "UNAVAILABLE_TASK",
      reply: "That action is not available in the current state.",
      responseId: "00000000-0000-0000-0000-000000000019",
      actionOverrides: { validate: async () => false },
    },
    {
      name: "keeps a MIXED disclosure+account-policy rejection set on the planner path (#20869)",
      thought: "The user asked for an owner read and a connector-bound action.",
      plannerThought:
        "Explain that no connector account is available for the action.",
      actionName: "CONNECTOR_TASK",
      reply: "No connected account is available for that action.",
      responseId: "00000000-0000-0000-0000-000000000020",
      actionOverrides: {
        connectorAccountPolicy: { provider: "unregistered-provider" },
      },
    },
    {
      name: "keeps a MIXED disclosure+missing-action set on the planner path (#20869)",
      thought: "The user asked for an owner read and an unavailable action.",
      plannerThought: "Explain that the second capability is unavailable.",
      actionName: "MISSING_TASK",
      reply: "That capability is not available here.",
      responseId: "00000000-0000-0000-0000-000000000021",
      actionOverrides: null,
    },
    {
      name: "keeps a MIXED disclosure+validation-error set on the planner path (#20869)",
      thought: "The user asked for an owner read and a failing action.",
      plannerThought: "Explain that the second capability failed validation.",
      actionName: "FAILING_TASK",
      reply: "That capability could not be validated.",
      responseId: "00000000-0000-0000-0000-000000000022",
      actionOverrides: {
        validate: async () => {
          throw new Error("validation dependency failed");
        },
      },
    },
    {
      name: "keeps a MIXED disclosure+account-policy-error set on the planner path (#20869)",
      thought: "The user asked for an owner read and a connector action.",
      plannerThought: "Explain that connector policy could not be evaluated.",
      actionName: "CONNECTOR_TASK",
      reply: "That connector capability could not be validated.",
      responseId: "00000000-0000-0000-0000-000000000023",
      actionOverrides: {
        connectorAccountPolicy: { provider: "failing-provider" },
      },
    },
  ])(
    "$name",
    async ({
      thought,
      plannerThought,
      actionName,
      reply,
      responseId,
      actionOverrides,
    }) => {
      const runtime = makeRuntime([
        stage1Response({
          thought,
          contexts: ["general"],
          candidateActionNames: ["OWNER_TODOS", actionName],
          extra: { requiresTool: true },
        }),
        JSON.stringify({
          thought: plannerThought,
          toolCalls: [],
          messageToUser: reply,
        }),
      ]);
      runtime.actions = [
        {
          ...makeMemorySearchAction(),
          name: "OWNER_TODOS",
          disclosureGate: { require: "owner_exclusive" },
        },
        ...(actionOverrides === null
          ? []
          : [
              {
                ...makeMemorySearchAction(),
                name: actionName,
                contexts: ["general"],
                ...actionOverrides,
              },
            ]),
      ];
      const accountPolicyError = new Error(
        "connector policy dependency failed",
      );
      const failingPolicy =
        actionOverrides?.connectorAccountPolicy?.provider ===
        "failing-provider";
      if (failingPolicy) {
        (runtime.getService as ReturnType<typeof vi.fn>).mockImplementation(
          (serviceType: string) =>
            serviceType === CONNECTOR_ACCOUNT_SERVICE_TYPE
              ? {
                  registerProvider: vi.fn(),
                  evaluatePolicy: vi.fn(async () => {
                    throw accountPolicyError;
                  }),
                }
              : null,
        );
      }

      const result = await runStage1({
        runtime,
        message: makeMessage({ channelType: ChannelType.GROUP }),
        responseId,
      });

      expect(result.kind).toBe("planned_reply");
      if (result.kind === "planned_reply") {
        expect(result.result.responseContent?.text).toBe(reply);
        expect(result.result.responseContent?.text).not.toMatch(
          /that's private|owner's private info|private information in this conversation/i,
        );
      }
      if (actionName === "FAILING_TASK")
        expect(reportErrorCalls(runtime).length).toBeGreaterThan(0);
      if (failingPolicy)
        expect(reportErrorCalls(runtime)).toContainEqual([
          "MessageService.plannerActionValidation",
          accountPolicyError,
          { action: "CONNECTOR_TASK", parentAction: undefined },
        ]);
      expect(useModelCalls(runtime)).toHaveLength(2);
    },
  );

  it("blocks a Stage-1 array containing a control record", async () => {
    const actionBatch =
      '[{"status":"queued"},{"action":"BROWSER","parameters":{"url":"https://example.com"}}]';
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: actionBatch,
      }),
    ]);

    const result = await runStage1({
      runtime,
      message: makeMessage({ text: "Open example.com" }),
    });

    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe(
        "I'm not sure how to answer that.",
      );
      expect(result.result.responseContent?.text).not.toContain("BROWSER");
    }
    const reported = reportErrorCalls(runtime)[0]?.[1] as {
      code?: string;
      context?: Record<string, unknown>;
    };
    expect(reported.code).toBe("STAGE1_INVALID_USER_VISIBLE_OUTPUT");
    expect(reported.context).toMatchObject({
      classification: "action",
      fieldPath: [],
    });
  });

  it("rejects a partial Stage 1 envelope even when replyText is complete", async () => {
    const runtime = makeRuntime([
      {
        text: [
          '{"shouldRespond":"RESPOND","contexts":["simple"],',
          '"replyText":"```python\\ndef fibonacci(n):\\n    a, b = 0, 1\\n    for _ in range(n):\\n        a, b = b, a + b\\n    return a\\n```",',
          '"facts":[',
        ].join(""),
        finishReason: "length",
        usage: {
          promptTokens: 100,
          completionTokens: 2048,
          totalTokens: 2148,
        },
      },
    ]);

    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "write a 5-line python function that returns fibonacci",
      }),
    });

    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toContain(
        "That answer got cut off",
      );
    }
    expect(runtime.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        src: "service:message",
        finishReason: "length",
        maxTokens: undefined,
      }),
      "[message] Stage 1 hit the completion-token limit",
    );
  });

  it("surfaces a clear reply when Stage 1 truncates before a reply can be recovered", async () => {
    const runtime = makeRuntime([
      {
        text: '{"shouldRespond":"RESPOND","contexts":["simple"],"replyText":"```python\\ndef fib',
        finishReason: "length",
        usage: {
          promptTokens: 100,
          completionTokens: 2048,
          totalTokens: 2148,
        },
      },
    ]);

    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "write a 5-line python function that returns fibonacci",
      }),
    });

    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe(
        "That answer got cut off before I could finish it. Please try again with a shorter request or ask for a narrower format.",
      );
    }
  });

  it("marks a genuine Stage-1 direct reply agentVoiced so gated transports skip the re-voice (#14873)", async () => {
    const runtime = makeRuntime([
      stage1Response({
        thought: "Direct answer.",
        contexts: ["simple"],
        replyText: "BTC is at $63,327 right now.",
      }),
    ]);

    const result = await runStage1({
      runtime,
      message: makeMessage({ text: "btc price?" }),
    });

    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      // The Stage-1 replyText IS the model's own composed voice; the
      // provenance flag is what lets `ensureAgentVoice` short-circuit at
      // `sendMessageToTarget` instead of spending a blocking TEXT_SMALL
      // re-voice on every chat turn.
      expect(result.result.responseContent?.agentVoiced).toBe(true);
      expect(result.result.responseMessages[0]?.content.agentVoiced).toBe(true);
    }
  });

  it("leaves the hardcoded unusable-reply deferral unmarked so the voice gate still owns it (#14873)", async () => {
    const runtime = makeRuntime([
      stage1Response({ contexts: ["simple"], replyText: "I don't know." }),
    ]);

    const result = await runStage1({
      runtime,
      message: makeMessage({ text: "What is 2+2?" }),
    });

    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      // The deferral is a hardcoded template, not model voice — it must NOT
      // carry the provenance flag, so the humanness gate still rephrases it
      // before it reaches a user.
      expect(result.result.responseContent?.text).toBe(
        "I'm not sure how to answer that.",
      );
      expect(result.result.responseContent?.agentVoiced).toBeUndefined();
    }
  });

  it("keeps a valid-but-terse numeric Stage 1 reply without a second model call", async () => {
    // A correct-but-terse numeric answer ("4") trips the low-quality heuristic
    // but is worth keeping. There is no direct-reply regeneration path, so the
    // uncapped Stage-1 reply is the single source of truth: it is kept verbatim
    // with no second TEXT_SMALL call.
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "4",
      }),
    ]);

    const result = await runStage1({
      runtime,
      message: makeMessage({ text: "What is 2+2?" }),
    });

    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe("4");
    }
    // Exactly one model call: the Stage-1 reply itself. No regeneration.
    expect(useModelCalls(runtime).length).toBe(1);
  });

  it("keeps requested all-caps exact-word Stage 1 replies without a second model call", async () => {
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "BTC",
      }),
    ]);

    const result = await runStage1({
      runtime,
      message: makeMessage({ text: "Reply with exactly one word: BTC." }),
    });

    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe("BTC");
    }
    expect(useModelCalls(runtime).length).toBe(1);
  });

  it("keeps an all-caps reply the user explicitly asked the agent to say", async () => {
    // "Say PONG" -> "PONG" used to dead-end into the fallback because
    // isUnusableStage1Reply flags any non-allowlisted 2-8 char all-caps word.
    // When the user explicitly requested that token, the reply is intentional.
    for (const [ask, want] of [
      ["Say PONG", "PONG"],
      ["say HELLO", "HELLO"],
      ["please respond with the word PING", "PING"],
      // quantified connector forms — "the single word" / "one word" between
      // the verb and the literal (the acceptance-gate smoke phrasing)
      ["Reply with the single word: PONG", "PONG"],
      ["reply with a single word: PONG", "PONG"],
      ["Reply with one word: PONG", "PONG"],
      ["Respond with the single word PONG", "PONG"],
      // mention-prefixed (Discord/Telegram render the mention into the text)
      ["remilio (@1490833425802854491) Say PONG", "PONG"],
      ["<@1490833425802854491> say HELLO", "HELLO"],
    ] as const) {
      const runtime = makeRuntime([
        stage1Response({ contexts: ["simple"], replyText: want }),
      ]);
      const result = await runStage1({
        runtime,
        message: makeMessage({ text: ask }),
        responseId: "00000000-0000-0000-0000-000000000006" as UUID,
      });
      expect(result.kind).toBe("direct_reply");
      if (result.kind === "direct_reply") {
        expect(result.result.responseContent?.text).toBe(want);
      }
    }
  });

  it("keeps PONG from the acceptance-gate smoke's exact raw gemma envelope", async () => {
    // Byte-for-byte the raw RESPONSE_HANDLER output gemma-4-31b returned
    // through the Eliza Cloud proxy for the benchmark acceptance-gate smoke
    // prompt (captured live from the bench-server trajectory recorder). The
    // plain-JSON plan envelope parses to reply "PONG", which the all-caps
    // unusable heuristic flags; the say-literal recognizer must classify
    // "Reply with the single word: PONG" as an explicit request so the reply
    // ships instead of the "I'm not sure how to answer that." deferral.
    const runtime = makeRuntime([
      '{"processMessage":"RESPOND","thought":"","plan":{"contexts":["simple"],"reply":"PONG","simple":true,"requiresTool":false}}',
    ]);
    const result = await runStage1({
      runtime,
      message: makeMessage({ text: "Reply with the single word: PONG" }),
      responseId: "00000000-0000-0000-0000-000000000008" as UUID,
    });
    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe("PONG");
    }
    expect(useModelCalls(runtime).length).toBe(1);
  });

  it("still defers an all-caps echo the user never asked for", async () => {
    // The say-literal recognizer only accepts complete connector units, never
    // bare determiners: "write a poem" must not parse as a request to say
    // "poem", so an all-caps "POEM" echo stays classified as enum/scaffold
    // leakage and defers.
    const runtime = makeRuntime([
      stage1Response({ contexts: ["simple"], replyText: "POEM" }),
      "   ",
    ]);
    const result = await runStage1({
      runtime,
      message: makeMessage({ text: "write a poem" }),
      responseId: "00000000-0000-0000-0000-000000000009" as UUID,
    });
    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe(
        "I'm not sure how to answer that.",
      );
    }
  });

  it("keeps a real answer that merely CONTAINS a repeated-character run", async () => {
    // The junk check flags a reply that IS a glitch run ("aaaaa"), anchored.
    // A real answer containing a run — aligned `df -h` columns, a "-----"
    // divider, an "XXXXXXXX" placeholder — must not be blanked to the
    // generic deferral.
    for (const goodReply of [
      "Filesystem      Size  Used Avail Use%\n/dev/sda1       387G  381G  5.8G  99%",
      "Results\n--------\nAll checks passed.",
      "Use the placeholder XXXXXXXX until the key arrives.",
    ]) {
      const runtime = makeRuntime([
        stage1Response({ contexts: ["simple"], replyText: goodReply }),
      ]);
      const result = await runStage1({
        runtime,
        message: makeMessage({ text: "how full is the disk?" }),
        responseId: "00000000-0000-0000-0000-000000000007" as UUID,
      });
      expect(result.kind).toBe("direct_reply");
      if (result.kind === "direct_reply") {
        expect(result.result.responseContent?.text).toBe(goodReply);
      }
    }
  });

  it("keeps prose containing a separator or emphasis run (#11504)", async () => {
    // "=====" separators and stretched words are legitimate content; only a
    // reply that is NOTHING BUT repeated-character runs is degenerate output.
    for (const reply of [
      "Results:\n=====\nAll 20 checks passed.",
      "Sooooo happy this worked out for you!",
    ]) {
      const runtime = makeRuntime([
        stage1Response({ contexts: ["simple"], replyText: reply }),
      ]);
      const result = await runStage1({
        runtime,
        message: makeMessage({ text: "How did the checks go?" }),
      });
      expect(result.kind).toBe("direct_reply");
      if (result.kind === "direct_reply") {
        expect(result.result.responseContent?.text).toBe(reply);
      }
    }
  });

  it.each([
    "不要回复",
    "No respondas",
    "Please cease responding",
    "one line: what's the capital of chile?",
  ])(
    "honors an explicit terminal-review opt-out without language matching: %s",
    async (text) => {
      const runtime = makeRuntime(
        [
          stage1Response({ shouldRespond: "STOP", contexts: [] }),
          stage1Response({
            contexts: ["simple"],
            replyText: "This must never be delivered.",
          }),
        ],
        { ELIZA_STAGE1_TERMINAL_REASK: "0" },
      );
      const handler = vi.fn(async () => ({
        success: true,
        text: "Unexpected domain effect",
      }));
      runtime.actions = [
        {
          name: "NOTES_CREATE",
          description: "Create a saved note.",
          validate: async () => true,
          handler,
        },
      ];
      const callback = vi.fn(async () => []);
      const onResponseHandlerEarlyReply = vi.fn();
      const onSettledActionResult = vi.fn();
      const result = await runStage1({
        callback,
        onResponseHandlerEarlyReply,
        onSettledActionResult,
        runtime,
        message: makeMessage({ text, channelType: ChannelType.DM }),
      });
      expect(callback).not.toHaveBeenCalled();
      expect(onResponseHandlerEarlyReply).not.toHaveBeenCalled();
      expect(onSettledActionResult).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(result).toMatchObject({ kind: "terminal", action: "STOP" });
      expect(useModelCalls(runtime).map(([type]) => type)).toEqual([
        ModelType.RESPONSE_HANDLER,
      ]);
    },
  );

  it.each([ChannelType.DM, ChannelType.VOICE_DM])(
    "reviews a silent direct follow-up once by default on %s",
    async (channelType) => {
      const runtime = makeRuntime([
        stage1Response({ shouldRespond: "STOP", contexts: [] }),
        stage1Response({
          contexts: ["simple"],
          replyText: "Yes, Home is open.",
        }),
      ]);
      const dispatch = vi.spyOn(
        runtime.responseHandlerFieldRegistry,
        "dispatch",
      );
      const result = await runStage1({
        runtime,
        message: makeMessage({
          text: "Did you open it?",
          channelType,
          metadata: { uiViewPath: "/chat" },
        }),
      });
      expect(result.kind).toBe("direct_reply");
      if (result.kind === "direct_reply")
        expect(result.result.responseContent?.text).toBe("Yes, Home is open.");
      expect(useModelCalls(runtime)).toHaveLength(2);
      expect(dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it("honors a confirmed direct STOP without a third review", async () => {
    const runtime = makeRuntime([
      stage1Response({ shouldRespond: "STOP", contexts: [] }),
      stage1Response({ shouldRespond: "STOP", contexts: [] }),
    ]);
    const callback = vi.fn(async () => []);
    const result = await runStage1({
      runtime,
      callback,
      message: makeMessage({
        text: "Please stop responding.",
        channelType: ChannelType.DM,
      }),
    });
    expect(result).toMatchObject({ kind: "terminal", action: "STOP" });
    expect(useModelCalls(runtime)).toHaveLength(2);
    expect(callback).not.toHaveBeenCalled();
  });

  it.each([
    [true, "STOP", "STOP", 2],
    [true, "IGNORE", "IGNORE", 2],
    [true, "STOP", "IGNORE", 2],
    [true, "IGNORE", "STOP", 2],
    [false, "STOP", "STOP", 1],
    [false, "IGNORE", "IGNORE", 2],
  ] as const)(
    "shares one terminal review: optIn=%s first=%s repeated=%s calls=%s",
    async (optIn, first, repeated, expectedCalls) => {
      const runtime = makeRuntime(
        [
          stage1Response({ shouldRespond: first, contexts: [] }),
          stage1Response({ shouldRespond: repeated, contexts: [] }),
        ],
        optIn
          ? { ELIZA_STAGE1_TERMINAL_REASK: "1" }
          : { ELIZA_STAGE1_TERMINAL_REASK: "0" },
      );
      const result = await runV5MessageRuntimeStage1({
        runtime,
        message: makeMessage({
          text: "ok that's all",
          channelType: ChannelType.DM,
        }),
        state: makeState(),
        responseId: "00000000-0000-0000-0000-000000000005" as UUID,
      });
      expect(result).toMatchObject({
        kind: "terminal",
        action: expectedCalls === 1 ? first : repeated,
      });
      expect(useModelCalls(runtime).map(([type]) => type)).toEqual(
        Array.from({ length: expectedCalls }, () => ModelType.RESPONSE_HANDLER),
      );
    },
  );

  it.each([ChannelType.GROUP])(
    "does not opt unaddressed group traffic into terminal review: %s",
    async (channelType) => {
      const runtime = makeRuntime(
        [stage1Response({ shouldRespond: "STOP", contexts: [] })],
        { ELIZA_STAGE1_TERMINAL_REASK: "1" },
      );
      const result = await runV5MessageRuntimeStage1({
        runtime,
        message: makeMessage({ text: "ok that's all", channelType }),
        state: makeState(),
        responseId: "00000000-0000-0000-0000-000000000005" as UUID,
      });
      expect(result).toMatchObject({ kind: "terminal", action: "STOP" });
      expect(useModelCalls(runtime).map(([type]) => type)).toEqual([
        ModelType.RESPONSE_HANDLER,
      ]);
    },
  );

  it("keeps an explicitly addressed group terminal review within one re-ask", async () => {
    const runtime = makeRuntime(
      [
        stage1Response({ shouldRespond: "STOP", contexts: [] }),
        stage1Response({ shouldRespond: "IGNORE", contexts: [] }),
      ],
      { ELIZA_STAGE1_TERMINAL_REASK: "1" },
    );
    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({
        text: "ok that's all",
        channelType: ChannelType.GROUP,
        mentionContext: { isMention: true },
      }),
      state: makeState(),
      responseId: "00000000-0000-0000-0000-000000000005" as UUID,
    });
    expect(result).toMatchObject({ kind: "terminal", action: "IGNORE" });
    expect(useModelCalls(runtime).map(([type]) => type)).toEqual([
      ModelType.RESPONSE_HANDLER,
      ModelType.RESPONSE_HANDLER,
    ]);
  });

  it("preserves coding-mode Stage-1 bypass with terminal review enabled", async () => {
    const runtime = makeRuntime([], { ELIZA_STAGE1_TERMINAL_REASK: "1" });
    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({
        text: "ok that's all",
        channelType: ChannelType.DM,
      }),
      state: makeState(),
      codingMode: true,
      stage1DecisionOnly: true,
      responseId: "00000000-0000-0000-0000-000000000005" as UUID,
    });
    expect(result).toMatchObject({ kind: "decision", action: "RESPOND" });
    expect(useModelCalls(runtime)).toHaveLength(0);
  });

  it.each(["STOP", "IGNORE"] as const)(
    "delivers a corrected reply after one opt-in terminal review of %s",
    async (first) => {
      const runtime = makeRuntime(
        [
          stage1Response({ shouldRespond: first, contexts: [] }),
          stage1Response({ contexts: ["simple"], replyText: "Santiago." }),
        ],
        { ELIZA_STAGE1_TERMINAL_REASK: "1" },
      );
      const result = await runV5MessageRuntimeStage1({
        runtime,
        message: makeMessage({
          text: "one line: what's the capital of chile?",
          channelType: ChannelType.DM,
        }),
        state: makeState(),
        responseId: "00000000-0000-0000-0000-000000000005" as UUID,
      });
      expect(result.kind).toBe("direct_reply");
      if (result.kind === "direct_reply") {
        expect(result.result.responseContent?.text).toBe("Santiago.");
      }
      expect(useModelCalls(runtime).map(([type]) => type)).toEqual([
        ModelType.RESPONSE_HANDLER,
        ModelType.RESPONSE_HANDLER,
      ]);
    },
  );

  it("answers a current-time question from the CURRENT_TIME observation when the direct reply misstates the clock", async () => {
    // Shadow proof 2026-09-16 (tj-a6376df29707fc): the 27B planner answered
    // "1:17pm EDT." at 1:17 AM. The observation is the complete answer.
    const runtime = makeRuntime([
      stage1Response({ contexts: ["simple"], replyText: "1:17pm EDT." }),
    ]);
    const state: State = {
      values: { availableContexts: "general, calendar" },
      text: "Recent conversation summary",
      data: {
        providers: {
          CURRENT_TIME: {
            text: "# Current Time\n- User local time: Wednesday, September 16, 2026 at 1:17:40 AM EDT\n- User timezone: America/New_York",
            values: {
              currentTime: "2026-09-16T05:17:40.000Z",
              currentDate: "2026-09-16",
              timeZone: "America/New_York",
            },
            data: {
              iso: "2026-09-16T05:17:40.000Z",
              date: "2026-09-16",
              humanReadable: "Wednesday, September 16, 2026 at 1:17:40 AM EDT",
              timeZone: "America/New_York",
              dayOfWeek: "Wednesday",
            },
          },
        },
      },
    };
    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({
        text: "what time is it right now for me?",
        channelType: ChannelType.DM,
      }),
      state,
      responseId: "00000000-0000-0000-0000-000000000005" as UUID,
    });
    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe(
        "It's Wednesday, September 16, 2026 at 1:17:40 AM EDT.",
      );
    }
    expect(useModelCalls(runtime)).toHaveLength(1);
  });

  it("judges a document-augmented API turn by the user's own words, not the augmentation envelope", async () => {
    // Shadow proof 2026-09-16 (tj-a6376df29707fc): the chat route wrapped
    // "what time is it right now for me?" in the contextual-documents
    // envelope (content.currentMessageText keeps the user's text) and the
    // clock check never matched the envelope, so "1:17pm EDT." at 1:17 AM
    // shipped. Every request-text gate reads the user's words.
    const runtime = makeRuntime([
      stage1Response({ contexts: ["simple"], replyText: "1:17pm EDT." }),
    ]);
    const state: State = {
      values: { availableContexts: "general, calendar" },
      text: "Recent conversation summary",
      data: {
        providers: {
          CURRENT_TIME: {
            text: "# Current Time\n- User local time: Wednesday, September 16, 2026 at 1:17:40 AM EDT",
            values: {},
            data: {
              iso: "2026-09-16T05:17:40.000Z",
              date: "2026-09-16",
              humanReadable: "Wednesday, September 16, 2026 at 1:17:40 AM EDT",
              timeZone: "America/New_York",
            },
          },
        },
      },
    };
    const result = await runV5MessageRuntimeStage1({
      runtime,
      message: makeMessage({
        text: 'Answer the user request using the contextual documents below as the source of truth when they contain the answer.\n\n<contextual_documents>\n<source title="source-1" similarity="1.000">\nQ: How do I see the tutorial again?\nA: Type "restart tutorial" in the chat any time.\n</source>\n</contextual_documents>\n\nUser request: what time is it right now for me?',
        currentMessageText: "what time is it right now for me?",
        channelType: ChannelType.DM,
      }),
      state,
      responseId: "00000000-0000-0000-0000-000000000005" as UUID,
    });
    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe(
        "It's Wednesday, September 16, 2026 at 1:17:40 AM EDT.",
      );
    }
    expect(useModelCalls(runtime)).toHaveLength(1);
  });

  it("keeps a refusal that continues into content and a bare social apology (#11504)", async () => {
    // Refusal-plus-content carries an answer; apology-only is a legitimate
    // conversational reply. Neither is an unusable stub.
    for (const reply of [
      "I'm not sure, but my best guess is 42.",
      "Sorry about that.",
      "Sorry.",
    ]) {
      const runtime = makeRuntime([
        stage1Response({ contexts: ["simple"], replyText: reply }),
      ]);
      const result = await runStage1({
        runtime,
        message: makeMessage({ text: "What's the answer?" }),
      });
      expect(result.kind).toBe("direct_reply");
      if (result.kind === "direct_reply") {
        expect(result.result.responseContent?.text).toBe(reply);
      }
    }
  });

  it("keeps generic programming questions on the simple path even when stale attachments linger in state", async () => {
    // Regression for the false-positive routing where a verb like "read"
    // in a normal dev question ("read a large file line by line in node")
    // was hijacked into the planner whenever any attachment lingered in
    // the conversation state (e.g. from older probes in the same channel).
    // The fix removes the bare-verb branch of
    // `looksLikeAttachmentInspectionRequest` so only noun-anchored
    // attachment references trigger the routing.
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "Use the built-in readline module to stream lines.",
        extra: { requiresTool: false },
      }),
    ]);
    const state = makeAttachmentState();
    runtime.composeState = vi.fn(async () => state) as never;

    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "what's a good way to read a large file line by line in node?",
      }),
      state,
    });

    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe(
        "Use the built-in readline module to stream lines.",
      );
    }
    // No planner reroute. Only Stage 1 should have run.
    expect(useModelCalls(runtime)).toHaveLength(1);
  });

  it("does not treat the agent's own attachment ack as a user follow-up anchor", async () => {
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "I don't see anything new yet.",
        extra: { requiresTool: false },
      }),
    ]);
    const state = makeAttachmentState();
    const recentMessages =
      ((
        state.data.providers as Record<
          string,
          { data: Record<string, unknown> }
        >
      ).RECENT_MESSAGES.data.recentMessages as Memory[]) ?? [];
    recentMessages.length = 0;
    recentMessages.push({
      id: "00000000-0000-0000-0000-000000000012" as UUID,
      entityId: runtime.agentId,
      roomId: "00000000-0000-0000-0000-000000000004" as UUID,
      createdAt: 2,
      content: {
        text: "Looking into the attachments...",
        source: "test",
      },
    } as Memory);
    runtime.composeState = vi.fn(async () => state) as never;

    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "find anything?",
        mentionContext: { isReply: true },
      }),
      state,
    });

    expect(result.kind).toBe("direct_reply");
    expect(useModelCalls(runtime)).toHaveLength(1);
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe(
        "I don't see anything new yet.",
      );
    }
  });

  it("keeps optimized message-handler catalog instructions complete", async () => {
    const description = "Operator-owned context description. ".repeat(40);
    const runtime = makeRuntime([
      stage1Response({ contexts: ["simple"], replyText: "Hi." }),
    ]);
    runtime.actions = [
      {
        name: "CUSTOM_CATALOG_READ",
        description: "Read custom data",
        contexts: ["custom_catalog"],
      },
    ];
    runtime.contexts = new ContextRegistry([
      { id: "custom_catalog", description },
    ]);
    runtime.getService = vi.fn((name: string) =>
      name === "optimized_prompt"
        ? {
            getPrompt: () => ({
              prompt:
                "Operator instructions.\navailable_contexts:\n{{availableContexts}}",
            }),
          }
        : null,
    ) as IAgentRuntime["getService"];
    await runStage1({
      runtime,
      message: makeMessage({ channelType: ChannelType.DM }),
    });
    const params = useModelCalls(runtime)[0]?.[1] as {
      messages: Array<{ content: string }>;
    };
    const wire = params.messages.map(({ content }) => content).join("\n");
    expect(wire).toContain("Operator instructions.");
    expect(wire).toContain(description.trim());
    expect(wire).not.toContain("context_discovery: CONTEXT_CATALOG");
  });

  it.each(["corrected", "persistent"])(
    "keeps plugin-owned catalog bodies outside Stage 1 across bounded repair: %s",
    async (mode) => {
      const description = "Complete registered routing description. ".repeat(
        40,
      );
      const providerText =
        "Plugin-owned catalog reference content, not the framework routing catalog.";
      const runtime = makeRuntime([
        stage1Response({
          contexts: ["simple"],
          contextRequests: ["CONTEXT_CATALOG"],
          facts: ["UNVERIFIED_PLUGIN_CATALOG_FACT"],
        }),
        stage1Response({
          contexts: ["simple"],
          contextRequests: mode === "persistent" ? ["CONTEXT_CATALOG"] : [],
          replyText:
            mode === "persistent" ? "" : "The plugin reference is unavailable.",
        }),
      ]);
      const dispatch = vi.spyOn(
        runtime.responseHandlerFieldRegistry,
        "dispatch",
      );
      const providerRead = vi.fn(async () => ({ text: providerText }));
      runtime.contexts = new ContextRegistry([
        { id: "custom_catalog", description },
      ]);
      runtime.providers = [
        { name: "CONTEXT_CATALOG", cacheStable: true, get: providerRead },
      ];
      const state = makeState();
      state.data.providers = {
        CONTEXT_CATALOG: {
          text: providerText,
          discoveryText: "context_discovery: CONTEXT_CATALOG",
        },
      };
      runtime.composeState = vi.fn(async () => structuredClone(state));
      const run = runStage1({
        runtime,
        message: makeMessage({ channelType: ChannelType.DM }),
        state,
        responseId: "00000000-0000-0000-0000-000000000005" as UUID,
      });
      if (mode === "persistent") {
        await expect(run).rejects.toMatchObject({
          code: "CONTEXT_DISCOVERY_INVALID_REQUEST",
        });
        expect(dispatch).not.toHaveBeenCalled();
      } else {
        const result = await run;
        expect(result.kind).toBe("direct_reply");
        if (result.kind === "direct_reply")
          expect(result.result.responseContent?.text).toBe(
            "The plugin reference is unavailable.",
          );
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0][0].rawParsed.facts).toEqual([]);
      }
      expect(useModelCalls(runtime)).toHaveLength(2);
      expect(JSON.stringify(useModelCalls(runtime))).not.toContain(
        providerText,
      );
      expect(JSON.stringify(useModelCalls(runtime)[1][1])).toContain(
        "context_read_repair",
      );
      expect(runtime.composeState).not.toHaveBeenCalled();
      expect(providerRead).not.toHaveBeenCalled();
    },
  );

  it("a usable Stage 1 reply makes exactly ONE model call (no TEXT_SMALL regen)", async () => {
    // The HANDLE_RESPONSE envelope already carries replyText, so the
    // double-generation consolidation must NOT fire a second direct-reply
    // model call. The queue holds a single response; a second useModel would
    // throw "Unexpected useModel call", but assert the count explicitly so a
    // regression that re-adds the regen is caught directly.
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "The answer is four.",
      }),
    ]);

    const result = await runStage1({
      runtime,
      message: makeMessage({ text: "What is 2+2?" }),
    });

    expect(result.kind).toBe("direct_reply");
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(useModelCalls(runtime)[0][0]).toBe(ModelType.RESPONSE_HANDLER);
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe("The answer is four.");
    }
  });

  it.each([
    "Checking a quote from yesterday would not establish BTC's price now. I need a current source to verify it.",
    "I'll be honest — I can't verify a current BTC price without a current source.",
    "I'll need a current market source before I can verify the price.",
    "I'll need the currency for that quote — which one do you want?",
    "I'll look up BTC if you want.",
    "I'll look up BTC’s current price now?",
    '"I will look up BTC" is an example of a future-tense promise.',
  ])(
    "preserves a complete model-authored current-info limitation on the direct path: %s",
    async (answer) => {
      const runtime = makeRuntime([
        stage1Response({ contexts: ["simple"], replyText: answer }),
      ]);
      const message = makeMessage();
      message.content.text = "what is btc at rn?";

      const result = await runStage1({
        runtime,
        message,
      });

      expect(result.kind).toBe("direct_reply");
      if (result.kind === "direct_reply") {
        expect(result.result.responseContent?.text).toBe(answer);
      }
      expect(useModelCalls(runtime).map(([model]) => model)).toEqual([
        ModelType.RESPONSE_HANDLER,
      ]);
    },
  );

  it.each([
    "That lookup is unavailable here; I cannot verify a current quote.",
    "The attempt failed; there is no result to report.",
    "The request was cancelled, so no lookup will run.",
    "That request was declined; no work remains in progress.",
  ])(
    "keeps a terminal non-applied outcome direct despite an unserved declared intent: %s",
    async (answer) => {
      const runtime = makeRuntime([
        stage1Response({
          contexts: ["simple"],
          intents: ["verify current quote"],
          replyText: answer,
          extra: { replyEffectStatus: "non_applied" },
        }),
      ]);
      const result = await runStage1({
        runtime,
        message: makeMessage({ text: "what is btc at rn?" }),
      });
      expect(result.kind).toBe("direct_reply");
      expect(useModelCalls(runtime)).toHaveLength(1);
      if (result.kind === "direct_reply")
        expect(result.result.responseContent?.text).toBe(answer);
    },
  );

  it.each(["STOP", "IGNORE"] as const)(
    "keeps %s terminal even when the model marks work pending",
    async (shouldRespond) => {
      const runtime = makeRuntime([
        stage1Response({
          shouldRespond,
          contexts: [],
          replyText: "The next stage remains pending.",
          extra: { replyEffectStatus: "pending" },
        }),
      ]);
      const result = await runStage1({
        runtime,
        // See the STOP lexicon: a terminal STOP needs a stop-shaped message.
        message: makeMessage(
          shouldRespond === "STOP" ? { text: "please stop, be quiet" } : {},
        ),
      });
      expect(result.kind).toBe("terminal");
      if (result.kind === "terminal") expect(result.action).toBe(shouldRespond);
      expect(useModelCalls(runtime)).toHaveLength(1);
    },
  );

  it.each(["json", "transcript", "legacy"])(
    "plans a typed pending reply from the %s envelope",
    async (format) => {
      const promise = "La próxima etapa todavía está pendiente.";
      const flat = {
        shouldRespond: "RESPOND",
        contexts: [],
        candidateActionNames: [],
        replyText: promise,
        replyEffectStatus: "pending",
      };
      const raw =
        format === "transcript"
          ? `shouldRespond: RESPOND\ncontexts:\nreplyText: ${promise}\nreplyEffectStatus: pending`
          : JSON.stringify(
              format === "legacy"
                ? {
                    processMessage: "RESPOND",
                    plan: {
                      contexts: [],
                      reply: promise,
                      replyEffectStatus: "pending",
                    },
                  }
                : flat,
            );
      const answer =
        "I cannot complete that request with the available capabilities.";
      const runtime = makeRuntime([
        raw,
        {
          text: "",
          toolCalls: [
            {
              id: "pending-terminal",
              name: "REPLY",
              arguments: { text: answer },
            },
          ],
        },
      ]);
      const result = await runStage1({
        runtime,
        message: makeMessage({ text: "Continue with my request." }),
      });
      expect(result.kind).toBe("planned_reply");
      expect(result.messageHandler.plan.replyEffectStatus).toBe("pending");
      expect(useModelCalls(runtime).map(([model]) => model)).toEqual([
        ModelType.RESPONSE_HANDLER,
        ModelType.ACTION_PLANNER,
      ]);
      const plannerInput = useModelCalls(runtime)[1]?.[1] as {
        messages: Array<{ content: string }>;
      };
      expect(
        plannerInput.messages.some((entry) =>
          entry.content.includes(JSON.stringify(promise)),
        ),
      ).toBe(true);
      if (result.kind === "planned_reply")
        expect(result.result.responseContent?.text).toBe(answer);
    },
  );

  it("keeps a completed fictional-facts answer direct despite incidental coding words", async () => {
    const reply =
      "Noted. Mira = PINE-17, Jonah = COVE-42, both fictional. No notes touched.";
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: reply,
        extra: { replyEffectStatus: "none" },
      }),
    ]);
    const taskHandler = vi.fn(async () => ({
      success: true,
      text: "delegated",
    }));
    runtime.actions = [
      {
        name: "TASKS",
        tags: ["domain:coding", "resource:agent-task", "capability:delegate"],
        description: "Delegate coding work.",
        parameters: [],
        examples: [],
        validate: async () => true,
        handler: taskHandler,
      },
    ] as never;
    const message = makeMessage();
    message.content = {
      ...message.content,
      text: "Fictional test facts: Mira's project code is PINE-17. Jonah's project code is COVE-42. These are fictional characters, not me. No note is requested.",
      mentionContext: { isMention: true },
    };
    const result = await runV5MessageRuntimeStage1({
      runtime,
      message,
      state: makeState(),
      responseId: "00000000-0000-0000-0000-000000000005" as UUID,
    });
    expect(result.kind).toBe("direct_reply");
    expect(taskHandler).not.toHaveBeenCalled();
    expect(useModelCalls(runtime)).toHaveLength(1);
    if (result.kind === "direct_reply")
      expect(result.result.responseContent?.text).toBe(reply);
  });

  it("answers a trivial math turn directly despite a views capability-token overlap (tj-501e594bfb23a7)", async () => {
    // Full Stage-1 pipeline fence for the VIEWS hijack: Stage 1 answers
    // "whats 17 times 23?" with contexts=["simple"] / replyText="391" /
    // candidateActionNames=[]. The registered views action's "screen-time"
    // tag overlaps the TIME token ("times"), which previously injected a
    // VIEWS candidate AFTER Stage 1 (both in messageHandlerFromFieldResult
    // and via the core.simple_registered_action_request evaluator), forced
    // the planner into toolChoice=required, exhausted required_tool_misses
    // rejecting the correct terminal answer, and shipped the generic
    // apology. The answered-simple shape must stay a one-call direct reply.
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "391",
      }),
    ]);
    const viewsHandler = vi.fn(async () => ({
      success: true,
      text: "opened",
      data: { actionName: "VIEWS" },
    }));
    runtime.actions = [
      {
        name: "VIEWS",
        similes: ["VIEW", "SHOW_VIEW", "OPEN_VIEW", "OPEN_SETTINGS"],
        tags: [
          "views",
          "ui",
          "panel",
          "view-capability",
          "screen-time",
          "settings",
        ],
        description: "Manage and navigate UI views.",
        parameters: [
          {
            name: "action",
            description: "Operation",
            required: true,
            schema: { type: "string" },
          },
        ],
        examples: [],
        validate: async () => true,
        handler: viewsHandler,
      },
    ] as never;
    const message = makeMessage();
    message.content = {
      ...message.content,
      text: "whats 17 times 23?",
      mentionContext: { isMention: true },
    };

    const result = await runStage1({
      runtime,
      message,
    });

    expect(result.kind).toBe("direct_reply");
    expect(viewsHandler).not.toHaveBeenCalled();
    // One HANDLE_RESPONSE call only — no planner round, no forced tool.
    expect(useModelCalls(runtime)).toHaveLength(1);
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe("391");
    }
  });

  it("stamps an exact internal VIEWS diagnostic before simple delivery", async () => {
    const inventory = ["available_views:", "  type: gui", "  count: 0"].join(
      "\n",
    );
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["general"],
        candidateActionNames: ["VIEWS"],
        extra: { requiresTool: true },
      }),
      {
        thought: "Inspect available views.",
        toolCalls: [
          {
            id: "views-list-1",
            name: "VIEWS",
            arguments: { action: "list" },
          },
        ],
      },
      JSON.stringify({
        success: true,
        decision: "FINISH",
        thought: "Return the tool result.",
        messageToUser: inventory,
      }),
    ]);
    runtime.actions = [
      {
        name: "VIEWS",
        description: "List available views.",
        parameters: [
          {
            name: "action",
            description: "View operation",
            required: true,
            schema: { type: "string", enum: ["list"] },
          },
        ],
        examples: [],
        validate: async () => true,
        handler: async () => ({
          success: true,
          text: inventory,
          transcriptVisibility: "internal",
          data: { views: [] },
        }),
      },
    ] as never;

    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "what apps are available?",
        mentionContext: { isMention: true },
      }),
    });

    expect(result.kind).toBe("planned_reply");
    if (result.kind !== "planned_reply") return;
    expect(result.result.responseContent?.transcriptVisibility).toBe(
      "internal",
    );
    expect(result.result.responseContent?.text).toContain("available_views:");
    expect(
      result.result.responseMessages[0]?.content.transcriptVisibility,
    ).toBe("internal");
  });

  it("does not force direct snippet replies when the user explicitly asks for a sub-agent", () => {
    const routed = messageHandlerFromFieldResult(
      {
        shouldRespond: "RESPOND",
        contexts: ["simple"],
        intents: ["write snippet"],
        replyText: "```python\nprint('hello world')\n```",
        candidateActionNames: [],
        facts: [],
        relationships: [],
        addressedTo: [],
      },
      undefined,
      {
        actions: [{ name: "TASKS" }],
        messageText: "spawn a sub-agent to write a Python hello-world snippet",
      },
    );

    expect(routed.plan.simple).toBe(false);
    expect(routed.plan.requiresTool).toBe(true);
    expect(routed.plan.contexts).toContain("general");
    expect(routed.plan.candidateActions).toEqual(["TASKS"]);
  });

  it("parses Stage 1 output from GenerateTextResult content parts when text is blank", async () => {
    const runtime = makeRuntime([
      {
        text: "",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              shouldRespond: "RESPOND",
              thought: "Provider returned content parts.",
              replyText: "Parsed from content.",
              contexts: ["simple"],
              candidateActions: [],
              facts: [],
              relationships: [],
              addressedTo: [],
            }),
          },
        ],
      },
    ]);

    const result = await runStage1({
      runtime,
      message: makeMessage(),
    });

    expect(result.kind).toBe("direct_reply");
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe("Parsed from content.");
    }
  });

  it("derives a span sampler plan that forces T=0/topK=1 on the shouldRespond enum (and other argmax-eligible spans)", async () => {
    const runtime = makeRuntime([
      {
        text: "",
        toolCalls: [
          {
            id: "mh-1",
            name: "HANDLE_RESPONSE",
            arguments: {
              shouldRespond: "RESPOND",
              thought: "Direct answer.",
              replyText: "Hello.",
              contexts: ["simple"],
              intents: [],
              candidateActionNames: [],
              facts: [],
              relationships: [],
              addressedTo: [],
            },
          },
        ],
        finishReason: "tool_calls",
      },
    ]);

    await runStage1({
      runtime,
      message: makeMessage(),
    });

    const firstCall = useModelCalls(runtime)[0];
    const params = firstCall?.[1] as {
      responseSkeleton?: {
        spans: Array<{ kind: string; key?: string; enumValues?: string[] }>;
      };
      spanSamplerPlan?: {
        overrides: Array<{
          spanIndex: number;
          temperature: number;
          topK?: number;
        }>;
      };
    };
    // Skeleton is present and contains the canonical shouldRespond enum.
    expect(params.responseSkeleton?.spans).toBeDefined();
    const shouldRespondSpan = params.responseSkeleton?.spans.find(
      (s) => s.key === "shouldRespond",
    );
    expect(shouldRespondSpan?.kind).toBe("enum");
    // The span-sampler plan was derived and contains an override for shouldRespond.
    expect(params.spanSamplerPlan).toBeDefined();
    expect(params.spanSamplerPlan?.overrides.length).toBeGreaterThan(0);
    const overrides = params.spanSamplerPlan?.overrides ?? [];
    const overriddenKeys = overrides.map(
      (o) => params.responseSkeleton?.spans[o.spanIndex].key,
    );
    expect(overriddenKeys).toContain("shouldRespond");
    // Every override is T=0/topK=1 (the canonical argmax policy).
    for (const o of overrides) {
      expect(o.temperature).toBe(0);
      expect(o.topK).toBe(1);
    }
    // Free-string spans like replyText / thought are NOT in the plan —
    // the user's free prose keeps the call-level temperature.
    expect(overriddenKeys).not.toContain("replyText");
    expect(overriddenKeys).not.toContain("thought");
  });

  it("renders the restrained HARD-GATE ambient policy only when reply_gate is addressed_or_ambient", async () => {
    // The quiet-ambient bias is an opt-in now: rooms that want the agent to
    // hold back on unaddressed group chatter set reply_gate to
    // addressed_or_ambient, which restores the hard IGNORE default. The
    // participatory wording must not leak into this mode.
    const runtime = withReplyGateMode(
      makeRuntime([
        stage1Response({
          thought: "Ambient chatter under the restrained gate.",
          contexts: ["general"],
          replyText: "",
        }),
        {
          text: "",
          toolCalls: [{ id: "ignore-2", name: "IGNORE", arguments: {} }],
        },
      ]),
      "addressed_or_ambient",
    );
    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "what was it for?",
        channelType: ChannelType.GROUP,
      }),
      responseId: "00000000-0000-0000-0000-000000000019" as UUID,
    });

    const calls = useModelCalls(runtime);
    const stage1Params = calls[0]?.[1] as {
      messages?: Array<{ content?: string | null }>;
    };
    const stage1Content = (stage1Params.messages ?? [])
      .map((entry) => entry.content ?? "")
      .join("\n");
    expect(stage1Content).toContain("ambient_turn_policy: HARD GATE");
    expect(stage1Content).toContain("Default shouldRespond=IGNORE");
    expect(stage1Content).not.toContain("need no @-mention to reply");
    expect(result.kind).toBe("terminal");
    if (result.kind === "terminal") {
      expect(result.action).toBe("IGNORE");
    }
  });

  it("recognizes a bounded continuation from the participant who corrected the agent", () => {
    const runtime = makeRuntime([]);
    const correctingEntityId = "00000000-0000-0000-0000-000000000002" as UUID;
    const otherEntityId = "00000000-0000-0000-0000-000000000005" as UUID;
    const recentMessages: Memory[] = [
      {
        ...makeMessage({ text: "You should send a follow-up email." }),
        id: "00000000-0000-0000-0000-000000000010" as UUID,
        entityId: runtime.agentId,
      },
      {
        ...makeMessage({
          text: "Please don't fix it. In this chat we listen unless someone asks for ideas.",
        }),
        id: "00000000-0000-0000-0000-000000000011" as UUID,
        entityId: correctingEntityId,
      },
      {
        ...makeMessage({ text: "yeah, no homework assignment right now" }),
        id: "00000000-0000-0000-0000-000000000012" as UUID,
        entityId: otherEntityId,
      },
    ];
    const state: State = {
      ...makeState(),
      data: { providers: { RECENT_MESSAGES: { data: { recentMessages } } } },
    };
    const continuation = makeMessage({
      text: "and now I remembered I blanked on the easiest question",
      channelType: ChannelType.GROUP,
    });

    expect(
      messageContinuesAfterRecentAgentCorrection(runtime, continuation, state),
    ).toBe(true);
    expect(
      messageContinuesAfterRecentAgentCorrection(
        runtime,
        { ...continuation, entityId: otherEntityId },
        state,
      ),
    ).toBe(false);
  });

  it("does not treat incidental or third-party correction language as agent repair", () => {
    const runtime = makeRuntime([]);
    const speakerId = "00000000-0000-0000-0000-000000000002" as UUID;
    const agentMessage = {
      ...makeMessage({ text: "Here is my thought." }),
      id: "00000000-0000-0000-0000-000000000010" as UUID,
      entityId: runtime.agentId,
    };
    const continuation = {
      ...makeMessage({
        text: "and now I remembered another part",
        channelType: ChannelType.GROUP,
      }),
      entityId: speakerId,
    };
    for (const text of [
      "The bus stop is nearby.",
      "That quote is too much for us.",
      "Please do not deploy that.",
      "Bob, stop explaining it to me.",
    ]) {
      const correction = {
        ...makeMessage({ text }),
        id: "00000000-0000-0000-0000-000000000011" as UUID,
        entityId: speakerId,
      };
      const state: State = {
        ...makeState(),
        data: {
          providers: {
            RECENT_MESSAGES: {
              data: { recentMessages: [agentMessage, correction] },
            },
          },
        },
      };
      expect(
        messageContinuesAfterRecentAgentCorrection(
          runtime,
          continuation,
          state,
        ),
      ).toBe(false);
    }
  });

  it("fails closed when the current continuation has no stable message id", () => {
    const runtime = makeRuntime([]);
    const speakerId = "00000000-0000-0000-0000-000000000002" as UUID;
    const state: State = {
      ...makeState(),
      data: {
        providers: {
          RECENT_MESSAGES: {
            data: {
              recentMessages: [
                {
                  ...makeMessage({ text: "You should follow up." }),
                  id: "00000000-0000-0000-0000-000000000010" as UUID,
                  entityId: runtime.agentId,
                },
                {
                  ...makeMessage({ text: "Please don't fix it." }),
                  id: "00000000-0000-0000-0000-000000000011" as UUID,
                  entityId: speakerId,
                },
              ],
            },
          },
        },
      },
    };
    const continuation = {
      ...makeMessage({
        text: "and now I remembered another part",
        channelType: ChannelType.GROUP,
      }),
      id: undefined,
      entityId: speakerId,
    };

    expect(
      messageContinuesAfterRecentAgentCorrection(runtime, continuation, state),
    ).toBe(false);
  });

  it("expires repair permission after the correcting participant's first continuation", () => {
    const runtime = makeRuntime([]);
    const speakerId = "00000000-0000-0000-0000-000000000002" as UUID;
    const recentMessages: Memory[] = [
      {
        ...makeMessage({ text: "You should send a follow-up email." }),
        id: "00000000-0000-0000-0000-000000000010" as UUID,
        entityId: runtime.agentId,
      },
      {
        ...makeMessage({ text: "Please don't fix it." }),
        id: "00000000-0000-0000-0000-000000000011" as UUID,
        entityId: speakerId,
      },
      {
        ...makeMessage({ text: "and now I remembered another part" }),
        id: "00000000-0000-0000-0000-000000000012" as UUID,
        entityId: speakerId,
      },
    ];
    const state: State = {
      ...makeState(),
      data: { providers: { RECENT_MESSAGES: { data: { recentMessages } } } },
    };

    expect(
      messageContinuesAfterRecentAgentCorrection(
        runtime,
        {
          ...makeMessage({
            text: "also, lunch at noon?",
            channelType: ChannelType.GROUP,
          }),
          entityId: speakerId,
        },
        state,
      ),
    ).toBe(false);
  });

  it("expires a sparse-room repair exchange after fifteen minutes", () => {
    const runtime = makeRuntime([]);
    const speakerId = "00000000-0000-0000-0000-000000000002" as UUID;
    const correction = {
      ...makeMessage({ text: "Please don't fix it." }),
      id: "00000000-0000-0000-0000-000000000011" as UUID,
      entityId: speakerId,
      createdAt: 1_000,
    };
    const state: State = {
      ...makeState(),
      data: {
        providers: {
          RECENT_MESSAGES: {
            data: {
              recentMessages: [
                {
                  ...makeMessage({ text: "You should follow up." }),
                  id: "00000000-0000-0000-0000-000000000010" as UUID,
                  entityId: runtime.agentId,
                },
                correction,
              ],
            },
          },
        },
      },
    };

    expect(
      messageContinuesAfterRecentAgentCorrection(
        runtime,
        {
          ...makeMessage({
            text: "and I remembered another part",
            channelType: ChannelType.GROUP,
          }),
          entityId: speakerId,
          createdAt: 15 * 60_000 + 1_001,
        },
        state,
      ),
    ).toBe(false);
  });

  it("keeps truthful no-answer delivery on reply_gate 'always' and trigger-prompt bypass turns", async () => {
    // #25279 regressed exactly these two classes and #25341 repaired them by
    // restoring reply_gate "always" and the configured/canonical bypasses.
    // Both turns are unaddressed group traffic, so only the bypass keeps them
    // off the ambient path. They still owe a response, but rejected planner text
    // must resolve through the neutral toolless recovery contract.
    const cases = [
      {
        label: "reply_gate always",
        withGate: (runtime: IAgentRuntime) =>
          withReplyGateSlots(runtime, "always", "addressed_or_ambient"),
        content: { channelType: ChannelType.GROUP } as Partial<
          Memory["content"]
        >,
      },
      {
        label: "trigger-prompt automation",
        withGate: (runtime: IAgentRuntime) => runtime,
        content: {
          channelType: ChannelType.GROUP,
          source: "trigger-prompt",
        } as Partial<Memory["content"]>,
      },
    ];

    for (const testCase of cases) {
      const runtime = testCase.withGate(
        makeRuntime([
          stage1Response({
            thought: "Bypassed turn; the planner still runs.",
            contexts: ["general"],
            replyText: "",
          }),
          plannerReplyRejectedByEgress(),
          JSON.stringify({
            response: "I need more context to answer that question.",
          }),
          acceptedRecoveryReview(
            "The candidate acknowledges missing information without asserting an effect.",
          ),
        ]),
      );
      const result = await runStage1({
        runtime,
        message: makeMessage({
          text: "what was it for?",
          ...testCase.content,
        }),
        responseId: "00000000-0000-0000-0000-00000000f004" as UUID,
      });

      expect(result.kind, testCase.label).toBe("planned_reply");
      if (result.kind === "planned_reply") {
        expect(result.result.responseContent?.text, testCase.label).toBe(
          "I need more context to answer that question.",
        );
      }
    }
  });

  it("includes the agent's own prior replies with speaker attribution", async () => {
    // The current_turn_boundary contract tells the model the prior_message
    // blocks are its ONLY chat-recall window, but the agent's own replies
    // were structurally excluded from that window — so when asked "did you
    // tell me X?" the model had nothing to ground on and confabulated
    // ("I told you X" when it never did, or denying things it did say).
    // The agent's own turns must be visible, clearly role-tagged, while
    // non-dialogue agent artifacts (sub-agent transcripts) stay excluded.
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "Yes — I told you BTC was around $63,000.",
        extra: { requiresTool: false },
      }),
    ]);
    const state: State = {
      values: {
        availableContexts: "simple, general",
      },
      data: {
        providers: {
          RECENT_MESSAGES: {
            text: "# Conversation Messages\nprovider text should not render",
            data: {
              recentMessages: [
                {
                  id: "00000000-0000-0000-0000-00000000cc01" as UUID,
                  entityId: "00000000-0000-0000-0000-00000000cc11" as UUID,
                  agentId: runtime.agentId,
                  roomId: "00000000-0000-0000-0000-000000001111" as UUID,
                  createdAt: 1,
                  content: { text: "whats the btc price", source: "discord" },
                  metadata: {
                    type: "message",
                    sender: { id: "discord-1gig", name: "1gig" },
                  },
                },
                {
                  id: "00000000-0000-0000-0000-00000000cc02" as UUID,
                  entityId: runtime.agentId,
                  agentId: runtime.agentId,
                  roomId: "00000000-0000-0000-0000-000000001111" as UUID,
                  createdAt: 2,
                  content: {
                    text: "BTC is around $63,000 right now.",
                    source: "discord",
                  },
                },
                {
                  id: "00000000-0000-0000-0000-00000000cc03" as UUID,
                  entityId: runtime.agentId,
                  agentId: runtime.agentId,
                  roomId: "00000000-0000-0000-0000-000000001111" as UUID,
                  createdAt: 3,
                  content: {
                    text: "[sub-agent: price check (opencode) — task_complete]\nraw transcript",
                    source: "acpx:sub-agent-router",
                    metadata: { subAgent: true },
                  },
                },
              ],
            },
            providerName: "RECENT_MESSAGES",
          },
        },
      },
      text: "fallback text should not be needed",
    };

    await runStage1({
      runtime,
      message: makeMessage({
        text: "did you tell me the btc price earlier?",
      }),
      state,
    });

    const firstCall = useModelCalls(runtime)[0];
    const params = firstCall?.[1] as {
      messages?: Array<{ role?: string; content?: string | null }>;
    };
    const userContent = params.messages?.[1]?.content ?? "";
    // The user's turn keeps the user tag; the agent's own reply is present
    // and role-tagged with the character name so recall is grounded.
    expect(userContent).toContain("1gig: whats the btc price");
    expect(userContent).toContain(
      "Test Agent: BTC is around $63,000 right now.",
    );
    // Chronological interleave: the agent reply follows the user turn.
    expect(userContent.indexOf("1gig: whats the btc price")).toBeLessThan(
      userContent.indexOf("Test Agent: BTC is around"),
    );
    // Non-dialogue agent artifacts stay out of the window.
    expect(userContent).not.toContain("[sub-agent: price check");
    expect(userContent).not.toContain("raw transcript");
    // The contract now grounds own-reply recall on the prior_message:agent blocks.
  });

  it.each([
    'Done. The note now says "Bring the green notebook."',
    "Checking.\u0000",
  ])(
    "withholds invalid or prematurely completed progress without another inference: %j",
    async (replyText) => {
      const runtime = makeRuntime([
        stage1Response({
          contexts: ["general"],
          replyText,
          extra: { requiresTool: true, replyEffectStatus: "pending" },
        }),
        JSON.stringify({
          thought: "Finished the check.",
          toolCalls: [],
          messageToUser: "I checked the request.",
        }),
      ]);
      const onPlanningAcknowledgment = vi.fn();
      const earlyReply = vi.fn();
      const result = await runV5MessageRuntimeStage1({
        runtime,
        message: makeMessage(),
        state: makeState(),
        responseId: "00000000-0000-0000-0000-000000000005" as UUID,
        onPlanningAcknowledgment,
        onResponseHandlerEarlyReply: earlyReply,
      });
      expect(onPlanningAcknowledgment).not.toHaveBeenCalled();
      expect(earlyReply).not.toHaveBeenCalled();
      expect(runtime.useModel).toHaveBeenCalledTimes(2);
      expect(result.kind).toBe("planned_reply");
      if (result.kind === "planned_reply") {
        expect(result.result.responseContent?.text).toBe(
          "I checked the request.",
        );
      }
    },
  );

  it.each([
    { text: "Hi!", replyEffectStatus: "none" },
    {
      text: "What time should I schedule it?",
      replyEffectStatus: "non_applied",
    },
  ])(
    "does not acknowledge a direct reply: $text",
    async ({ text, replyEffectStatus }) => {
      const runtime = makeRuntime([
        stage1Response({
          contexts: ["simple"],
          replyText: text,
          extra: { replyEffectStatus },
        }),
      ]);
      const onPlanningAcknowledgment = vi.fn();
      const result = await runV5MessageRuntimeStage1({
        runtime,
        message: makeMessage(),
        state: makeState(),
        responseId: "00000000-0000-0000-0000-000000000005" as UUID,
        onPlanningAcknowledgment,
      });
      expect(result.kind).toBe("direct_reply");
      expect(onPlanningAcknowledgment).not.toHaveBeenCalled();
      expect(runtime.useModel).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps strict grounding on a shape-only task_complete relay", async () => {
    // Relay shape (header + subAgent metadata) is routing, not proof: a
    // child can claim task_complete without having applied anything, so an
    // unbound relay's "applied" claim buffers exactly like any other
    // ungrounded claim (#24425 review: task-complete metadata is not proof
    // that an effect occurred).
    const runtime = makeRuntime([
      stage1Response({
        thought: "Relay the claimed build to the user.",
        contexts: ["simple"],
        replyText: "The dice roller app is built and deployed.",
        extra: { requiresTool: true, replyEffectStatus: "applied" },
      }),
      JSON.stringify({
        thought: "No receipt proved the claimed build.",
        toolCalls: [],
        messageToUser: "I couldn't verify that build completed.",
      }),
    ]);
    const earlyReply = vi.fn(async () => undefined);

    const result = await runStage1({
      runtime,
      message: makeMessage({
        text:
          "[sub-agent: dice roller build (opencode) — task_complete]\n" +
          "Done. The dice roller app is built and deployed.",
        source: "sub_agent",
        metadata: { subAgent: true },
      }),
      onResponseHandlerEarlyReply: earlyReply,
    });

    expect(earlyReply).not.toHaveBeenCalled();
    expect(result.kind).toBe("planned_reply");
    if (result.kind === "planned_reply") {
      expect(result.result.responseContent?.text).toBe(
        "I couldn't verify that build completed.",
      );
    }
  });

  it("carries evaluator-selected proof through the complete planned reply without rewriting or replaying", async () => {
    const reply = "I've created Picnic with your reminder to bring a charger.";
    const observedAt = "2026-09-05T12:00:00.000Z";
    const runtime = makeRuntime([
      stage1Response({
        thought: "Save the requested picnic note.",
        contexts: ["notes"],
        intents: ["Create the picnic note to bring a charger."],
        candidateActionNames: ["NOTES"],
        replyText: "",
        extra: { requiresTool: true },
      }),
      {
        text: "",
        toolCalls: [
          {
            id: "note-create",
            name: "NOTES",
            arguments: { eliza_turn_scope: "final" },
          },
        ],
      },
      JSON.stringify({
        thought: "The note receipt proves the requested write.",
        success: true,
        decision: "FINISH",
        messageToUser: reply,
        effectReceiptIds: ["note-proof"],
      }),
    ]);
    const handler = vi.fn(async () => ({
      success: true,
      modelReplyRequired: true,
      data: { note: { title: "Picnic", body: "bring a charger" } },
      effectReceipts: [
        {
          receiptId: "note-proof",
          operation: "notes.create",
          outcome: "applied" as const,
          resource: { kind: "note", id: "picnic" },
          artifacts: [],
          idempotency: { key: "picnic-request", replayed: false },
          observedAt,
          commit: {
            kind: "durable" as const,
            id: "note-write",
            committedAt: observedAt,
          },
        },
      ],
    }));
    runtime.actions = [
      {
        name: "NOTES",
        description: "Create the picnic note.",
        contexts: ["notes"],
        tags: ["capability:write"],
        validate: async () => true,
        handler,
      },
    ];
    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "Create a picnic note to bring a charger.",
      }),
    });
    expect(result.kind).toBe("planned_reply");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(useModelCalls(runtime)).toHaveLength(3);
    if (result.kind !== "planned_reply")
      throw new Error("Expected a planned reply");
    const response = result.result.responseContent;
    if (!response) throw new Error("Expected a delivered response");
    expect(response.text).toBe(reply);
    expect(response.agentVoiced).toBe(true);
    expect(response.effectReceiptIds).toEqual(["note-proof"]);
    expect(effectDeliveryBindingProvesApplication(response)).toBe(true);
  });

  it("does not let a rejected early completion claim hide the later receipt-grounded confirmation", async () => {
    const canonicalText = "Done — the pickup reminder is scheduled.";
    const observedAt = "2026-07-27T18:00:00.000Z";
    const runtime = makeRuntime([
      stage1Response({
        thought: "The reminder still needs to be persisted.",
        contexts: ["tasks"],
        candidateActionNames: ["CREATE_REMINDER"],
        replyText: canonicalText,
        extra: { requiresTool: true },
      }),
      {
        thought: "Persist the reminder.",
        toolCalls: [
          {
            id: "reminder-1",
            name: "CREATE_REMINDER",
            arguments: {},
          },
        ],
      },
    ]);
    runtime.actions = [
      {
        name: "CREATE_REMINDER",
        description: "Persist a reminder.",
        tags: ["capability:write", "capability:schedule"],
        contexts: ["tasks"],
        suppressPostActionContinuation: true,
        validate: async () => true,
        handler: async () => ({
          success: true,
          text: canonicalText,
          userFacingText: canonicalText,
          verifiedUserFacing: true,
          turnComplete: true,
          effectReceipts: [
            {
              receiptId: "receipt-reminder-1",
              operation: "lifeops.reminder.create",
              resource: {
                kind: "lifeops.reminder",
                id: "pickup-reminder",
              },
              artifacts: [],
              idempotency: {
                key: "pickup-reminder-request",
                replayed: false,
              },
              observedAt,
              outcome: "applied",
              commit: {
                kind: "durable",
                id: "transaction-reminder-1",
                committedAt: observedAt,
              },
            },
          ],
          userFacingEffectReceiptIds: ["receipt-reminder-1"],
        }),
      },
    ] as IAgentRuntime["actions"];
    const earlyReply = vi.fn(async () => undefined);
    const onSettledActionResult = vi.fn();

    const result = await runStage1({
      runtime,
      message: makeMessage({ text: "Please remind me about pickup." }),
      onResponseHandlerEarlyReply: earlyReply,
      onSettledActionResult,
    });

    // The ungrounded completion claim is DROPPED at early egress — never
    // substituted with a manufactured "On it." — so no early reply ships and
    // the receipt-grounded confirmation below is the turn's only delivery.
    expect(earlyReply).not.toHaveBeenCalled();
    expect(result.kind).toBe("planned_reply");
    expect(onSettledActionResult).toHaveBeenCalledTimes(1);
    expect(onSettledActionResult).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        effectReceipts: [
          expect.objectContaining({ receiptId: "receipt-reminder-1" }),
        ],
      }),
    );
    if (result.kind === "planned_reply") {
      expect(result.result.responseContent?.text).toBe(canonicalText);
      expect(result.result.responseContent?.effectReceiptIds).toEqual([
        "receipt-reminder-1",
      ]);
    }
  });

  it("reads the voice turn signal from content.metadata (chat-client nested shape)", async () => {
    // Web/mobile clients persist their request `metadata` object at
    // content.metadata (see agent/api buildUserMessages), so an ambient
    // turn's voiceTurnSignal lands at content.metadata.voiceTurnSignal — not
    // the top-level field the in-process voice path uses. The gate must read
    // both.
    const runtime = makeRuntime([
      stage1Response({
        thought: "The model would otherwise answer.",
        contexts: ["general"],
        replyText: "I'll jump in.",
      }),
    ]);
    const earlyReply = vi.fn(async () => undefined);
    const result = await runStage1({
      runtime,
      message: {
        ...makeMessage(),
        content: {
          ...makeMessage().content,
          channelType: ChannelType.VOICE_DM,
          metadata: {
            voiceSource: "talkmode",
            voiceTurnSignal: {
              endOfTurnProbability: 0.08,
              nextSpeaker: "user",
              agentShouldSpeak: false,
              source: "client-ambient",
            },
          },
        },
      },
      onResponseHandlerEarlyReply: earlyReply,
    });

    expect(result.kind).toBe("terminal");
    if (result.kind === "terminal") {
      expect(result.action).toBe("IGNORE");
    }
    expect(earlyReply).not.toHaveBeenCalled();
  });

  it("preserves the parsed response-handler reply for early delivery even when a repair clears plan.reply", async () => {
    const runtime = makeRuntime([
      stage1Response({
        thought: "Acknowledge first.",
        contexts: ["simple"],
        replyText: "I'll start on that.",
      }),
      JSON.stringify({
        thought: "Planner should not repeat the acknowledgement.",
        toolCalls: [],
        messageToUser: "I found the extra detail.",
      }),
    ]);
    runtime.responseHandlerEvaluators = [
      {
        name: "test.clear_reply_but_plan",
        priority: 5,
        shouldRun: () => true,
        evaluate: () => ({
          requiresTool: true,
          clearReply: true,
          addContexts: ["general"],
        }),
      } satisfies ResponseHandlerEvaluator,
    ];
    const earlyReply = vi.fn(async () => undefined);

    await runStage1({
      runtime,
      message: makeMessage(),
      onResponseHandlerEarlyReply: earlyReply,
    });

    expect(earlyReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "I'll start on that.",
      }),
    );
    const plannerCalls = vi
      .mocked(runtime.useModel)
      .mock.calls.filter(([type]) => type === ModelType.ACTION_PLANNER);
    expect(plannerCalls).toHaveLength(1);
    expect(JSON.stringify(plannerCalls[0][1])).not.toContain(
      "undeliveredDraft",
    );
  });

  it.each(["IGNORE", "STOP"] as const)(
    "stops immediately for %s",
    async (action) => {
      const runtime = makeRuntime([
        stage1Response({
          shouldRespond: action,
          thought: "Terminal decision.",
        }),
      ]);

      const result = await runStage1({
        runtime,
        // Explicit disengagement retains immediate terminal behavior.
        message: makeMessage(
          action === "STOP" ? { text: "ok stop, leave me alone" } : {},
        ),
      });

      expect(result).toMatchObject({
        kind: "terminal",
        action,
      });
      expect(runtime.useModel).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps arithmetic word questions on the simple direct-reply path", async () => {
    // Regression for the false-positive routing where "what is 17 times 23?"
    // was hijacked into the planner by a regex-list-based identity-lookup
    // evaluator that classified any "what is" + digit-bearing subject as a
    // chat-local entity lookup. The structural contract is now in the
    // Stage 1 prompt template alone: Stage 1 decides routing from intent,
    // not a post-hoc pattern guard. Trivial arithmetic must stay on the
    // simple shortcut without spawning a planner stage.
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "17 times 23 is 391.",
        extra: { requiresTool: false },
      }),
    ]);

    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "remilio nubilio (@1490833425802854491) what is 17 times 23?",
        source: "discord",
      }),
      state: {
        values: { availableContexts: "simple, general, memory, messaging" },
        data: {},
        text: "",
      },
    });

    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe("17 times 23 is 391.");
    }
    // Only Stage 1 should have run — no planner reroute, no extra model calls.
    expect(useModelCalls(runtime)).toHaveLength(1);
  });

  it("does not execute browser or automation fallbacks when explicit Computer Use is unavailable", async () => {
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["browser", "automation"],
        intents: ["open telegram using computer use"],
        candidateActionNames: ["BROWSER_NAVIGATE", "AUTOMATION_TRIGGER"],
        replyText: "On it.",
        extra: { requiresTool: true },
      }),
    ]);
    const browserHandler = vi.fn(async () => ({
      success: true,
      text: "Browser fallback ran.",
    }));
    const automationHandler = vi.fn(async () => ({
      success: true,
      text: "Automation fallback ran.",
    }));
    runtime.actions = [
      {
        name: "BROWSER_NAVIGATE",
        description: "Navigate a browser.",
        contexts: ["browser"],
        validate: async () => true,
        handler: browserHandler,
      },
      {
        name: "AUTOMATION_TRIGGER",
        description: "Run an automation.",
        contexts: ["automation"],
        validate: async () => true,
        handler: automationHandler,
      },
    ] as never;
    registerDirectActionRoutingRule(runtime, {
      id: "test.computer-use.explicit-host-control",
      actionNames: ["COMPUTER_USE"],
      replacesActionNames: ["BROWSER_NAVIGATE", "AUTOMATION_TRIGGER"],
      requiredActionTags: [
        "domain:computer-use",
        "capability:desktop-control",
        "effect:host-action",
      ],
      contexts: ["automation", "admin"],
      unavailable: {
        code: "COMPUTER_USE_UNAVAILABLE",
        reply:
          "Computer Use is unavailable in this app session. Enable Computer Use, restart the app session, and try again. (COMPUTER_USE_UNAVAILABLE)",
      },
      matches: (text) => /\bcomputer[\s_-]*use\s+to\b/iu.test(text),
    });
    const directRouteEvaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
      (evaluator) =>
        evaluator.name === "core.direct_registered_capability_request",
    );
    if (!directRouteEvaluator)
      throw new Error("direct route evaluator missing");
    runtime.responseHandlerEvaluators = [directRouteEvaluator];

    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "can u use computer use to open telegram",
      }),
      state: {
        ...makeState(),
        values: {
          availableContexts: "general, browser, automation, admin",
        },
      },
    });

    expect(result.kind).toBe("direct_reply");
    expect(result.messageHandler.plan.requiresTool).toBe(false);
    expect(result.messageHandler.plan.candidateActions).toBeUndefined();
    expect(browserHandler).not.toHaveBeenCalled();
    expect(automationHandler).not.toHaveBeenCalled();
    expect(useModelCalls(runtime).map((call) => call[0])).toEqual([
      ModelType.RESPONSE_HANDLER,
    ]);
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe(
        "Computer Use is unavailable in this app session. Enable Computer Use, restart the app session, and try again. (COMPUTER_USE_UNAVAILABLE)",
      );
    }
  });
});
