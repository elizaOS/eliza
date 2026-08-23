/**
 * Covers the grounded-action-reply helpers against the real State-mining and
 * reply-rendering path: action-result extraction from every candidate queue,
 * recent-history ordering / ties / empty / overflow, trajectory summary
 * branches, and renderGroundedActionReply fallbacks. Runtime doubles stand in
 * for IAgentRuntime; the module under test is not mocked.
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

  it("summarizes a single element", () => {
    expect(
      summarizeRecentActionHistory(
        stateFrom({
          actionResults: [result({ actionName: "SHOP", text: "added milk" })],
        }),
      ),
    ).toEqual(["SHOP ok: added milk"]);
  });

  it("orders newest-first by reversing the extracted queue", () => {
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
    ).toEqual(["C ok: third", "B ok: second", "A ok: first"]);
  });

  it("dedupes case-insensitive actionName:text ties, keeping the newest", () => {
    expect(
      summarizeRecentActionHistory(
        stateFrom({
          actionResults: [
            result({ actionName: "SHOP", text: "Added milk" }),
            result({ actionName: "shop", text: "added milk" }),
          ],
        }),
      ),
    ).toEqual(["shop ok: added milk"]);
  });

  it("caps overflow at the default limit of 4 newest unique items", () => {
    const actionResults = [1, 2, 3, 4, 5, 6].map((n) =>
      result({ actionName: "STEP", text: `item ${n}` }),
    );
    expect(summarizeRecentActionHistory(stateFrom({ actionResults }))).toEqual([
      "STEP ok: item 6",
      "STEP ok: item 5",
      "STEP ok: item 4",
      "STEP ok: item 3",
    ]);
  });

  it("honors a smaller custom limit", () => {
    const actionResults = [1, 2, 3].map((n) =>
      result({ actionName: "STEP", text: `item ${n}` }),
    );
    expect(
      summarizeRecentActionHistory(stateFrom({ actionResults }), 1),
    ).toEqual(["STEP ok: item 3"]);
  });

  it("skips items with no text and no title instead of inventing a row", () => {
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
    ).toEqual(["KEPT ok: visible"]);
  });

  it("falls back to ACTION when actionName is missing or whitespace", () => {
    expect(
      summarizeRecentActionHistory(
        stateFrom({
          actionResults: [
            { success: true, text: "bare", data: { actionName: "  " } },
          ],
        }),
      ),
    ).toEqual(["ACTION ok: bare"]);
  });

  it("labels success !== false as ok and success false as failed", () => {
    expect(
      summarizeRecentActionHistory(
        stateFrom({
          actionResults: [
            { text: "implicit", data: { actionName: "IMPLICIT" } },
            result({ actionName: "FAIL", text: "nope", success: false }),
          ],
        }),
      ),
    ).toEqual(["FAIL failed: nope", "IMPLICIT ok: implicit"]);
  });

  it("uses title fallbacks in definition / goal / event / title / subject / query order", () => {
    expect(
      summarizeRecentActionHistory(
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
      ),
    ).toEqual([
      "QUERY ok: from query",
      "SUBJECT ok: from subject",
      "TITLE ok: from title",
      "EVENT ok: from event",
      "GOAL ok: from goal",
      "DEF ok: from definition",
    ]);
  });

  it("collapses whitespace in the snippet", () => {
    expect(
      summarizeRecentActionHistory(
        stateFrom({
          actionResults: [
            result({ actionName: "SHOP", text: "added\n\n  milk" }),
          ],
        }),
      ),
    ).toEqual(["SHOP ok: added milk"]);
  });

  it("prefers projected model text over raw result.text when projection is on", () => {
    const state = stateFrom({
      actionResults: [result({ actionName: "FILE", text: "RAW_PAGE_CANARY" })],
    });
    const raw = summarizeRecentActionHistory(state, 4, false);
    const projected = summarizeRecentActionHistory(state, 4, true);
    expect(raw).toEqual(["FILE ok: RAW_PAGE_CANARY"]);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatch(/^FILE ok: /);
    expect(projected[0]).not.toBe(raw[0]);
    expect(projected[0]).toContain("FILE");
  });
});

describe("summarizeActiveTrajectory", () => {
  it("returns null when no trajectory step is active", async () => {
    expect(await summarizeActiveTrajectory({} as IAgentRuntime)).toBeNull();
  });

  it("falls back when the loader returns nothing or throws", async () => {
    loadTrajectoryByStepId.mockResolvedValueOnce(null);
    const missing = await runWithTrajectoryContext(
      { trajectoryStepId: "step-missing" },
      () => summarizeActiveTrajectory({ agentId: "agent-1" } as IAgentRuntime),
    );
    expect(missing).toBe("active trajectory step step-missing");

    loadTrajectoryByStepId.mockRejectedValueOnce(new Error("db down"));
    const thrown = await runWithTrajectoryContext(
      { trajectoryStepId: "step-throw" },
      () => summarizeActiveTrajectory({} as IAgentRuntime),
    );
    expect(thrown).toBe("active trajectory step step-throw");
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
    expect(summary).toBe("trajectory traj-empty; 0 steps");
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
      "trajectory traj-one; 1 step; latest llm purpose: reply; recent providers: TIME, ACTION_STATE",
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
    expect(summary).toBe("trajectory traj-two; 2 steps");
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

  it("returns the fallback when useModel throws", async () => {
    const { reply } = await renderWith({
      useModel: vi.fn(async () => {
        throw new Error("model down");
      }) as IAgentRuntime["useModel"],
      fallback: "Canonical fallback.",
    });
    expect(reply).toBe("Canonical fallback.");
  });

  it("returns the fallback when useModel emits a non-string", async () => {
    const { reply } = await renderWith({
      useModel: vi.fn(async () => ({
        text: "nope",
      })) as unknown as IAgentRuntime["useModel"],
      fallback: "Canonical fallback.",
    });
    expect(reply).toBe("Canonical fallback.");
  });

  it("returns the fallback for remaining structured schema-key replies", async () => {
    for (const output of [
      "operation: create",
      "confidence: 0.9",
      "missing: due date",
      "subaction: confirm",
    ]) {
      const { reply } = await renderWith({
        useModel: vi.fn(async () => output) as IAgentRuntime["useModel"],
        fallback: "Canonical fallback.",
      });
      expect(reply).toBe("Canonical fallback.");
    }
  });

  it("prompts TEXT_SMALL and returns normalized prose", async () => {
    const useModel = vi.fn(async (model: unknown) => {
      expect(model).toBe(ModelType.TEXT_SMALL);
      return '  "Added milk to the list."  ';
    }) as IAgentRuntime["useModel"];
    const { reply } = await renderWith({ useModel });
    expect(reply).toBe("Added milk to the list.");
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
    expect(prompt).toContain("System:\\nYou are Eliza.");
    expect(prompt).toContain("- A helpful operator");
    expect(prompt).toContain("- Speaks plainly");
    expect(prompt).toContain("- Be brief");
    expect(prompt).toContain("- Use contractions");
    expect(prompt).not.toContain("- 3");
  });

  it("accepts a string bio when preferring character voice", async () => {
    const { prompt } = await renderWith({
      preferCharacterVoice: true,
      character: {
        name: "Eliza",
        bio: "  One-line bio.  ",
      } as unknown as IAgentRuntime["character"],
    });
    expect(prompt).toContain("Bio:\\n- One-line bio.");
  });

  it("stringifies circular context via the catch path instead of throwing", async () => {
    const context: Record<string, unknown> = { label: "loop" };
    context.self = context;
    const { prompt, reply } = await renderWith({ context });
    expect(reply).toBe("Handled it.");
    expect(prompt).toContain("Structured context: [object Object]");
  });

  it("embeds recent action history from state into the prompt", async () => {
    const { prompt } = await renderWith({
      state: stateFrom({
        actionResults: [result({ actionName: "SHOP", text: "added milk" })],
      }),
    });
    expect(prompt).toContain("SHOP ok: added milk");
  });
});
