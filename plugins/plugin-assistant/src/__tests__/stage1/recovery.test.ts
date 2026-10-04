import {
  applyGroundedActionReply,
  createUnavailableGroundedActionReply,
  runWithStreamingContext,
} from "@elizaos/core";
import type { IAgentRuntime, State } from "@elizaos/core/protocol";
import { ChannelType, ModelType, type UUID } from "@elizaos/core/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_RESPONSE_HANDLER_EVALUATORS,
  resolveZeroDeliveryRecovery,
  runV5MessageRuntimeStage1,
} from "../../services/message.js";
import {
  acceptedRecoveryReview,
  makeMessage,
  makeRuntime,
  makeState,
  runStage1,
  stage1Response,
  useModelCalls,
} from "./fixtures.js";

describe("Stage 1 recovery", () => {
  it("supplies zero-token interruption state to the next direct reply", async () => {
    const runtime = makeRuntime([
      stage1Response({ contexts: ["simple"], replyText: "Hi." }),
    ]);
    const original = {
      ...makeMessage({ text: "Compare my notes." }),
      id: "00000000-0000-0000-0000-000000000011" as UUID,
      createdAt: 1,
    };
    const receipt = {
      ...original,
      id: "00000000-0000-0000-0000-000000000012" as UUID,
      entityId: runtime.agentId,
      createdAt: 2,
      content: { text: "", interrupted: true, inReplyTo: original.id },
    };
    const state = makeState();
    state.data.providers = {
      RECENT_MESSAGES: { data: { recentMessages: [original, receipt] } },
    };
    const result = await runStage1({
      runtime,
      state,
      message: makeMessage({ channelType: ChannelType.DM, text: "Hi." }),
    });
    expect(result.kind).toBe("direct_reply");
    const params = useModelCalls(runtime)[0][1] as { messages: unknown[] };
    expect(JSON.stringify(params.messages)).toContain(
      "runtime:interrupted_turn",
    );
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
  });

  it("cancels a routing repair before further generation or field dispatch", async () => {
    const abort = new AbortController();
    const runtime = makeRuntime([]);
    runtime.useModel = vi.fn(async () => {
      abort.abort(new Error("cancelled routing repair"));
      return stage1Response({
        contexts: ["simple"],
        intents: ["describe the supplied text"],
        replyText: "The supplied text describes a blue mug.",
        extra: { replyEffectStatus: "none" },
      });
    }) as IAgentRuntime["useModel"];
    const dispatch = vi.spyOn(runtime.responseHandlerFieldRegistry, "dispatch");
    await expect(
      runWithStreamingContext({ abortSignal: abort.signal }, () =>
        runStage1({
          runtime,
          message: makeMessage({ channelType: ChannelType.DM }),
        }),
      ),
    ).rejects.toThrow("cancelled routing repair");
    expect(useModelCalls(runtime)).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("stops a requested context read before another model call when cancelled during recomposition", async () => {
    const abort = new AbortController();
    const runtime = makeRuntime([
      stage1Response({ contextRequests: ["userPersonalityPreferences"] }),
    ]);
    const state = makeState();
    state.data.providers = {
      userPersonalityPreferences: {
        text: "The complete character preferences available to this authorized turn.",
        discoveryText: "context_discovery: userPersonalityPreferences",
      },
    };
    runtime.composeState = vi.fn(async () => {
      abort.abort(new Error("cancelled context read"));
      return structuredClone(state);
    });
    await expect(
      runWithStreamingContext({ abortSignal: abort.signal }, () =>
        runStage1({
          runtime,
          message: makeMessage({ channelType: ChannelType.DM }),
          state,
        }),
      ),
    ).rejects.toThrow("cancelled context read");
    expect(useModelCalls(runtime)).toHaveLength(1);
  });

  it("preserves a committed action when its reply is unavailable without recovery models or context-after actions", async () => {
    const unavailable = createUnavailableGroundedActionReply({
      kind: "provider_issue",
      code: "GROUNDED_REPLY_GENERATION_FAILED",
    });
    const receipt = {
      receiptId: "saved-1",
      operation: "lifeops.reminder.create",
      resource: { kind: "lifeops.reminder", id: "reminder-1" },
      artifacts: [],
      idempotency: { key: "request-1", replayed: false },
      observedAt: "2026-07-27T18:00:00.000Z",
      outcome: "applied" as const,
      commit: {
        kind: "durable" as const,
        id: "txn-1",
        committedAt: "2026-07-27T18:00:00.000Z",
      },
    };
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["general"],
        candidateActionNames: ["SAVE"],
        replyText: "",
        extra: { requiresTool: true },
      }),
      { text: "", toolCalls: [{ id: "save-1", name: "SAVE", arguments: {} }] },
    ]);
    const handler = vi.fn(async () =>
      applyGroundedActionReply(
        {
          success: true,
          text: "Internal save receipt.",
          effectReceipts: [receipt],
        },
        unavailable,
      ),
    );
    runtime.actions = [
      {
        name: "SAVE",
        description: "Save the requested reminder.",
        contexts: ["general"],
        tags: ["write"],
        validate: async () => true,
        handler,
      },
    ];
    const callback = vi.fn(async () => []);
    const result = await runStage1({
      runtime,
      message: makeMessage({ text: "Save the requested reminder." }),
      callback,
    });
    expect(result.kind).toBe("planned_reply");
    if (result.kind !== "planned_reply")
      throw new Error("Expected a planned result");
    expect(result.result).toMatchObject({
      responseContent: null,
      responseMessages: [],
      terminalFailure: unavailable.failure,
      actionResults: [
        {
          success: true,
          effectReceipts: [receipt],
          replyFailure: unavailable.failure,
        },
      ],
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
    expect(useModelCalls(runtime)).toHaveLength(2);
    expect(runtime.runActionsByMode).not.toHaveBeenCalledWith(
      "CONTEXT_AFTER",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not keep known-junk Stage 1 fragments when regeneration returns empty", async () => {
    for (const badReply of [
      "RPPY",
      "{}",
      "aaaaa",
      "::::",
      // whitespace-only reply trims to empty
      "   ",
      // degenerate single-character spam, including across whitespace
      "!!!!!!!!",
      "aaaaa aaaaa",
    ]) {
      const runtime = makeRuntime([
        stage1Response({
          contexts: ["simple"],
          replyText: badReply,
        }),
        "   ",
      ]);

      const result = await runStage1({
        runtime,
        message: makeMessage({ text: "What is 2+2?" }),
      });

      expect(result.kind).toBe("direct_reply");
      if (result.kind === "direct_reply") {
        expect(result.result.responseContent?.text).toBe(
          "I'm not sure how to answer that.",
        );
      }
    }
  });

  it("re-asks once when Stage 1 declares RESPOND with an empty answer and no pending work", async () => {
    const runtime = makeRuntime([
      stage1Response({ contexts: ["simple"], replyText: "" }),
      stage1Response({ contexts: ["simple"], replyText: "Santiago." }),
    ]);
    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "one line: what's the capital of chile?",
        channelType: ChannelType.DM,
      }),
    });
    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe("Santiago.");
    }
    const calls = useModelCalls(runtime);
    expect(calls.map(([type]) => type)).toEqual([
      ModelType.RESPONSE_HANDLER,
      ModelType.RESPONSE_HANDLER,
    ]);
    const repairInput = calls[1]?.[1] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(repairInput.messages.at(-1)?.content).toContain(
      "response_contract_repair:",
    );
    expect(repairInput.messages.at(-1)?.content).toContain(
      "neither an answer nor pending work",
    );
  });

  it("allows a corrected empty RESPOND to end with terminal STOP", async () => {
    const runtime = makeRuntime([
      stage1Response({ contexts: ["simple"], replyText: "" }),
      stage1Response({ shouldRespond: "STOP", contexts: [] }),
    ]);
    const result = await runStage1({
      runtime,
      message: makeMessage({
        text: "one line: what's the capital of chile?",
        channelType: ChannelType.DM,
      }),
    });
    expect(result).toMatchObject({ kind: "terminal", action: "STOP" });
    expect(useModelCalls(runtime)).toHaveLength(2);
  });

  it("still defers empty, whitespace, refusal-stub, and degenerate-run replies (#11504)", async () => {
    for (const badReply of [
      "",
      "   ",
      "I am not sure.",
      "I'm not sure how to answer that.",
      "I don't know.",
      "I'm sorry, I can't help with that.",
      "aaaaa bbbbb",
      "!!!!!\n!!!!!",
    ]) {
      const runtime = makeRuntime([
        stage1Response({ contexts: ["simple"], replyText: badReply }),
      ]);

      const result = await runStage1({
        runtime,
        message: makeMessage({ text: "What is 2+2?" }),
      });

      expect(result.kind).toBe("direct_reply");
      if (result.kind === "direct_reply") {
        expect(result.result.responseContent?.text).toBe(
          "I'm not sure how to answer that.",
        );
      }
    }
  });

  it("retries empty Stage 1 completions until a usable response arrives", async () => {
    const runtime = makeRuntime([
      "",
      { text: "", toolCalls: [] },
      stage1Response({
        contexts: ["simple"],
        replyText: "Recovered after provider empty completions.",
      }),
    ]);

    const result = await runStage1({
      runtime,
      message: makeMessage(),
    });

    expect(result.kind).toBe("direct_reply");
    expect(runtime.useModel).toHaveBeenCalledTimes(3);
    expect(runtime.logger.warn).toHaveBeenCalledTimes(2);
    if (result.kind === "direct_reply") {
      expect(result.result.responseContent?.text).toBe(
        "Recovered after provider empty completions.",
      );
    }
  });

  it("reports a precise Stage 1 error after the empty-completion retry budget is exhausted", async () => {
    const runtime = makeRuntime(["", "", ""]);

    await expect(
      runStage1({
        runtime,
        message: makeMessage(),
      }),
    ).rejects.toThrow(
      "v5 messageHandler returned empty Stage 1 result after 3 attempts",
    );
    expect(runtime.useModel).toHaveBeenCalledTimes(3);
    expect(runtime.logger.warn).toHaveBeenCalledTimes(2);
  });

  it("ELIZA_RESPONSE_HANDLER_EMPTY_RETRIES=0 disables the retry (exactly 1 attempt)", async () => {
    // A single empty completion with the retry budget set to 0 must fail
    // immediately — no second model call — even though a usable response is
    // queued behind it.
    const runtime = makeRuntime(
      [
        "",
        stage1Response({ contexts: ["simple"], replyText: "never reached" }),
      ],
      { ELIZA_RESPONSE_HANDLER_EMPTY_RETRIES: "0" },
    );

    await expect(
      runStage1({
        runtime,
        message: makeMessage(),
      }),
    ).rejects.toThrow(/empty Stage 1 result after 1 attempt/);
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(runtime.logger.warn).not.toHaveBeenCalled();
  });

  it("ELIZA_RESPONSE_HANDLER_EMPTY_RETRIES clamps an out-of-range value to 5 (6 attempts)", async () => {
    // "99" clamps to the max of 5 retries → 6 total attempts before giving up.
    const runtime = makeRuntime(["", "", "", "", "", ""], {
      ELIZA_RESPONSE_HANDLER_EMPTY_RETRIES: "99",
    });

    await expect(
      runStage1({
        runtime,
        message: makeMessage(),
      }),
    ).rejects.toThrow(/empty Stage 1 result after 6 attempts/);
    expect(runtime.useModel).toHaveBeenCalledTimes(6);
  });

  it("ELIZA_RESPONSE_HANDLER_EMPTY_RETRIES falls back to the default 2 on a non-numeric value", async () => {
    // "abc" → NaN → the hardcoded default of 2 retries → 3 total attempts.
    const runtime = makeRuntime(["", "", ""], {
      ELIZA_RESPONSE_HANDLER_EMPTY_RETRIES: "abc",
    });

    await expect(
      runStage1({
        runtime,
        message: makeMessage(),
      }),
    ).rejects.toThrow(/empty Stage 1 result after 3 attempts/);
    expect(runtime.useModel).toHaveBeenCalledTimes(3);
  });

  it("falls back to the planner when an explicitly addressed Stage 1 turn stays empty", async () => {
    const runtime = makeRuntime([
      "",
      "",
      "",
      JSON.stringify({
        thought: "Fallback planner can answer.",
        toolCalls: [],
        messageToUser: "Recovered through planner fallback.",
      }),
    ]);
    const message = makeMessage();
    message.content.mentionContext = { isMention: true } as never;

    const result = await runStage1({
      runtime,
      message,
    });

    expect(result.kind).toBe("planned_reply");
    expect(runtime.useModel).toHaveBeenCalledTimes(4);
    expect(runtime.logger.warn).toHaveBeenCalledTimes(3);
    if (result.kind === "planned_reply") {
      expect(result.result.responseContent?.text).toBe(
        "Recovered through planner fallback.",
      );
    }
  });

  it("keeps polluted rendered text out of empty Stage 1 planner fallback candidates", async () => {
    const runtime = makeRuntime([
      "",
      "",
      "",
      JSON.stringify({
        thought: "Fallback planner can answer.",
        toolCalls: [],
        messageToUser: "Recovered through planner fallback.",
      }),
    ]);
    const message = makeMessage({
      text: "Test Agent (@000000000000000000) BASH_EXECUTE FETCH_URL TASKS_SPAWN_AGENT Can you tell me what elizaOS is?",
      currentMessageText: "Can you check my calendar?",
    });
    message.content.mentionContext = { isMention: true } as never;

    const result = await runStage1({
      runtime,
      message,
    });

    expect(result.kind).toBe("planned_reply");
    expect(runtime.useModel).toHaveBeenCalledTimes(4);
    const plannerCall = useModelCalls(runtime)[3];
    const plannerParams = plannerCall?.[1] as {
      messages?: Array<{ content?: string | null }>;
    };
    const plannerPrompt = plannerParams.messages?.[1]?.content ?? "";
    expect(plannerPrompt).toContain("Can you check my calendar?");
    expect(plannerPrompt).not.toContain("BASH_EXECUTE");
    if (result.kind === "planned_reply") {
      expect(result.result.responseContent?.text).toBe(
        "Recovered through planner fallback.",
      );
    }
  });

  it("preserves direct app-build routing when explicitly addressed Stage 1 stays empty", async () => {
    const runtime = makeRuntime([
      "",
      "",
      "",
      {
        thought: "A coding task should be delegated.",
        toolCalls: [
          {
            id: "spawn-app-builder",
            name: "TASKS_SPAWN_AGENT",
            arguments: { task: "Write a random tweet app." },
          },
        ],
      },
      JSON.stringify({
        success: true,
        decision: "FINISH",
        thought: "The app-build task was delegated.",
        messageToUser: "Started the app build.",
      }),
    ]);
    const fileHandler = vi.fn(async () => ({
      success: true,
      text: "File should not be selected first.",
      data: { actionName: "FILE" },
    }));
    const taskHandler = vi.fn(async () => ({
      success: true,
      text: "Spawned coding agent.",
      data: { actionName: "TASKS_SPAWN_AGENT" },
    }));
    runtime.actions = [
      {
        name: "FILE",
        similes: ["WRITE_FILE"],
        description: "Read or write files directly.",
        examples: [],
        validate: async () => true,
        handler: fileHandler,
      },
      {
        name: "TASKS_SPAWN_AGENT",
        similes: ["SPAWN_AGENT"],
        description: "Spawn a coding task agent.",
        parameters: [
          {
            name: "task",
            description: "Coding task to perform",
            required: true,
            schema: { type: "string" },
          },
        ],
        examples: [],
        validate: async () => true,
        handler: taskHandler,
      },
    ] as never;
    const message = makeMessage();
    message.content = {
      ...message.content,
      text: "write me a tweet app",
      mentionContext: { isMention: true },
    };

    const result = await runStage1({
      runtime,
      message,
    });

    expect(result.kind).toBe("planned_reply");
    expect(taskHandler).toHaveBeenCalledTimes(1);
    expect(fileHandler).not.toHaveBeenCalled();
    const calls = useModelCalls(runtime);
    expect(calls[3]?.[0]).toBe(ModelType.ACTION_PLANNER);
    const plannerCall = calls[3]?.[1] as {
      messages?: Array<{ role?: string; content?: string | null }>;
      tools?: Array<{ name: string; description?: string }>;
    };
    const plannerUserContent = plannerCall.messages?.[1]?.content ?? "";
    expect(plannerUserContent).toContain(
      '"candidateActions":["TASKS_SPAWN_AGENT"]',
    );
    expect(plannerCall.tools?.map((tool) => tool.name)).toContain(
      "TASKS_SPAWN_AGENT",
    );
    expect(
      plannerCall.tools?.find((tool) => tool.name === "DISCOVER_ACTIONS")
        ?.description,
    ).toContain("Find authorized operations");
  });

  it("preserves direct current-info candidates when explicitly addressed Stage 1 stays empty", async () => {
    const runtime = makeRuntime([
      "",
      "",
      "",
      {
        thought: "Fallback planner can use search.",
        toolCalls: [
          {
            id: "search-current-price",
            name: "SEARCH",
            arguments: { query: "current Bitcoin price USD" },
          },
        ],
      },
      JSON.stringify({
        success: true,
        decision: "FINISH",
        thought: "Search returned current market data.",
        messageToUser: "Current BTC price fetched from search.",
      }),
    ]);
    const searchHandler = vi.fn(async () => ({
      success: true,
      text: "BTC current price: 1 USD",
      data: { actionName: "SEARCH" },
    }));
    runtime.actions = [
      {
        name: "SEARCH",
        similes: ["WEB_SEARCH", "SEARCH_WEB"],
        description: "Search current public data.",
        parameters: [
          {
            name: "query",
            description: "Search query",
            required: true,
            schema: { type: "string" },
          },
        ],
        examples: [],
        validate: async () => true,
        handler: searchHandler,
      },
    ] as never;
    const message = makeMessage();
    message.content = {
      ...message.content,
      text: "What is the current Bitcoin price in USD right now?",
      mentionContext: { isMention: true },
    };

    const result = await runStage1({
      runtime,
      message,
    });

    expect(result.kind).toBe("planned_reply");
    expect(searchHandler).toHaveBeenCalledTimes(1);
    const calls = useModelCalls(runtime);
    expect(calls[3]?.[0]).toBe(ModelType.ACTION_PLANNER);
    const plannerCall = calls[3]?.[1] as {
      messages?: Array<{ role?: string; content?: string | null }>;
    };
    const plannerUserContent = plannerCall.messages?.[1]?.content ?? "";
    expect(plannerUserContent).toContain('"candidateActions":["SEARCH"]');
    expect(plannerUserContent).toContain('"requiresTool":true');
    if (result.kind === "planned_reply") {
      expect(result.result.responseContent?.text).toBe(
        "Current BTC price fetched from search.",
      );
    }
  });

  it.each(["none", "non_applied"] as const)(
    "repairs a %s cancellation without entering the action planner",
    async (status) => {
      const answer =
        "I will not save that note. A fresh create request is required.";
      const runtime = makeRuntime(
        [
          stage1Response({
            contexts: ["simple"],
            intents: [],
            replyText:
              "Cancelled. The Safety fixture history QA note won't be saved unless you send a fresh create request.",
            extra: { replyEffectStatus: status },
          }),
          JSON.stringify({ response: answer, effectReceiptIds: [] }),
          acceptedRecoveryReview(
            "The candidate declines unstarted work and preserves the fresh authorization requirement.",
          ),
        ],
        undefined,
        [...BUILTIN_RESPONSE_HANDLER_EVALUATORS],
      );
      const result = await runStage1({
        runtime,
        message: makeMessage({
          text: "Cancel the Safety fixture history QA note request. Do not save it, even if I repeat the old approval phrase; require a new explicit create request first.",
        }),
      });
      expect(result.kind).toBe("direct_reply");
      expect(useModelCalls(runtime).map(([type]) => type)).toEqual([
        ModelType.RESPONSE_HANDLER,
        ModelType.TEXT_SMALL,
        ModelType.TEXT_SMALL,
      ]);
      if (result.kind === "direct_reply")
        expect(result.result.responseContent?.text).toBe(answer);
    },
  );

  it("keeps RECENT_ERRORS out of the planner recompose AND its cached rendering on an ambient turn", async () => {
    // The Stage-1 exclusion alone is not enough: the planner recompose
    // re-adds every alwaysInResponseState provider, and composeState merges
    // the whole turn cache into the state it returns — so a RECENT_ERRORS
    // block cached by ANY earlier compose would still render into the
    // planner prompt of an ambient turn routed to planning. Both halves are
    // pinned here: the include list handed to composeState (composition
    // pass) and the rendered planner prompt (cached rendering), with
    // composeState deliberately returning state that already carries the
    // diagnostics block.
    const diagnosticsBlock = [
      "## Recent runtime errors (internal diagnostics)",
      "",
      "- [available_apps] PROVIDER_TIMEOUT: available_apps provider timeout",
    ].join("\n");
    const cachedStateWithRecentErrors = (): State => ({
      values: { availableContexts: "general, calendar" },
      data: {
        providers: {
          RECENT_ERRORS: { text: diagnosticsBlock },
        },
      },
      text: "Recent conversation summary",
    });
    const makeEchoProneRuntime = () => {
      const runtime = makeRuntime([
        stage1Response({
          thought: "Ambient chatter; see whether tools have anything.",
          contexts: ["general"],
          replyText: "",
        }),
        {
          text: "",
          toolCalls: [{ id: "ignore-1", name: "IGNORE", arguments: {} }],
        },
        JSON.stringify({
          response: "I need more context to answer that question.",
        }),
        acceptedRecoveryReview(
          "The candidate acknowledges missing information without asserting an effect.",
        ),
      ]);
      runtime.providers = [
        {
          name: "RECENT_ERRORS",
          alwaysInResponseState: true,
          get: async () => ({ text: diagnosticsBlock }),
        },
      ] as never;
      runtime.composeState = vi.fn(async () => cachedStateWithRecentErrors());
      return runtime;
    };

    const ambientRuntime = makeEchoProneRuntime();
    await runStage1({
      runtime: ambientRuntime,
      message: makeMessage({
        text: "what was it for?",
        channelType: ChannelType.GROUP,
      }),
      responseId: "00000000-0000-0000-0000-00000000000a" as UUID,
    });
    const ambientComposeCalls = (
      ambientRuntime.composeState as { mock: { calls: unknown[][] } }
    ).mock.calls;
    // Composition pass: the planner include list must not request the
    // provider the Stage-1 exclusion already withheld.
    for (const call of ambientComposeCalls) {
      expect(call[1] as string[]).not.toContain("RECENT_ERRORS");
    }
    // Cached rendering: the state composeState returned CONTAINS the block,
    // and the planner prompt still must not.
    const ambientPlanner = useModelCalls(ambientRuntime)[1]?.[1] as {
      messages?: Array<{ content?: string | null }>;
    };
    const ambientPlannerContent = (ambientPlanner.messages ?? [])
      .map((entry) => entry.content ?? "")
      .join("\n");
    expect(ambientPlannerContent).not.toContain("Recent runtime errors");
    expect(ambientPlannerContent).not.toContain("PROVIDER_TIMEOUT");

    // Addressed twin (platform mention): identical runtime and cached state,
    // and the diagnostics block renders — proving the ambient classifier,
    // not some blanket render skip, owns the exclusion.
    const addressedRuntime = makeEchoProneRuntime();
    await runStage1({
      runtime: addressedRuntime,
      message: makeMessage({
        text: "what was it for?",
        channelType: ChannelType.GROUP,
        mentionContext: { isMention: true, isReply: false, isThread: false },
      }),
      responseId: "00000000-0000-0000-0000-00000000000b" as UUID,
    });
    const addressedComposeCalls = (
      addressedRuntime.composeState as { mock: { calls: unknown[][] } }
    ).mock.calls;
    expect(
      addressedComposeCalls.some((call) =>
        (call[1] as string[]).includes("RECENT_ERRORS"),
      ),
    ).toBe(true);
    const addressedPlanner = useModelCalls(addressedRuntime)[1]?.[1] as {
      messages?: Array<{ content?: string | null }>;
    };
    const addressedPlannerContent = (addressedPlanner.messages ?? [])
      .map((entry) => entry.content ?? "")
      .join("\n");
    expect(addressedPlannerContent).toContain("Recent runtime errors");
  });

  it("does not publish an acknowledgment after routing is cancelled", async () => {
    const abort = new AbortController();
    const runtime = makeRuntime(
      [
        stage1Response({
          contexts: ["general"],
          replyText: "I'll check that now.",
          extra: { requiresTool: true, replyEffectStatus: "pending" },
        }),
      ],
      undefined,
      [
        {
          name: "cancel-before-planning",
          priority: 1,
          shouldRun: () => true,
          evaluate: () => {
            abort.abort(new Error("cancelled before acknowledgment"));
            return { requiresTool: true };
          },
        },
      ],
    );
    const onPlanningAcknowledgment = vi.fn();
    await expect(
      runWithStreamingContext({ abortSignal: abort.signal }, () =>
        runV5MessageRuntimeStage1({
          runtime,
          message: makeMessage(),
          state: makeState(),
          responseId: "00000000-0000-0000-0000-000000000005" as UUID,
          onPlanningAcknowledgment,
        }),
      ),
    ).rejects.toThrow("cancelled before acknowledgment");
    expect(onPlanningAcknowledgment).not.toHaveBeenCalled();
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
  });

  // Zero-delivery recovery contract (#20086, backstop behind #20083): a
  // RESPOND turn that ran tools and delivered no terminal/action-owned text
  // must recover a grounded reply — even after an early progress ack — while
  // never duplicating a delivery, never claiming success when every tool
  // failed, and staying silent for a successfully accepted async handoff
  // whose completion arrives through a later relay turn.
  describe("zero-delivery recovery", () => {
    const spawnTurnResponses = () => [
      stage1Response({
        thought: "Spawn the coding task.",
        contexts: ["general"],
        candidateActionNames: ["TASKS_SPAWN_AGENT"],
        replyText: "On it.",
        extra: { requiresTool: true },
      }),
      {
        text: "",
        toolCalls: [
          {
            id: "spawn-1",
            name: "TASKS_SPAWN_AGENT",
            arguments: {},
          },
        ],
      },
    ];
    const spawnAction = (
      handlerResult: Record<string, unknown>,
    ): IAgentRuntime["actions"] =>
      [
        {
          name: "TASKS_SPAWN_AGENT",
          description: "Spawn a coding task.",
          contexts: ["general"],
          asyncHandoff: true,
          validate: vi.fn(async () => true),
          handler: vi.fn(async () => ({
            continueChain: false,
            ...handlerResult,
          })),
        },
      ] as IAgentRuntime["actions"];

    it("delivers a grounded terminal reply after an early progress ack when the tool failed with user-facing text", async () => {
      const runtime = makeRuntime(spawnTurnResponses());
      runtime.actions = spawnAction({
        success: false,
        text: "",
        userFacingText: "The sandbox rejected the spawn: quota exceeded.",
      });
      const earlyReply = vi.fn(async () => undefined);

      const result = await runStage1({
        runtime,
        message: makeMessage(),
        onResponseHandlerEarlyReply: earlyReply,
      });

      expect(earlyReply).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe("planned_reply");
      if (result.kind === "planned_reply") {
        // The turn must end with the tool's grounded failure text —
        // never a repeat of the ack and never silence.
        expect(result.result.responseContent?.text).toBe(
          "The sandbox rejected the spawn: quota exceeded.",
        );
      }
    });

    it("ends a failed-tool early-ack turn with failure-aware wording, never a success claim", async () => {
      const runtime = makeRuntime(spawnTurnResponses());
      runtime.actions = spawnAction({ success: false, text: "" });
      const earlyReply = vi.fn(async () => undefined);

      const result = await runStage1({
        runtime,
        message: makeMessage(),
        onResponseHandlerEarlyReply: earlyReply,
      });

      expect(earlyReply).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe("planned_reply");
      if (result.kind === "planned_reply") {
        const text = result.result.responseContent?.text ?? "";
        expect(text.length).toBeGreaterThan(0);
        // The turn's only tool failed; the terminal reply must not claim
        // the work finished and must not re-send the ack.
        expect(text).not.toContain("finished");
        expect(text).not.toBe("On it.");
        expect(text).toContain("failed");
      }
    });

    it("delivers the action's userFacingText after an early ack instead of ending silent", async () => {
      const runtime = makeRuntime(spawnTurnResponses());
      runtime.actions = spawnAction({
        success: true,
        text: "",
        userFacingText: "Spawned coding task session-1; progress will follow.",
      });
      const earlyReply = vi.fn(async () => undefined);

      const result = await runStage1({
        runtime,
        message: makeMessage(),
        onResponseHandlerEarlyReply: earlyReply,
      });

      expect(earlyReply).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe("planned_reply");
      if (result.kind === "planned_reply") {
        expect(result.result.responseContent?.text).toBe(
          "Spawned coding task session-1; progress will follow.",
        );
      }
    });

    it("keeps a successfully accepted async handoff silent after the early ack", async () => {
      const runtime = makeRuntime(spawnTurnResponses());
      runtime.actions = spawnAction({ success: true, text: "" });
      const earlyReply = vi.fn(async () => undefined);

      const result = await runStage1({
        runtime,
        message: makeMessage(),
        onResponseHandlerEarlyReply: earlyReply,
      });

      expect(earlyReply).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe("planned_reply");
      if (result.kind === "planned_reply") {
        // The ack promised background work that a completion relay will
        // report; a manufactured "finished" line here would be a lie.
        expect(result.result.responseContent).toBeNull();
        expect(result.result.responseMessages).toEqual([]);
      }
    });

    it("does not duplicate an action-owned callback delivery", async () => {
      const deliveredLine = "Spawned the coding task: session-1.";
      const runtime = makeRuntime(spawnTurnResponses());
      runtime.actions = [
        {
          name: "TASKS_SPAWN_AGENT",
          description: "Spawn a coding task.",
          contexts: ["general"],
          asyncHandoff: true,
          validate: vi.fn(async () => true),
          handler: vi.fn(async (...handlerArgs: unknown[]) => {
            const callback = handlerArgs[4] as
              | ((content: { text: string }) => Promise<unknown>)
              | undefined;
            await callback?.({ text: deliveredLine });
            return {
              success: true,
              text: deliveredLine,
              userFacingText: deliveredLine,
              continueChain: false,
            };
          }),
        },
      ] as IAgentRuntime["actions"];
      const deliveredVisibleTexts = new Set<string>();
      const delivered: string[] = [];
      const earlyReply = vi.fn(async () => undefined);

      const result = await runV5MessageRuntimeStage1({
        runtime,
        message: makeMessage(),
        state: makeState(),
        responseId: "00000000-0000-0000-0000-000000000005" as UUID,
        onResponseHandlerEarlyReply: earlyReply,
        deliveredVisibleTexts,
        callback: async (content) => {
          if (content.text) {
            delivered.push(content.text);
            deliveredVisibleTexts.add(content.text.toLowerCase());
          }
          return [];
        },
      });

      expect(result.kind).toBe("planned_reply");
      expect(delivered).toEqual([]);
      if (result.kind === "planned_reply") {
        // Hold the callback; return one final response for the outer delivery boundary.
        expect(result.result.responseContent?.text).toBe(deliveredLine);
        expect(result.result.responseMessages).toHaveLength(1);
      }
    });

    // Pure decision seam: the exact source precedence, ack suppression,
    // failure-aware wording, and the async-handoff silence gate.
    describe("resolveZeroDeliveryRecovery", () => {
      it("never fabricates a failed-steps report on a toolless turn", () => {
        // Effect honesty: with no action results at all, the fallback must
        // not claim "I ran the steps … they failed".
        const decision = resolveZeroDeliveryRecovery({
          plannedText: "",
          actionResults: [],
          stageOneAck: "",
          earlyReplySent: false,
        });
        expect(decision.recover).toBe(true);
        expect(decision.source).toBe("fallbackText");
        expect(decision.text).toBe("");
        expect(decision.text).not.toMatch(/ran the steps|failed/i);
      });

      it("requires model-backed recovery when failed steps have no reply", () => {
        const decision = resolveZeroDeliveryRecovery({
          plannedText: "",
          actionResults: [{ success: false }],
          stageOneAck: "",
          earlyReplySent: false,
        });
        expect(decision.recover).toBe(true);
        expect(decision.text).toBe("");
        expect(decision.actionFailureCount).toBe(1);
      });

      it("prefers surviving planner text over everything else", () => {
        const decision = resolveZeroDeliveryRecovery({
          plannedText: "The check passed on retry.",
          actionResults: [{ success: true, userFacingText: "raw tool line" }],
          stageOneAck: "On it.",
          earlyReplySent: false,
        });
        expect(decision).toMatchObject({
          recover: true,
          text: "The check passed on retry.",
          source: "plannedText",
        });
      });

      it("prefers the LAST explicit action userFacingText ahead of the Stage-1 ack", () => {
        const decision = resolveZeroDeliveryRecovery({
          plannedText: "",
          actionResults: [
            { success: true, userFacingText: "first tool line" },
            { success: false },
            { success: true, userFacingText: "second tool line" },
          ],
          stageOneAck: "On it.",
          earlyReplySent: false,
        });
        expect(decision).toMatchObject({
          recover: true,
          text: "second tool line",
          source: "actionUserFacingText",
          actionSuccessCount: 2,
          actionFailureCount: 1,
        });
      });

      it("never re-sends the Stage-1 ack once an early ack shipped", () => {
        const decision = resolveZeroDeliveryRecovery({
          plannedText: "",
          actionResults: [{ success: false }],
          stageOneAck: "On it.",
          earlyReplySent: true,
        });
        expect(decision.recover).toBe(true);
        expect(decision.text).not.toBe("On it.");
        expect(decision.source).toBe("fallbackText");
      });

      it("preserves failure counts without producing canned prose", () => {
        const decision = resolveZeroDeliveryRecovery({
          plannedText: "",
          actionResults: [{ success: false }, { success: false }],
          stageOneAck: "",
          earlyReplySent: false,
        });
        expect(decision.source).toBe("fallbackText");
        expect(decision.text).toBe("");
        expect(decision.actionSuccessCount).toBe(0);
        expect(decision.actionFailureCount).toBe(2);
      });

      it("leaves successful outcomes to model synthesis without inviting replay", () => {
        const decision = resolveZeroDeliveryRecovery({
          plannedText: "",
          actionResults: [{ success: true }],
          stageOneAck: "",
          earlyReplySent: false,
        });
        expect(decision.source).toBe("fallbackText");
        expect(decision.text).toBe("");
        expect(decision.actionSuccessCount).toBe(1);
      });

      it("preserves mixed outcomes for model synthesis", () => {
        const decision = resolveZeroDeliveryRecovery({
          plannedText: "",
          actionResults: [{ success: true }, { success: false }],
          stageOneAck: "",
          earlyReplySent: false,
        });
        expect(decision.source).toBe("fallbackText");
        expect(decision.text).toBe("");
        expect(decision.actionSuccessCount).toBe(1);
        expect(decision.actionFailureCount).toBe(1);
      });

      it("recovers a mixed-outcome early-ack turn because one failed action may own the handoff", () => {
        const decision = resolveZeroDeliveryRecovery({
          plannedText: "",
          actionResults: [{ success: true }, { success: false }],
          stageOneAck: "On it.",
          earlyReplySent: true,
        });
        expect(decision.recover).toBe(true);
        expect(decision.source).toBe("fallbackText");
        expect(decision.text).toBe("");
        expect(decision.text).not.toBe("On it.");
      });

      it("declines to recover a successful early-ack turn with nothing grounded to say", () => {
        const decision = resolveZeroDeliveryRecovery({
          plannedText: "",
          actionResults: [{ success: true }],
          stageOneAck: "On it.",
          earlyReplySent: true,
        });
        expect(decision.recover).toBe(false);
      });
    });
  });
});
