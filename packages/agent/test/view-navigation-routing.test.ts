import {
  getDirectActionRoutingRules,
  type IAgentRuntime,
  type Memory,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_RESPONSE_HANDLER_EVALUATORS,
  resolveEligibleDirectActionRoutes,
} from "../../../plugins/plugin-assistant/src/services/message/stage1-evaluators.ts";
import { viewsAction } from "../src/actions/views.ts";
import {
  closeRuntimeViewRegistry,
  registerBuiltinViews,
  registerPluginViews,
} from "../src/api/views-registry.ts";
import { registerViewNavigationRoutingRule } from "../src/runtime/view-navigation.ts";
import { resolveExplicitRegisteredViewRequest } from "../src/runtime/view-navigation-targets.ts";

const runtimes: IAgentRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) closeRuntimeViewRegistry(runtime);
});
function fixture() {
  const runtime = {
    agentId: "11111111-1111-4111-8111-111111111111",
    actions: promoteSubactionsToActions(viewsAction),
    getSetting: () => undefined,
    getService: () => null,
    logger: { warn: vi.fn() },
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  runtimes.push(runtime);
  registerBuiltinViews(runtime);
  registerViewNavigationRoutingRule(runtime);
  return runtime;
}
function message(text: string): Memory {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    entityId: "33333333-3333-4333-8333-333333333333",
    roomId: "44444444-4444-4444-8444-444444444444",
    content: {
      text,
      source: "client_chat",
      channelType: "DM",
      metadata: { viewClientId: "client-1" },
    },
  } as Memory;
}
async function eligible(runtime: IAgentRuntime, text: string, role = "OWNER") {
  return resolveEligibleDirectActionRoutes({
    runtime,
    message: message(text),
    state: { values: {}, data: {}, text: "" },
    userRoles: [role],
  } as never);
}
describe("registered view navigation exposure", () => {
  it("admits the existing Workflows/Home aliases through the actual registry and role gates", async () => {
    const r = fixture();
    expect(
      (await eligible(r, "Open Workflows.")).map((x) => x.action.name),
    ).toEqual(["VIEWS_SHOW"]);
    expect((await eligible(r, "Go home.")).map((x) => x.action.name)).toEqual([
      "VIEWS_SHOW",
    ]);
    expect(await eligible(r, "Open Workflows.", "NONE")).toEqual([]);
  });
  it("keeps unknown, advisory, conditional and non-navigation requests out", async () => {
    const r = fixture();
    for (const text of [
      "Open Unknown.",
      "Maybe look at Workflows.",
      "If ready, open Workflows.",
      "Do not open Workflows.",
      "Should I open Workflows?",
      "List notes.",
      "Open Workflows then create a note.",
    ])
      expect(await eligible(r, text)).toEqual([]);
  });
  it("uses dynamic registered names and rejects ambiguity or removed registries", async () => {
    const r = fixture();
    await registerPluginViews(
      r,
      {
        name: "test-custom-view",
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
    expect((await eligible(r, "Open Mission Board.")).length).toBe(1);
    expect(
      resolveExplicitRegisteredViewRequest(
        [
          { id: "one", label: "Same" },
          { id: "two", label: "Same" },
        ],
        "Open Same.",
      ),
    ).toBeUndefined();
    closeRuntimeViewRegistry(r);
    await expect(eligible(r, "Open Workflows.")).rejects.toMatchObject({
      code: "VIEW_REGISTRY_CLOSED",
    });
  });
  it("does not expose an unavailable registered view", async () => {
    const r = fixture();
    await registerPluginViews(
      r,
      {
        name: "test-missing-view",
        views: [
          {
            id: "missing",
            label: "Missing Surface",
            path: "/missing",
            bundlePath: "does-not-exist.js",
          },
        ],
      } as never,
      { pluginDir: process.cwd(), indexEmbeddings: false },
    );
    expect(await eligible(r, "Open Missing Surface.")).toEqual([]);
  });
  it("only adds capability candidates and leaves optional visual judgment unchanged", async () => {
    const r = fixture();
    const rule = getDirectActionRoutingRules(r)[0];
    expect(rule.wholeRequest).toBeUndefined();
    expect(rule.replacesActionNames).toBeUndefined();
    const handler = {
      processMessage: "RESPOND",
      plan: {
        contexts: ["general"],
        intents: ["Open Workflows"],
        candidateActions: [],
        replyEffectStatus: "applied",
      },
    };
    const evaluate = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
      (x) => x.name === "core.direct_registered_capability_request",
    )!;
    const patch = await evaluate.evaluate({
      runtime: r,
      message: message("Open Workflows."),
      state: { values: {}, data: {}, text: "" },
      messageHandler: handler,
      userRoles: ["OWNER"],
    } as never);
    expect(patch).toMatchObject({
      requiresTool: true,
      addCandidateActions: ["VIEWS_SHOW"],
    });
    expect(patch).not.toHaveProperty("replaceIntentScope");
    expect(patch).not.toHaveProperty("replyEffectStatus");
    expect(handler.plan.replyEffectStatus).toBe("applied");
  });
  it("requires an actual renderer chat when message metadata is supplied", () => {
    const r = fixture();
    const rule = getDirectActionRoutingRules(r)[0];
    const m = message("Open Workflows.");
    delete m.content.metadata;
    expect(rule.matches("Open Workflows.", m)).toBe(false);
  });
});
