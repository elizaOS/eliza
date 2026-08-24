/**
 * Covers the grounded-action-reply helpers against the real State-mining and
 * reply-rendering path: action-result extraction from every candidate queue,
 * complete recent-history serialization, trajectory propagation, and explicit
 * model/context failure behavior. Runtime doubles stand in for IAgentRuntime;
 * the module under test is not mocked.
 */
import type { ActionResult, IAgentRuntime, Memory, State } from "@elizaos/core";
import { ModelType, runWithTrajectoryContext } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractActionResultsFromState,
  renderGroundedActionReply,
  summarizeActiveTrajectory,
  summarizeRecentActionHistory,
} from "./grounded-action-reply.ts";

const { loadTrajectoryByStepId } = vi.hoisted(() => ({
  loadTrajectoryByStepId: vi.fn(),
}));

vi.mock("../runtime/trajectory-internals.ts", () => ({
  loadTrajectoryByStepId,
}));

function stateFrom(data: Record<string, unknown>): State {
  return { data } as unknown as State;
}

function result(partial: {
  actionName?: string;
  text?: string;
  success?: boolean;
  data?: Record<string, unknown>;
}): ActionResult {
  const { actionName, text, success, data } = partial;
  return {
    success,
    text,
    data: {
      ...(actionName ? { actionName } : {}),
      ...data,
    },
  } as ActionResult;
}

function runtimeForReply(options?: {
  useModel?: IAgentRuntime["useModel"] | null;
  character?: IAgentRuntime["character"];
  getSetting?: IAgentRuntime["getSetting"];
}): IAgentRuntime {
  const runtime: Record<string, unknown> = {
    getMemories: vi.fn(async () => []),
    character: options?.character ?? { name: "TestAgent" },
  };
  if (options?.useModel !== null) {
    runtime.useModel =
      options?.useModel ??
      (vi.fn(async () => "Handled it.") as IAgentRuntime["useModel"]);
  }
  if (options?.getSetting) {
    runtime.getSetting = options.getSetting;
  }
  return runtime as unknown as IAgentRuntime;
}

async function renderWith(options: {
  useModel?: IAgentRuntime["useModel"] | null;
  character?: IAgentRuntime["character"];
  getSetting?: IAgentRuntime["getSetting"];
  messageText?: unknown;
  state?: State;
  intent?: string;
  domain?: "lifeops" | "gmail" | "calendar";
  scenario?: string;
  fallback?: string;
  context?: Record<string, unknown>;
  additionalRules?: string[];
  preferCharacterVoice?: boolean;
}): Promise<{ reply: string; prompt: string; useModel: unknown }> {
  let prompt = "";
  const useModel =
    options.useModel === null
      ? null
      : (options.useModel ??
        (vi.fn(async (_model: unknown, params: { prompt: string }) => {
          prompt = params.prompt;
          return "Handled it.";
        }) as IAgentRuntime["useModel"]));
  const runtime = runtimeForReply({
    useModel: useModel ?? undefined,
    character: options.character,
    getSetting: options.getSetting,
  });
  if (options.useModel === null) {
    delete (runtime as { useModel?: unknown }).useModel;
  }
  const reply = await renderGroundedActionReply({
    runtime,
    message: { content: { text: options.messageText ?? "add milk" } } as Memory,
    state: options.state,
    intent: options.intent ?? "confirm",
    domain: options.domain ?? "lifeops",
    scenario: options.scenario ?? "confirm item",
    fallback: options.fallback ?? "I've handled that.",
    context: options.context,
    additionalRules: options.additionalRules,
    preferCharacterVoice: options.preferCharacterVoice,
  });
  return { reply, prompt, useModel };
}

afterEach(() => {
  loadTrajectoryByStepId.mockReset();
  vi.restoreAllMocks();
});

