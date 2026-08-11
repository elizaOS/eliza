/**
 * Live Cerebras runtime proof for URL work orders through the real
 * PGLite-backed message loop and the production TASKS action surface. The
 * action handler is replaced with a harmless probe so no ACP process starts;
 * trajectory persistence is disabled because it is an independent subsystem
 * with its own oversized-tool-schema regression tracked in #18287.
 */
import {
  ChannelType,
  type Content,
  createMessageMemory,
  type HandlerCallback,
  type Memory,
  promoteSubactionsToActions,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "@elizaos/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tasksAction } from "../actions/tasks.ts";

const liveDescribe =
  process.env.ELIZA_RUN_LIVE_TESTS === "1" &&
  process.env.CEREBRAS_API_KEY?.trim()
    ? describe
    : describe.skip;
const actionCalls: string[] = [];
const webCalls: string[] = [];

const probeTasksAction = {
  ...tasksAction,
  validate: async () => true,
  handler: async (
    _runtime: Parameters<typeof tasksAction.handler>[0],
    message: Parameters<typeof tasksAction.handler>[1],
    _state: Parameters<typeof tasksAction.handler>[2],
    _options: Parameters<typeof tasksAction.handler>[3],
    _callback: Parameters<typeof tasksAction.handler>[4],
  ) => {
    const text =
      typeof message.content.text === "string" ? message.content.text : "";
    actionCalls.push(text);
    const resultText = "Delegation probe accepted the coding work order.";
    return {
      success: true,
      text: resultText,
      data: { actionName: "TASKS", observedInput: text },
    };
  },
};

const probePlugin = {
  name: "url-work-order-live-probe",
  description: "Production TASKS metadata with a harmless execution probe.",
  actions: [
    ...promoteSubactionsToActions(probeTasksAction, {
      overrides: {
        spawn_agent: {
          description:
            "Delegate a coding task to a dedicated ACP coding sub-agent. USE THIS for repository review, debugging, testing, or substantial multi-step coding work that benefits from a dedicated workspace and its own tool loop. The coding sub-agent can read, write, and edit files, run tests, and report back when done.",
          descriptionCompressed:
            "delegate ACP coding sub-agent for repository review|debug|test|multi-step work",
        },
      },
    }),
    {
      name: "WEB_FETCH",
      description: "Fetch and read a public URL for a lightweight link share.",
      similes: ["FETCH_URL", "LOOKUP_WEB"],
      validate: async () => true,
      handler: async (
        _runtime: unknown,
        message: Memory,
        _state: unknown,
        _options: unknown,
      ) => {
        const text =
          typeof message.content.text === "string" ? message.content.text : "";
        webCalls.push(text);
        return {
          success: true,
          text: "Fetched the shared page for the live routing probe.",
          data: { actionName: "WEB_FETCH", observedInput: text },
        };
      },
    },
  ],
};

liveDescribe("URL work-order routing — live Cerebras runtime", () => {
  let harness: RealTestRuntimeResult;

  beforeAll(async () => {
    harness = await createRealTestRuntime({
      characterName: "RoutingProofAgent",
      withLLM: true,
      preferredProvider: "openai",
      plugins: [probePlugin],
    });
    if (harness.providerConfig?.baseUrl !== "https://api.cerebras.ai/v1") {
      throw new Error("Live URL routing proof requires the Cerebras provider");
    }
    await harness.runtime.disableTrajectories();
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  async function runTurn(text: string) {
    const roomId = stringToUuid(`url-work-order-room:${text}`) as UUID;
    const userId = stringToUuid(`url-work-order-user:${text}`) as UUID;
    const worldId = stringToUuid("url-work-order-world") as UUID;
    await harness.runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "Routing proof user",
      source: "live-trajectory",
      channelId: roomId,
      type: ChannelType.DM,
    });
    const world = await harness.runtime.getWorld(worldId);
    if (!world) throw new Error("live routing proof world was not initialized");
    await harness.runtime.updateWorld({
      ...world,
      metadata: {
        ...(world.metadata ?? {}),
        roles: {
          ...((world.metadata?.roles as Record<string, string> | undefined) ??
            {}),
          [userId]: "USER",
        },
        roleSources: {
          ...((world.metadata?.roleSources as
            | Record<string, string>
            | undefined) ?? {}),
          [userId]: "manual",
        },
      },
    });
    const message: Memory = createMessageMemory({
      id: stringToUuid(`url-work-order-message:${text}`) as UUID,
      entityId: userId,
      roomId,
      content: {
        text,
        source: "live-trajectory",
        channelType: ChannelType.DM,
      },
    });
    const delivered: Content[] = [];
    const callback: HandlerCallback = async (content) => {
      delivered.push(content);
      return [];
    };
    const service = harness.runtime.messageService;
    if (!service) throw new Error("message service was not initialized");
    const result = await service.handleMessage(
      harness.runtime,
      message,
      callback,
      {},
    );
    return { delivered, result };
  }

  it("executes TASKS for review, audit, and failure-investigation URL work orders", async () => {
    for (const text of [
      "review this PR https://github.com/elizaOS/eliza/pull/18106",
      "audit this repository https://github.com/elizaOS/eliza",
      "investigate the failure here https://example.com/run",
    ]) {
      const callCount = actionCalls.length;
      const { delivered, result } = await runTurn(text);
      const diagnostics = JSON.stringify({
        text,
        responseContent: result.responseContent,
        actionResults: result.actionResults,
        delivered,
      });
      expect(actionCalls, diagnostics).toHaveLength(callCount + 1);
      expect(actionCalls.at(-1)).toBe(text);
      expect(
        delivered.every(
          (content) => content.text !== "I handled the available step.",
        ),
      ).toBe(true);
    }
  }, 240_000);

  it("does not delegate passive links or personal health-review requests", async () => {
    for (const text of [
      "thoughts? https://example.com",
      "analyze the error in my blood test results",
    ]) {
      const callCount = actionCalls.length;
      const webCallCount = webCalls.length;
      await runTurn(text);
      expect(actionCalls).toHaveLength(callCount);
      expect(webCalls).toHaveLength(
        text.startsWith("thoughts?") ? webCallCount + 1 : webCallCount,
      );
    }
  }, 180_000);
});
