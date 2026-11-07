import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  getDirectActionRoutingRules,
  type IAgentRuntime,
  isObjectRecord,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { viewsAction } from "../src/actions/views.ts";
import { closeViewInteractionHost } from "../src/api/view-interaction-host.ts";
import {
  closeRuntimeViewRegistry,
  getView,
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "../src/api/views-registry.ts";
import {
  getCurrentViewState,
  handleViewsRoutes,
} from "../src/api/views-routes.ts";
import { runWithViewClient } from "../src/runtime/view-client-context.ts";
import {
  registerViewNavigationRoutingRule,
  viewNavigationEvaluator,
  viewNavigationField,
} from "../src/runtime/view-navigation.ts";

const owner = "11111111-1111-4111-8111-111111111111" as UUID;
const principal = "55555555-5555-4555-8555-555555555555" as UUID;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  vi.unstubAllEnvs();
});
function clientMessage(): Memory {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    entityId: owner,
    roomId: "22222222-2222-4222-8222-222222222222",
    content: { source: "client_chat", channelType: "DM", text: "Go back" },
  } as Memory;
}
async function fixture() {
  const runtime = {
    agentId: "44444444-4444-4444-8444-444444444444",
    actions: [viewsAction],
    getRoom: async () => ({ worldId: "world" }),
    getWorld: async () => ({
      id: "world",
      metadata: {
        roles: { [owner]: "OWNER" },
        ownership: { ownerId: owner },
      },
    }),
    getSetting: () => undefined,
    getEntityById: async () => null,
    emitEvent: async () => undefined,
    reportError: vi.fn(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as IAgentRuntime;
  registerBuiltinViews(runtime);
  registerViewNavigationRoutingRule(runtime);
  const installation = await registerPluginViews(
    runtime,
    {
      name: "test-nav-views",
      description: "Fixture view owner",
      views: [
        { id: "notes", label: "Notes", path: "/notes", bundleUrl: "/notes.js" },
        {
          id: "calendar",
          label: "Calendar",
          path: "/calendar",
          bundleUrl: "/calendar.js",
        },
      ],
    },
    { pluginDir: process.cwd(), indexEmbeddings: false },
  );
  const hostKey = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.headers.authorization !== "Bearer local-navigation-test") {
      res.writeHead(401).end();
      return;
    }
    void handleViewsRoutes({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      hostKey,
      runtime,
      callerAuthorization: { ok: true, role: "OWNER", identityId: principal },
      json: (response, body) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      },
      error: (response, message, code = 500) => {
        response.writeHead(code, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: message }));
      },
      broadcastWsToClientId: () => 1,
      broadcastWs: () => {
        throw Error("Global navigation is forbidden");
      },
    }).catch((error) => res.writeHead(500).end(String(error)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    closeViewInteractionHost(hostKey);
    closeRuntimeViewRegistry(runtime);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    runtime,
    installation,
    hostKey,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}
describe("confirmed previous navigation", () => {
  it("retains only acknowledged same-client history and invalidates it on manual state", async () => {
    const f = await fixture();
    const scope = { hostKey: f.hostKey, clientId: "origin-client" };
    const events = vi.spyOn(f.runtime, "emitEvent");
    const post = (path: string, body: unknown) =>
      fetch(f.url + path, {
        method: "POST",
        headers: {
          authorization: "Bearer local-navigation-test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    let sequence = 0;
    const prepare = async (viewId: string) => {
      const response = await post(`/api/views/${viewId}/navigate`, {
        clientId: scope.clientId,
        delivery: "completed-action",
        prepareOnly: true,
        viewType: "gui",
        completedActionHandoffId: `confirmed-${++sequence}`,
      });
      expect(response.status).toBe(200);
      const { navigationBinding } = await response.json();
      const claim = await post("/api/views/interact-claim", navigationBinding);
      expect(claim.status).toBe(200);
      return {
        ...navigationBinding,
        claimId: (await claim.json()).claimId,
        success: true,
        result: { switched: true },
      };
    };
    const acknowledge = async (binding: Record<string, unknown>) => {
      expect(
        await (await post("/api/views/interact-result", binding)).json(),
      ).toMatchObject({ accepted: true });
    };
    const context = async (
      viewId: string,
      clientId = scope.clientId,
      callerPrincipal = principal,
      hostKey = f.hostKey,
      overrides: Record<string, unknown> = {},
      withoutRequest = false,
    ) =>
      runWithViewClient(
        {
          hostKey,
          clientId,
          ...(!withoutRequest
            ? {
                request: {
                  runtime: f.runtime,
                  authorization: {
                    ok: true,
                    role: "OWNER",
                    identityId: callerPrincipal,
                  },
                  signal: new AbortController().signal,
                  ...overrides,
                },
              }
            : {}),
        },
        () =>
          viewNavigationField.getContext!({
            runtime: f.runtime,
            message: {
              ...clientMessage(),
              entityId: owner,
              content: {
                source: "client_chat",
                channelType: "DM",
                text: "Go back",
                metadata: {
                  viewClientId: clientId,
                  viewDelivery: "completed-action",
                  uiView: viewId,
                },
              },
            },
            senderRole: "OWNER",
            turnSignal: new AbortController().signal,
          } as never),
      );
    const failed = await prepare("notes");
    await acknowledge({
      ...failed,
      success: false,
      result: { switched: false },
    });
    expect(getCurrentViewState(f.runtime, scope)).toBeNull();
    const first = await prepare("notes");
    expect(getCurrentViewState(f.runtime, scope)).toBeNull();
    await acknowledge(first);
    await vi.waitFor(() =>
      expect(getCurrentViewState(f.runtime, scope)?.viewId).toBe("notes"),
    );
    expect(await context("notes")).toContain(
      "no confirmed previous destination",
    );
    const second = await prepare("chat");
    expect(
      getCurrentViewState(f.runtime, scope)?.navigationConfirmation
        ?.previousView,
    ).toBeUndefined();
    await acknowledge(second);
    await vi.waitFor(() =>
      expect(getCurrentViewState(f.runtime, scope)?.viewId).toBe("chat"),
    );
    const confirmed = getCurrentViewState(
      f.runtime,
      scope,
    )?.navigationConfirmation;
    expect(confirmed?.previousView).toEqual({
      viewId: "notes",
      installationId: getView(f.runtime, "notes")?.installationId,
    });
    expect(await context("chat")).toContain(
      "Last confirmed previous destination",
    );
    expect(await context("chat")).toContain('"id":"notes"');

    const backRoute = getDirectActionRoutingRules(f.runtime).find(
      (rule) => rule.id === "views.explicit-navigation",
    )!;
    expect(backRoute).toBeDefined();
    const routeMessage = (text: string): Memory => ({
      ...clientMessage(),
      content: {
        source: "client_chat",
        channelType: "DM",
        text,
        metadata: {
          viewClientId: scope.clientId,
          viewDelivery: "completed-action",
          uiView: "chat",
        },
      },
    });
    const routeScope = {
      ...scope,
      request: {
        runtime: f.runtime,
        authorization: {
          ok: true,
          role: "OWNER" as const,
          identityId: principal,
        },
        signal: new AbortController().signal,
      },
    };
    for (const text of ["Go back.", "Back", "Please go back!"])
      expect(
        runWithViewClient(routeScope, () =>
          backRoute.matches(text, routeMessage(text)),
        ),
      ).toBe(true);
    for (const text of [
      "Go back and read my notes",
      "Go back if my note exists",
      "Go back to https://example.com",
      "Do not go back",
      "Back to notes",
      "Why go back?",
    ])
      expect(
        runWithViewClient(routeScope, () =>
          backRoute.matches(text, routeMessage(text)),
        ),
      ).toBe(false);
    expect(
      runWithViewClient({ ...routeScope, clientId: "foreign-client" }, () =>
        backRoute.matches("Go back", routeMessage("Go back")),
      ),
    ).toBe(false);
    expect(
      runWithViewClient({ ...routeScope, hostKey: {} }, () =>
        backRoute.matches("Go back", routeMessage("Go back")),
      ),
    ).toBe(false);
    expect(backRoute.matches("Go back", routeMessage("Go back"))).toBe(false);
    for (const authorization of [
      undefined,
      { ok: false, role: "OWNER" as const, identityId: principal },
      { ok: true, role: "OWNER" as const, identityId: "foreign-owner" },
      { ok: true, role: "USER" as const, identityId: principal },
    ])
      expect(
        runWithViewClient(
          { ...routeScope, request: { ...routeScope.request, authorization } },
          () => backRoute.matches("Go back", routeMessage("Go back")),
        ),
      ).toBe(false);
    const directMessage = routeMessage("Go back");
    const directPlan = {
      contexts: ["general"],
      intents: ["Go back to the confirmed previous view"],
      candidateActions: [...backRoute.actionNames],
      parentActionHints: [],
      requiresTool: true,
      reply: "Going back.",
      replyEffectStatus: "pending",
    };
    const directSelection = await runWithViewClient(routeScope, async () => {
      viewNavigationField.handle!({
        runtime: f.runtime,
        message: directMessage,
        senderRole: "OWNER",
        value: {
          disposition: "direct",
          viewId: "notes",
          reason: "Confirmed previous view",
        },
        turnSignal: new AbortController().signal,
      } as never);
      return viewNavigationEvaluator.evaluate({
        runtime: f.runtime,
        message: directMessage,
        state: { data: { providers: {} } },
        userRoles: ["OWNER"],
        messageHandler: { processMessage: "RESPOND", plan: directPlan },
      } as never);
    });
    expect(directSelection?.deterministicToolCall).toEqual({
      name: "VIEWS",
      params: { action: "show", view: "notes" },
    });
    const abortedRoute = new AbortController();
    abortedRoute.abort();
    for (const request of [
      { ...routeScope.request, signal: abortedRoute.signal },
      { ...routeScope.request, runtime: null },
    ])
      expect(
        runWithViewClient({ ...routeScope, request }, () =>
          backRoute.matches("Go back", routeMessage("Go back")),
        ),
      ).toBe(false);
    const hiddenCurrent = routeMessage("Go back");
    hiddenCurrent.content.metadata = {
      viewClientId: scope.clientId,
      viewDelivery: "completed-action",
      uiView: "missing-view",
    };
    expect(
      runWithViewClient(routeScope, () =>
        backRoute.matches("Go back", hiddenCurrent),
      ),
    ).toBe(false);
    const external = routeMessage("Go back");
    external.content.source = "external";
    expect(
      runWithViewClient(routeScope, () =>
        backRoute.matches("Go back", external),
      ),
    ).toBe(false);
    for (const change of [
      { contexts: ["general", "notes"] },
      { intents: ["Go back", "Read notes"] },
      { candidateActions: ["VIEWS_SHOW", "NOTES_LIST"] },
    ]) {
      const message = routeMessage("Go back");
      const result = await runWithViewClient(routeScope, async () => {
        viewNavigationField.handle!({
          runtime: f.runtime,
          message,
          senderRole: "OWNER",
          value: { disposition: "direct", viewId: "notes", reason: "Fixture" },
          turnSignal: new AbortController().signal,
        } as never);
        return viewNavigationEvaluator.evaluate({
          runtime: f.runtime,
          message,
          state: { data: { providers: {} } },
          userRoles: ["OWNER"],
          messageHandler: {
            processMessage: "RESPOND",
            plan: { ...directPlan, ...change },
          },
        } as never);
      });
      expect(result?.deterministicToolCall).toBeUndefined();
      expect(result?.requiresTool).toBe(true);
    }

    expect(confirmed?.ownerId).toBe(principal);
    expect(principal).not.toBe(owner);
    expect(await context("chat")).not.toContain(principal);
    expect(
      await context("chat", scope.clientId, principal, f.hostKey, {}, true),
    ).toContain("no confirmed previous destination");
    const cancelled = new AbortController();
    cancelled.abort();
    for (const overrides of [
      { runtime: null },
      { signal: cancelled.signal },
      { authorization: undefined },
      { authorization: { ok: false, role: "OWNER", identityId: principal } },
      { authorization: { ok: true, role: "USER", identityId: principal } },
      {
        authorization: {
          ok: true,
          role: "OWNER",
          identityId: "foreign-owner",
          principal,
        },
      },
    ]) {
      expect(
        await context("chat", scope.clientId, principal, f.hostKey, overrides),
      ).toContain("no confirmed previous destination");
    }

    for (const args of [
      ["notes", scope.clientId, principal, f.hostKey],
      ["chat", "foreign-client", principal, f.hostKey],
      ["chat", scope.clientId, "foreign-owner", f.hostKey],
      ["chat", scope.clientId, principal, {}],
    ] as const)
      expect(
        await context(args[0], args[1], args[2] as UUID, args[3]),
      ).toContain("no confirmed previous destination");
    await acknowledge(await prepare("chat"));
    await vi.waitFor(() =>
      expect(
        getCurrentViewState(f.runtime, scope)?.navigationConfirmation
          ?.handoffId,
      ).toBe("confirmed-4"),
    );
    expect(
      getCurrentViewState(f.runtime, scope)?.navigationConfirmation
        ?.previousView,
    ).toEqual(confirmed?.previousView);
    const stale = await prepare("notes");
    expect(
      (
        await post("/api/views/calendar/navigate", {
          clientId: scope.clientId,
          source: "user",
        })
      ).status,
    ).toBe(200);
    await acknowledge(stale);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getCurrentViewState(f.runtime, scope)?.viewId).toBe("calendar");
    expect(
      getCurrentViewState(f.runtime, scope)?.navigationConfirmation,
    ).toBeUndefined();
    expect(await context("calendar")).toContain(
      "no confirmed previous destination",
    );
    expect(
      runWithViewClient(routeScope, () =>
        backRoute.matches("Go back", routeMessage("Go back")),
      ),
    ).toBe(false);
    // Only the explicit manual route may announce a switch; native acks never do.
    expect(events).toHaveBeenCalledTimes(1);
    // Re-established confirmed history cannot outlive its registered installation.
    await acknowledge(await prepare("notes"));
    await acknowledge(await prepare("chat"));
    await vi.waitFor(() =>
      expect(getCurrentViewState(f.runtime, scope)?.viewId).toBe("chat"),
    );
    expect(await context("chat")).toContain(
      "Last confirmed previous destination",
    );
    unregisterPluginViews(f.runtime, f.installation);
    expect(
      runWithViewClient(routeScope, () =>
        backRoute.matches("Go back", routeMessage("Go back")),
      ),
    ).toBe(false);
    expect(await context("chat")).toContain(
      "no confirmed previous destination",
    );
    expect(await context("notes")).toBe("");
    const message = {
      ...clientMessage(),
      agentId: f.runtime.agentId,
      content: {
        source: "client_chat",
        channelType: "DM",
        text: "Go back",
        metadata: {
          viewClientId: scope.clientId,
          viewDelivery: "completed-action",
          uiView: "chat",
        },
      },
    };
    const value = {
      disposition: "unresolved",
      viewId: "",
      reason: "No confirmed previous destination",
    };
    viewNavigationField.handle!({
      runtime: f.runtime,
      message,
      senderRole: "OWNER",
      value,
      turnSignal: new AbortController().signal,
    } as never);
    const messageHandler = {
      processMessage: "RESPOND",
      plan: {
        contexts: ["general"],
        intents: [],
        candidateActions: [],
        parentActionHints: [],
        requiresTool: false,
        reply: "Which screen would you like to open?",
        replyEffectStatus: "non_applied",
      },
    };
    const selected = await viewNavigationEvaluator.evaluate({
      runtime: f.runtime,
      message,
      state: { data: { providers: {} } },
      userRoles: ["OWNER"],
      messageHandler,
    } as never);
    expect(selected).toBeUndefined();
    expect(messageHandler.plan.requiresTool).toBe(false);
    expect(messageHandler.plan.intents).toEqual([]);
  });
});

it("retains only the prepared destination's verified alias through the real acknowledgement", async () => {
  const f = await fixture();
  const scope = {
    hostKey: f.hostKey,
    clientId: "alias-client",
    request: {
      runtime: f.runtime,
      authorization: {
        ok: true,
        role: "OWNER" as const,
        identityId: principal,
      },
      signal: new AbortController().signal,
    },
  };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(f.url + path, {
      method: "POST",
      headers: {
        authorization: "Bearer local-navigation-test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  let sequence = 0;
  const prepare = async (viewId: string, resolvedAlias?: string) =>
    post(`/api/views/${viewId}/navigate`, {
      clientId: scope.clientId,
      delivery: "completed-action",
      prepareOnly: true,
      viewType: "gui",
      completedActionHandoffId: `alias-${++sequence}`,
      ...(resolvedAlias ? { resolvedAlias } : {}),
    });
  const acknowledge = async (
    binding: Record<string, unknown>,
    attemptAliasForgery = false,
  ) => {
    const claim = await post("/api/views/interact-claim", binding);
    if (attemptAliasForgery) {
      expect(
        await post("/api/views/interact-result", {
          ...binding,
          claimId: claim.claimId,
          success: true,
          result: { switched: true, resolvedAlias: "home" },
        }),
      ).toMatchObject({ accepted: false });
      expect(getCurrentViewState(f.runtime, scope)).toBeNull();
    }
    expect(
      await post("/api/views/interact-result", {
        ...binding,
        claimId: claim.claimId,
        success: true,
        result: { switched: true },
      }),
    ).toMatchObject({ accepted: true });
    await vi.waitFor(() =>
      expect(getCurrentViewState(f.runtime, scope)?.viewId).toBe(
        binding.viewId,
      ),
    );
  };
  const message = (): Memory => ({
    ...clientMessage(),
    content: {
      source: "client_chat",
      channelType: "DM",
      text: "Go back",
      metadata: {
        viewClientId: scope.clientId,
        viewDelivery: "completed-action",
        uiView: "chat",
      },
    },
  });
  const context = () =>
    runWithViewClient(scope, () =>
      viewNavigationField.getContext!({
        runtime: f.runtime,
        message: message(),
        senderRole: "OWNER",
        turnSignal: new AbortController().signal,
      } as never),
    );
  // Use the actual action to resolve and forward the caller's registered alias.
  vi.stubEnv("ELIZA_API_PORT", new URL(f.url).port);
  vi.stubEnv("ELIZA_API_TOKEN", "local-navigation-test");
  const actionMessage = message();
  const result = await viewsAction.handler(
    f.runtime,
    actionMessage,
    undefined,
    { parameters: { action: "show", view: "workflows" } },
  );
  expect(result).toMatchObject({ success: true });
  const binding =
    result && typeof result === "object"
      ? result.values?.navigationBinding
      : undefined;
  if (!isObjectRecord(binding))
    throw Error("Navigation action did not return its binding");
  expect(getCurrentViewState(f.runtime, scope)).toBeNull();
  await acknowledge(binding, true);
  expect(
    getCurrentViewState(f.runtime, scope)?.navigationConfirmation
      ?.resolvedAlias,
  ).toBe("workflows");
  await acknowledge((await prepare("chat")).navigationBinding);
  expect(
    getCurrentViewState(f.runtime, scope)?.navigationConfirmation?.previousView
      ?.resolvedAlias,
  ).toBe("workflows");
  expect(await context()).toContain('"preferredAlias":"workflows"');
  const retained = getCurrentViewState(f.runtime, scope)?.navigationConfirmation
    ?.previousView;
  if (!retained) throw Error("Missing acknowledged prior destination");
  retained.resolvedAlias = "retired-alias";
  expect(await context()).not.toContain('"preferredAlias"');
  expect(await context()).toContain('"id":"automations"');
  retained.resolvedAlias = "workflows";
  const back = message();
  const selection = await runWithViewClient(scope, async () => {
    viewNavigationField.handle!({
      runtime: f.runtime,
      message: back,
      senderRole: "OWNER",
      value: {
        disposition: "direct",
        viewId: "automations",
        reason: "Confirmed prior view",
      },
      turnSignal: new AbortController().signal,
    } as never);
    return viewNavigationEvaluator.evaluate({
      runtime: f.runtime,
      message: back,
      state: { data: { providers: {} } },
      userRoles: ["OWNER"],
      messageHandler: {
        processMessage: "RESPOND",
        plan: {
          contexts: ["general"],
          intents: ["Go back"],
          candidateActions: ["VIEWS_SHOW"],
          parentActionHints: [],
          replyEffectStatus: "pending",
          reply: "Going back.",
        },
      },
    } as never);
  });
  expect(selection?.deterministicToolCall).toEqual({
    name: "VIEWS",
    params: { action: "show", view: "workflows" },
  });
  // Unverified presentation strings never enter the existing confirmation store.
  for (const alias of ["unregistered-brand", "home"]) {
    await acknowledge((await prepare("automations", alias)).navigationBinding);
    expect(
      getCurrentViewState(f.runtime, scope)?.navigationConfirmation
        ?.resolvedAlias,
    ).toBeUndefined();
    await acknowledge((await prepare("chat")).navigationBinding);
    expect(await context()).not.toContain('"preferredAlias"');
  }
  // A same-view ack retains previous provenance; a manual switch clears it.
  await acknowledge(
    (await prepare("automations", "workflows")).navigationBinding,
  );
  await acknowledge((await prepare("chat")).navigationBinding);
  await acknowledge((await prepare("chat")).navigationBinding);
  expect(await context()).toContain('"preferredAlias":"workflows"');
  await post("/api/views/chat/navigate", {
    clientId: scope.clientId,
    source: "user",
  });
  expect(await context()).not.toContain('"preferredAlias"');
});