describe("extractActionResultsFromState", () => {
  it("returns an empty list for missing or non-object state", () => {
    expect(extractActionResultsFromState(undefined)).toEqual([]);
    expect(extractActionResultsFromState({} as State)).toEqual([]);
  });

  it("ignores non-array candidate queues", () => {
    expect(
      extractActionResultsFromState(
        stateFrom({
          actionResults: { not: "an array" },
          providers: {
            ACTION_STATE: { data: { actionResults: "nope" } },
          },
        }),
      ),
    ).toEqual([]);
  });

  it("drops non-object entries from a queue", () => {
    const extracted = extractActionResultsFromState(
      stateFrom({
        actionResults: [
          null,
          "skip",
          3,
          { success: true, text: "kept", data: { actionName: "KEEP" } },
        ],
      }),
    );
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toMatchObject({
      success: true,
      text: "kept",
      data: { actionName: "KEEP" },
    });
  });

  it("passes through a plain ActionResult that has no content field", () => {
    const entry = {
      success: false,
      text: "boom",
      data: { actionName: "PLAIN" },
    };
    expect(
      extractActionResultsFromState(stateFrom({ actionResults: [entry] })),
    ).toEqual([entry]);
  });

  it("skips a content-shaped entry whose content is not a record", () => {
    expect(
      extractActionResultsFromState(
        stateFrom({
          actionResults: [{ content: null }, { content: "plain" }],
        }),
      ),
    ).toEqual([]);
  });

  it("maps content.actionStatus failed to success:false and copies actionName", () => {
    const extracted = extractActionResultsFromState(
      stateFrom({
        actionResults: [
          {
            content: {
              actionName: "SEND_MAIL",
              actionStatus: "failed",
              text: "smtp timeout",
              error: "timeout",
              data: { to: "ada@example.com" },
            },
          },
        ],
      }),
    );
    expect(extracted).toEqual([
      {
        success: false,
        text: "smtp timeout",
        error: "timeout",
        data: { to: "ada@example.com", actionName: "SEND_MAIL" },
      },
    ]);
  });

  it("treats a non-failed actionStatus as success and ignores non-string text/error", () => {
    const extracted = extractActionResultsFromState(
      stateFrom({
        actionResults: [
          {
            content: {
              actionStatus: "completed",
              text: 42,
              error: { code: 1 },
              data: { actionName: "DONE" },
            },
          },
        ],
      }),
    );
    expect(extracted[0]).toMatchObject({
      success: true,
      text: undefined,
      error: undefined,
      data: { actionName: "DONE" },
    });
  });

  it("does not overwrite an existing content.data.actionName", () => {
    const extracted = extractActionResultsFromState(
      stateFrom({
        actionResults: [
          {
            content: {
              actionName: "IGNORE_ME",
              text: "ok",
              data: { actionName: "KEEP_ME" },
            },
          },
        ],
      }),
    );
    expect(extracted[0]?.data).toMatchObject({ actionName: "KEEP_ME" });
  });

  it("flattens every candidate queue in source order", () => {
    const extracted = extractActionResultsFromState(
      stateFrom({
        actionResults: [result({ actionName: "DATA", text: "from data" })],
        providers: {
          ACTION_STATE: {
            data: {
              actionResults: [
                result({ actionName: "STATE", text: "from action state" }),
              ],
              recentActionMemories: [
                result({ actionName: "MEM", text: "from memories" }),
              ],
            },
          },
          RECENT_MESSAGES: {
            data: {
              actionResults: [
                result({ actionName: "RECENT", text: "from recent" }),
              ],
            },
          },
        },
      }),
    );
    expect(extracted.map((entry) => entry.data?.actionName)).toEqual([
      "DATA",
      "STATE",
      "MEM",
      "RECENT",
    ]);
  });
});

