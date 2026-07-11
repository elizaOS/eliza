/**
 * Covers notifyAction against a real NotificationService (in-memory cache + stub
 * event bus): validate gating, creating a notification from params, invalid
 * category/priority fallback, and failure on missing title or absent service.
 */
import type {
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import {
  BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
  ModelType,
  NotificationService,
  ResponseHandlerFieldRegistry,
  runV5MessageRuntimeStage1,
  ServiceType,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyAction } from "./notify";

async function makeRuntime(withService = true): Promise<{
  runtime: IAgentRuntime;
  service: NotificationService | null;
}> {
  const cache = new Map<string, unknown>();
  const bus = { emit: vi.fn() };
  const base = {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getCache: async <T>(k: string): Promise<T | undefined> =>
      cache.get(k) as T | undefined,
    setCache: async <T>(k: string, v: T): Promise<boolean> => {
      cache.set(k, v);
      return true;
    },
    deleteCache: async (k: string): Promise<boolean> => cache.delete(k),
    getService: (t: string) => (t === ServiceType.AGENT_EVENT ? bus : null),
  } as unknown as IAgentRuntime;
  const service = withService
    ? ((await NotificationService.start(base)) as NotificationService)
    : null;
  const runtime = {
    agentId: base.agentId,
    getService: (t: string) =>
      t === ServiceType.NOTIFICATION
        ? service
        : t === ServiceType.AGENT_EVENT
          ? bus
          : null,
  } as unknown as IAgentRuntime;
  return { runtime, service };
}

const message = {} as Memory;
const state = {} as State;

describe("notifyAction", () => {
  let runtime: IAgentRuntime;
  let service: NotificationService | null;

  beforeEach(async () => {
    ({ runtime, service } = await makeRuntime());
  });

  it("validates true only when the notification service exists", async () => {
    expect(await notifyAction.validate(runtime, message)).toBe(true);
    const { runtime: bare } = await makeRuntime(false);
    expect(await notifyAction.validate(bare, message)).toBe(false);
  });

  it("creates a notification from parameters", async () => {
    const callback = vi.fn() as unknown as HandlerCallback;
    const result = await notifyAction.handler(
      runtime,
      message,
      state,
      {
        parameters: {
          title: "Build done",
          body: "ok",
          category: "workflow",
          priority: "high",
        },
      },
      callback,
    );
    expect(result).toBeTruthy();
    expect((result as { success: boolean }).success).toBe(true);
    const list = service?.list() ?? [];
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("Build done");
    expect(list[0].category).toBe("workflow");
    expect(list[0].priority).toBe("high");
    expect(callback).toHaveBeenCalled();
  });

  it("falls back to defaults for invalid category/priority", async () => {
    await notifyAction.handler(
      runtime,
      message,
      state,
      { parameters: { title: "X", category: "nonsense", priority: "louder" } },
      undefined,
    );
    const list = service?.list() ?? [];
    expect(list[0].category).toBe("general");
    expect(list[0].priority).toBe("normal");
  });

  it("fails when title is missing", async () => {
    const result = await notifyAction.handler(
      runtime,
      message,
      state,
      { parameters: { body: "no title" } },
      undefined,
    );
    expect((result as { success: boolean }).success).toBe(false);
    expect(service?.list()).toHaveLength(0);
  });

  it("fails gracefully when the service is unavailable", async () => {
    const { runtime: bare } = await makeRuntime(false);
    const result = await notifyAction.handler(
      bare,
      message,
      state,
      { parameters: { title: "x" } },
      undefined,
    );
    expect((result as { success: boolean }).success).toBe(false);
  });

  it("is scoped to automation/agent-internal turns, not ordinary chat", () => {
    // Without explicit contexts NOTIFY fell back to ["general"] and landed on
    // the action surface of every chat turn; a weak planner then picked it to
    // "answer" a question (observed live: NOTIFY chosen for "who are the top 3
    // contributors", posting a self-notification instead of the answer).
    expect(notifyAction.contexts).toEqual(["automation", "agent_internal"]);
    expect(notifyAction.contexts).not.toContain("general");
  });

  it("drops answer-flavored similes that read as 'tell the user'", () => {
    // NOTIFY_USER / ALERT_USER made a planner treat NOTIFY as the reply path.
    expect(notifyAction.similes).toEqual([
      "SEND_NOTIFICATION",
      "PUSH_NOTIFICATION",
      "SEND_ALERT",
    ]);
  });
});

/**
 * Routing through the real message pipeline: the planner's tool surface for a
 * turn is what decides whether NOTIFY can even be chosen, so these tests run
 * runV5MessageRuntimeStage1 with the real notifyAction registered and inspect
 * the tools actually offered to the planner model.
 */
describe("NOTIFY on the planner action surface", () => {
  const AGENT_ID = "00000000-0000-0000-0000-0000000000a3" as UUID;

  function stage1Response(contexts: string[], candidates: string[] = []) {
    return {
      text: "",
      toolCalls: [
        {
          id: "handle-response-1",
          name: "HANDLE_RESPONSE",
          arguments: {
            shouldRespond: "RESPOND",
            thought: "",
            contexts,
            intents: [],
            candidateActionNames: candidates,
            replyText: "",
            facts: [],
            relationships: [],
            addressedTo: [],
          },
        },
      ],
    };
  }

  // A context-free control: it must appear on EVERY turn's surface, so its
  // presence proves the surface was actually built when NOTIFY is absent.
  const contextFreeAction = {
    name: "ECHO_TIME",
    description: "echoes the current time",
    similes: [],
    examples: [],
    parameters: [],
    validate: async () => true,
    handler: async () => ({ success: true, text: "now" }),
  } as unknown as import("@elizaos/core").Action;

  async function makePipelineRuntime(
    responses: unknown[],
  ): Promise<IAgentRuntime> {
    const queue = [...responses];
    const registry = new ResponseHandlerFieldRegistry();
    for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
      registry.register(evaluator);
    }
    // NOTIFY's validate() requires a live NotificationService — an invalid
    // action never reaches the planner surface, so the routing tests need the
    // real service wired in.
    const { service } = await makeRuntime(true);
    return {
      agentId: AGENT_ID,
      character: { name: "Test Agent", system: "Concise.", bio: "Helper." },
      actions: [notifyAction, contextFreeAction],
      providers: [],
      composeState: vi.fn(async () => ({
        values: { availableContexts: "general, automation" },
        data: {},
        text: "",
      })),
      runActionsByMode: vi.fn(async () => undefined),
      emitEvent: vi.fn(async () => undefined),
      useModel: vi.fn(async () => {
        // Background stages (facts/relationships) also call the model after
        // the scripted turn; they get a benign empty response.
        const next = queue.shift();
        return next ?? { text: "" };
      }),
      getSetting: vi.fn(() => undefined),
      getService: vi.fn((t: string) =>
        t === ServiceType.NOTIFICATION ? service : null,
      ),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
      },
      responseHandlerFieldRegistry: registry,
      responseHandlerFieldEvaluators: [
        ...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
      ],
      responseHandlerEvaluators: [],
    } as unknown as IAgentRuntime;
  }

  async function plannerToolNamesFor(
    contexts: string[],
    candidates: string[] = [],
    plannerBody?: unknown,
  ): Promise<string[]> {
    const runtime = await makePipelineRuntime([
      stage1Response(contexts, candidates),
      plannerBody ?? { text: "", toolCalls: [] },
      JSON.stringify({
        success: true,
        decision: "FINISH",
        thought: "Done.",
        messageToUser: "ok",
      }),
    ]);
    await runV5MessageRuntimeStage1({
      runtime,
      message: {
        id: "00000000-0000-0000-0000-0000000000a1" as UUID,
        entityId: "00000000-0000-0000-0000-0000000000a2" as UUID,
        agentId: AGENT_ID,
        roomId: "00000000-0000-0000-0000-0000000000a4" as UUID,
        content: {
          text: "who are the top 3 contributors to the eliza repo",
          source: "test",
        },
        createdAt: 1,
      },
      state: {
        values: { availableContexts: "general, automation" },
        data: {},
        text: "",
      },
      responseId: "00000000-0000-0000-0000-0000000000a5" as UUID,
    });
    const useModel = runtime.useModel as unknown as {
      mock: { calls: unknown[][] };
    };
    const plannerCall = useModel.mock.calls.find(
      (call) => String(call[0]) === String(ModelType.ACTION_PLANNER),
    );
    const params = plannerCall?.[1] as
      | { tools?: Array<{ name?: string }> }
      | undefined;
    return (params?.tools ?? [])
      .map((tool) => String(tool?.name ?? ""))
      .filter(Boolean);
  }

  it("is NOT offered to the planner on an ordinary chat turn", async () => {
    const tools = await plannerToolNamesFor(["general"]);
    // The surface was built (the context-free action is there); NOTIFY is not.
    expect(tools).toContain("ECHO_TIME");
    expect(tools).not.toContain("NOTIFY");
  });

  it("IS offered to the planner on an automation turn", async () => {
    const tools = await plannerToolNamesFor(
      ["automation"],
      ["NOTIFY"],
      // The planner uses it — the real handler runs through the pipeline.
      {
        text: "",
        toolCalls: [
          {
            id: "notify-1",
            name: "NOTIFY",
            args: { title: "Job finished", category: "workflow" },
          },
        ],
      },
    );
    expect(tools).toContain("NOTIFY");
  });
});
