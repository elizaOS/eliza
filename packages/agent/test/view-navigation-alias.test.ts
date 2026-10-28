import {
  type IAgentRuntime,
  type Memory,
  runWithStreamingContext,
} from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { actionResultToPlannerToolResult } from "../../../plugins/plugin-assistant/src/runtime/planner-loop.ts";
import { preparedViewReply } from "../../../plugins/plugin-assistant/src/services/message/reply-policy.ts";
import { viewsAction } from "../src/actions/views.ts";
import { registerInProcessApi } from "../src/api/in-process-api.ts";
import {
  closeRuntimeViewRegistry,
  getView,
  registerBuiltinViews,
  registerPluginViews,
} from "../src/api/views-registry.ts";
import {
  viewNavigationEvaluator,
  viewNavigationField,
} from "../src/runtime/view-navigation.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const runtimes: IAgentRuntime[] = [];
const unregisters: Array<() => void> = [];
afterEach(() => {
  for (const close of unregisters.splice(0)) close();
  for (const runtime of runtimes.splice(0)) closeRuntimeViewRegistry(runtime);
  vi.unstubAllEnvs();
});
function fixture(
  text = "Open Workflows.",
  modelTarget = "automations",
  role = "OWNER",
) {
  const runtime = {
    agentId: "22222222-2222-4222-8222-222222222222",
    actions: [viewsAction],
    getRoom: async () => ({ worldId: "world" }),
    getWorld: async () => ({
      metadata: {
        roles: { [owner]: role },
        ownership: role === "OWNER" ? { ownerId: owner } : {},
      },
    }),
    getSetting: () => undefined,
    getEntityById: async () => null,
    logger: { warn: vi.fn() },
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  runtimes.push(runtime);
  registerBuiltinViews(runtime);
  const message = {
    id: "33333333-3333-4333-8333-333333333333",
    roomId: "44444444-4444-4444-8444-444444444444",
    entityId: owner,
    content: {
      text,
      source: "client_chat",
      channelType: "DM",
      metadata: { viewClientId: "client-1", viewDelivery: "completed-action" },
    },
  } as Memory;
  const value = {
    disposition: "direct",
    viewId: modelTarget,
    reason: "Fixture",
  };
  const state = { values: {}, data: {}, text: "" };
  const handler = {
    processMessage: "RESPOND",
    plan: {
      contexts: ["general"],
      candidateActions: ["VIEWS"],
      intents: [text],
      replyEffectStatus: "pending",
    },
  };
  return { runtime, message, value, state, handler };
}
async function route(h: ReturnType<typeof fixture>, mutate?: () => void) {
  const signal = new AbortController().signal;
  await viewNavigationField.handle?.({
    runtime: h.runtime,
    message: h.message,
    senderRole: "OWNER",
    state: h.state,
    value: h.value,
    parsed: {} as never,
    turnSignal: signal,
  } as never);
  mutate?.();
  return viewNavigationEvaluator.evaluate({
    runtime: h.runtime,
    message: h.message,
    state: h.state,
    userRoles: ["OWNER"],
    messageHandler: h.handler,
  } as never);
}
it.each([
  ["Open Workflows.", "automations", "workflows"],
  ["Go home.", "chat", "chat"],
  ["Open Automations.", "automations", "automations"],
])(
  "preserves only an equivalent original registered alias: %s",
  async (text, target, wanted) => {
    const h = fixture(text, target);
    const result = await route(h);
    expect(result?.deterministicToolCall?.params).toEqual({
      action: "show",
      view: wanted,
    });
  },
);
it("supports dynamic registered canonical views without an alias table", async () => {
  const h = fixture("Open Mission Board.", "mission");
  await registerPluginViews(
    h.runtime,
    {
      name: "alias-custom",
      views: [
        {
          id: "mission",
          label: "Mission Board",
          path: "/mission",
          bundleUrl: "/mission.js",
        },
      ],
    } as never,
    { pluginDir: process.cwd(), indexEmbeddings: false },
  );
  expect((await route(h))?.deterministicToolCall?.params?.view).toBe("mission");
});
it("does not transfer aliases to a different model-selected destination", async () => {
  const h = fixture("Open Workflows.", "chat");
  expect((await route(h))?.deterministicToolCall?.params?.view).toBe("chat");
});
it("does not manufacture an alias for unknown or ambiguous original wording", async () => {
  const h = fixture("Open Unknown.", "automations");
  expect((await route(h))?.deterministicToolCall?.params?.view).toBe(
    "automations",
  );
  const ambiguous = fixture();
  await registerPluginViews(
    ambiguous.runtime,
    {
      name: "ambiguous-alias",
      views: [
        {
          id: "other-workflows",
          label: "Workflows",
          path: "/other",
          bundleUrl: "/other.js",
        },
      ],
    } as never,
    { pluginDir: process.cwd(), indexEmbeddings: false },
  );
  expect((await route(ambiguous))?.deterministicToolCall?.params?.view).toBe(
    "automations",
  );
});
it("does not introduce deterministic navigation for mixed work or stale renderer scope", async () => {
  const h = fixture();
  h.handler.plan.intents.push("Create a note");
  expect((await route(h))?.deterministicToolCall).toBeUndefined();
  const other = fixture();
  expect(
    await route(other, () => {
      other.message.content.metadata = { viewClientId: "changed" };
    }),
  ).toBeUndefined();
});
it("preserves denied actor and cancellation checks", async () => {
  const h = fixture(undefined, undefined, "NONE");
  expect(await route(h)).toBeUndefined();
  const cancel = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    runWithStreamingContext({ abortSignal: controller.signal } as never, () =>
      route(cancel),
    ),
  ).rejects.toThrow();
});
it("returns an actual top-level native ActionResult that canonical normalization can bind to the held alias reply", async () => {
  const h = fixture();
  const selected = await route(h);
  const params = selected?.deterministicToolCall?.params;
  expect(params?.view).toBe("workflows");
  vi.stubEnv("ELIZA_LOCAL_AGENT_TRANSPORT", "filesystem-v1");
  vi.stubEnv("ELIZA_API_TOKEN", "fixture-token");
  unregisters.push(
    registerInProcessApi(h.runtime, {
      handle: async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        const value = JSON.parse(body);
        const view = getView(h.runtime, "automations")!;
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            ok: true,
            viewId: view.id,
            status: "prepared",
            completedActionHandoffId: value.completedActionHandoffId,
            navigationBinding: {
              requestId: value.completedActionHandoffId,
              clientId: value.clientId,
              viewId: view.id,
              viewType: "gui",
              installationId: view.installationId,
            },
          }),
        );
      },
    }),
  );
  const raw = await viewsAction.handler(h.runtime, h.message, undefined, {
    parameters: params,
  } as never);
  if (!raw) throw Error("Missing action result");
  expect(raw.success).toBe(true);
  expect(raw.values).toBeDefined();
  expect(raw.data?.navigation).toMatchObject({
    status: "prepared",
    resolvedAlias: "workflows",
  });
  const normalized = actionResultToPlannerToolResult(raw);
  expect(normalized.data?.values).toEqual(raw.values);
  const reply = preparedViewReply({
    stageOne: { visualContinuation: h.value, intents: ["Open Workflows"] },
    effectStatus: "pending",
    reply: "Opening Workflows.",
    steps: [{ toolCall: { name: "VIEWS", params }, result: normalized }],
    allow: () => true,
  });
  expect(reply).toBe("Opening Workflows.");
  expect(raw.values?.completedActionDelivered).toBe(false);
});