describe("summarizeRecentActionHistory", () => {
  it("returns an empty list for an empty queue", () => {
    expect(summarizeRecentActionHistory(undefined)).toEqual([]);
    expect(summarizeRecentActionHistory(stateFrom({}))).toEqual([]);
  });

  it("serializes a single element completely", () => {
    expect(
      summarizeRecentActionHistory(
        stateFrom({
          actionResults: [result({ actionName: "SHOP", text: "added milk" })],
        }),
      ),
    ).toEqual([
      '1. SHOP - succeeded\n{"text":"added milk","data":{"actionName":"SHOP"}}',
    ]);
  });

  it("preserves source order", () => {
    expect(
      summarizeRecentActionHistory(
        stateFrom({
          actionResults: [
            result({ actionName: "A", text: "first" }),
            result({ actionName: "B", text: "second" }),
            result({ actionName: "C", text: "third" }),
          ],
        }),
      ),
    ).toEqual([
      '1. A - succeeded\n{"text":"first","data":{"actionName":"A"}}',
      '1. B - succeeded\n{"text":"second","data":{"actionName":"B"}}',
      '1. C - succeeded\n{"text":"third","data":{"actionName":"C"}}',
    ]);
  });

  it("preserves repeated results even when their text differs only by case", () => {
    expect(
      summarizeRecentActionHistory(
        stateFrom({
          actionResults: [
            result({ actionName: "SHOP", text: "Added milk" }),
            result({ actionName: "shop", text: "added milk" }),
          ],
        }),
      ),
    ).toHaveLength(2);
  });

  it("preserves every result instead of applying an implicit default limit", () => {
    const actionResults = [1, 2, 3, 4, 5, 6].map((n) =>
      result({ actionName: "STEP", text: `item ${n}` }),
    );
    expect(
      summarizeRecentActionHistory(stateFrom({ actionResults })),
    ).toHaveLength(6);
  });

  it("ignores the legacy custom limit instead of dropping results", () => {
    const actionResults = [1, 2, 3].map((n) =>
      result({ actionName: "STEP", text: `item ${n}` }),
    );
    expect(
      summarizeRecentActionHistory(stateFrom({ actionResults }), 1),
    ).toHaveLength(3);
  });

  it("preserves results whose structured data has no display title", () => {
    expect(
      summarizeRecentActionHistory(
        stateFrom({
          actionResults: [
            result({ actionName: "EMPTY", text: "   " }),
            result({ actionName: "GONE" }),
            result({ actionName: "KEPT", text: "visible" }),
          ],
        }),
      ),
    ).toHaveLength(3);
  });

  it("preserves a whitespace actionName in the complete serialized payload", () => {
    const serialized = summarizeRecentActionHistory(
      stateFrom({
        actionResults: [
          { success: true, text: "bare", data: { actionName: "  " } },
        ],
      }),
    );
    expect(serialized[0]).toContain('"actionName":"  "');
  });

  it("preserves success state for every result", () => {
    expect(
      summarizeRecentActionHistory(
        stateFrom({
          actionResults: [
            { text: "implicit", data: { actionName: "IMPLICIT" } },
            result({ actionName: "FAIL", text: "nope", success: false }),
          ],
        }),
      ),
    ).toEqual([
      '1. IMPLICIT - succeeded\n{"text":"implicit","data":{"actionName":"IMPLICIT"}}',
      '1. FAIL - failed\n{"success":false,"text":"nope","data":{"actionName":"FAIL"}}',
    ]);
  });

  it("preserves every structured title carrier without selecting one", () => {
    const serialized = summarizeRecentActionHistory(
      stateFrom({
        actionResults: [
          result({
            actionName: "DEF",
            data: { definition: { title: "from definition" } },
          }),
          result({
            actionName: "GOAL",
            data: { goal: { title: "from goal" } },
          }),
          result({
            actionName: "EVENT",
            data: { event: { title: "from event" } },
          }),
          result({ actionName: "TITLE", data: { title: "from title" } }),
          result({
            actionName: "SUBJECT",
            data: { subject: "from subject" },
          }),
          result({ actionName: "QUERY", data: { query: "from query" } }),
        ],
      }),
      6,
    );
    expect(serialized).toHaveLength(6);
    expect(serialized.join("\n")).toContain("from definition");
    expect(serialized.join("\n")).toContain("from query");
  });

  it("preserves whitespace in action-result text", () => {
    const serialized = summarizeRecentActionHistory(
      stateFrom({
        actionResults: [
          result({ actionName: "SHOP", text: "added\n\n  milk" }),
        ],
      }),
    );
    expect(serialized[0]).toContain('"text":"added\\n\\n  milk"');
  });

  it("ignores legacy projection parameters and emits the same complete payload", () => {
    const state = stateFrom({
      actionResults: [result({ actionName: "FILE", text: "RAW_PAGE_CANARY" })],
    });
    const raw = summarizeRecentActionHistory(state, 4, false);
    const projected = summarizeRecentActionHistory(state, 4, true);
    expect(projected).toEqual(raw);
    expect(raw[0]).toContain("RAW_PAGE_CANARY");
  });
});

describe("summarizeActiveTrajectory", () => {
  it("returns null when no trajectory step is active", async () => {
    expect(await summarizeActiveTrajectory({} as IAgentRuntime)).toBeNull();
  });

  it("rejects when the loader returns nothing or throws", async () => {
    loadTrajectoryByStepId.mockResolvedValueOnce(null);
    await expect(
      runWithTrajectoryContext({ trajectoryStepId: "step-missing" }, () =>
        summarizeActiveTrajectory({ agentId: "agent-1" } as IAgentRuntime),
      ),
    ).rejects.toMatchObject({ code: "GROUNDED_REPLY_TRAJECTORY_UNAVAILABLE" });

    loadTrajectoryByStepId.mockRejectedValueOnce(new Error("db down"));
    await expect(
      runWithTrajectoryContext({ trajectoryStepId: "step-throw" }, () =>
        summarizeActiveTrajectory({} as IAgentRuntime),
      ),
    ).rejects.toMatchObject({ code: "GROUNDED_REPLY_TRAJECTORY_UNAVAILABLE" });
  });

  it("formats an empty step list with the plural", async () => {
    loadTrajectoryByStepId.mockResolvedValue({
      id: "traj-empty",
      steps: [],
    });
    const summary = await runWithTrajectoryContext(
      { trajectoryStepId: "step-empty" },
      () => summarizeActiveTrajectory({} as IAgentRuntime),
    );
    expect(summary).toBe('{"id":"traj-empty","steps":[]}');
  });

  it("uses singular step, latest llm purpose, and non-empty providers", async () => {
    loadTrajectoryByStepId.mockResolvedValue({
      id: "traj-one",
      steps: [
        {
          llmCalls: [{ purpose: "plan" }, { purpose: "reply" }],
          providerAccesses: [
            { providerName: "TIME" },
            { providerName: "  " },
            { providerName: 12 },
            { providerName: "ACTION_STATE" },
          ],
        },
      ],
    });
    const summary = await runWithTrajectoryContext(
      { trajectoryStepId: "step-one" },
      () => summarizeActiveTrajectory({} as IAgentRuntime),
    );
    expect(summary).toBe(
      '{"id":"traj-one","steps":[{"llmCalls":[{"purpose":"plan"},{"purpose":"reply"}],"providerAccesses":[{"providerName":"TIME"},{"providerName":"  "},{"providerName":12},{"providerName":"ACTION_STATE"}]}]}',
    );
  });

  it("uses the last step of a multi-step trajectory and omits empty purpose/providers", async () => {
    loadTrajectoryByStepId.mockResolvedValue({
      id: "traj-two",
      steps: [
        {
          llmCalls: [{ purpose: "stale" }],
          providerAccesses: [{ providerName: "OLD" }],
        },
        { llmCalls: [], providerAccesses: [] },
      ],
    });
    const summary = await runWithTrajectoryContext(
      { trajectoryStepId: "step-two" },
      () => summarizeActiveTrajectory({} as IAgentRuntime),
    );
    expect(summary).toContain('"id":"traj-two"');
    expect(summary).toContain('"providerName":"OLD"');
  });
});

describe("renderGroundedActionReply", () => {
  it("returns the fallback when useModel is missing", async () => {
    const { reply } = await renderWith({
      useModel: null,
      fallback: "Canonical fallback.",
    });
    expect(reply).toBe("Canonical fallback.");
  });

  it("propagates a model failure instead of fabricating fallback success", async () => {
    await expect(
      renderWith({
        useModel: vi.fn(async () => {
          throw new Error("model down");
        }) as IAgentRuntime["useModel"],
        fallback: "Canonical fallback.",
      }),
    ).rejects.toThrow("model down");
  });

  it("rejects when useModel emits a non-string", async () => {
    await expect(
      renderWith({
        useModel: vi.fn(async () => ({
          text: "nope",
        })) as unknown as IAgentRuntime["useModel"],
        fallback: "Canonical fallback.",
      }),
    ).rejects.toMatchObject({ code: "GROUNDED_REPLY_OUTPUT_INVALID" });
  });

  it("rejects remaining structured schema-key replies", async () => {
    for (const output of [
      "operation: create",
      "confidence: 0.9",
      "missing: due date",
      "subaction: confirm",
    ]) {
      await expect(
        renderWith({
          useModel: vi.fn(async () => output) as IAgentRuntime["useModel"],
          fallback: "Canonical fallback.",
        }),
      ).rejects.toMatchObject({ code: "GROUNDED_REPLY_OUTPUT_INVALID" });
    }
  });

  it("prompts TEXT_SMALL and preserves model output exactly", async () => {
    const useModel = vi.fn(async (model: unknown) => {
      expect(model).toBe(ModelType.TEXT_SMALL);
      return '  "Added milk to the list."  ';
    }) as IAgentRuntime["useModel"];
    const { reply } = await renderWith({ useModel });
    expect(reply).toBe('  "Added milk to the list."  ');
    expect(useModel).toHaveBeenCalledTimes(1);
  });

  it("labels gmail, calendar, and lifeops domains in the prompt", async () => {
    const gmail = await renderWith({ domain: "gmail" });
    expect(gmail.prompt).toContain(
      "Write the assistant's user-facing reply for a Gmail interaction.",
    );
    expect(gmail.prompt).toContain("Domain: gmail");

    const calendar = await renderWith({ domain: "calendar" });
    expect(calendar.prompt).toContain(
      "Write the assistant's user-facing reply for a calendar interaction.",
    );
    expect(calendar.prompt).toContain("Domain: calendar");

    const lifeops = await renderWith({ domain: "lifeops" });
    expect(lifeops.prompt).toContain(
      "Write the assistant's user-facing reply for a LifeOps interaction.",
    );
    expect(lifeops.prompt).toContain("Domain: lifeops");
  });

  it("serializes a non-string user message as an empty current message", async () => {
    const { prompt } = await renderWith({ messageText: { nested: true } });
    expect(prompt).toContain('Current user message: ""');
  });

  it("includes additionalRules before the reply-only instruction", async () => {
    const { prompt } = await renderWith({
      additionalRules: ["Never mention the weather."],
    });
    expect(prompt).toContain("Never mention the weather.");
    expect(prompt.indexOf("Never mention the weather.")).toBeLessThan(
      prompt.indexOf("Return only the reply text."),
    );
  });

  it("omits character voice unless preferCharacterVoice is set", async () => {
    const { prompt } = await renderWith({
      character: {
        name: "Eliza",
        system: "You are Eliza.",
      } as IAgentRuntime["character"],
    });
    expect(prompt).toContain('Character voice: ""');
    expect(prompt).not.toContain(
      "Stay within the assistant's established character voice when it fits the task.",
    );
  });

  it("builds character voice from system, bio, and style when requested", async () => {
    const { prompt } = await renderWith({
      preferCharacterVoice: true,
      character: {
        name: "Eliza",
        system: "  You are Eliza.  ",
        bio: ["  ", "A helpful operator", 3, "Speaks plainly"],
        style: {
          all: ["Be brief", ""],
          chat: ["Use contractions"],
        },
      } as unknown as IAgentRuntime["character"],
    });
    expect(prompt).toContain(
      "Stay within the assistant's established character voice when it fits the task.",
    );
    expect(prompt).toContain('\\"system\\":\\"  You are Eliza.  \\"');
    expect(prompt).toContain("A helpful operator");
    expect(prompt).toContain("Speaks plainly");
    expect(prompt).toContain("Be brief");
    expect(prompt).toContain("Use contractions");
    expect(prompt).toContain("3");
  });

  it("accepts a string bio when preferring character voice", async () => {
    const { prompt } = await renderWith({
      preferCharacterVoice: true,
      character: {
        name: "Eliza",
        bio: "  One-line bio.  ",
      } as unknown as IAgentRuntime["character"],
    });
    expect(prompt).toContain('\\"bio\\":\\"  One-line bio.  \\"');
  });

  it("rejects circular context instead of substituting a partial string", async () => {
    const context: Record<string, unknown> = { label: "loop" };
    context.self = context;
    await expect(renderWith({ context })).rejects.toMatchObject({
      code: "GROUNDED_REPLY_CONTEXT_INVALID",
    });
  });

  it("embeds recent action history from state into the prompt", async () => {
    const { prompt } = await renderWith({
      state: stateFrom({
        actionResults: [result({ actionName: "SHOP", text: "added milk" })],
      }),
    });
    expect(prompt).toContain("Complete action history:");
    expect(prompt).toContain("added milk");
  });

  it("preserves repeated storage and provider-state turns in the grounded prompt", async () => {
    let prompt = "";
    const runtime = runtimeForReply({
      useModel: vi.fn(async (_model: unknown, params: { prompt: string }) => {
        prompt = params.prompt;
        return "Handled it.";
      }) as IAgentRuntime["useModel"],
    });
    runtime.getMemories = vi.fn(async () => [
      {
        id: "stored-turn",
        entityId: "entity-1",
        roomId: "room-1",
        content: { text: "User: repeat this" },
      } as Memory,
    ]) as IAgentRuntime["getMemories"];

    await renderGroundedActionReply({
      runtime,
      message: {
        roomId: "room-1",
        content: { text: "continue" },
      } as Memory,
      state: {
        values: { recentMessages: "User: repeat this" },
        data: {
          providers: {
            RECENT_MESSAGES: {
              data: {
                recentMessages: [
                  {
                    id: "provider-turn",
                    content: { text: "User: repeat this" },
                  },
                ],
              },
            },
          },
        },
      } as never,
      intent: "continue",
      domain: "lifeops",
      scenario: "continue prior request",
      fallback: "Continuing.",
    });

    expect(prompt).toContain(
      'Complete conversation: ["User: repeat this","User: repeat this","User: repeat this"]',
    );
  });
});
