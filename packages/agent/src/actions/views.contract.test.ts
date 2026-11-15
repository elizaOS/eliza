import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, test } from "vitest";
import { promoteSubactionsToActions } from "../../../core/src/actions/promote-subactions.ts";
import { actionToTool } from "../../../core/src/actions/to-tool.ts";
import type { Action } from "../../../core/src/types/components.ts";
import type { Memory } from "../../../core/src/types/memory.ts";
import type { IAgentRuntime } from "../../../core/src/types/runtime.ts";
import {
  resolveViewNavigationTargets,
  viewEnabledByProfile,
  viewNavigationAvailable,
} from "../runtime/view-navigation-targets.ts";

function fixture(overrides: Record<string, unknown> = {}) {
  const source = readFileSync(new URL("./views.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(
    source.replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, ""),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    },
  ).outputText;
  let dispatches = 0;
  let owner = true;
  const ports = {
    resolveViewNavigationTargets,
    viewEnabledByProfile,
    viewNavigationAvailable,
    getDeviceActionTurn: () => undefined,
    randomUUID: () => "step",
    checkSenderRole: async () => ({ isOwner: owner, role: "OWNER" }),
    getStreamingContext: () => undefined,
    getTurnActionConstraint: () => undefined,
    isObjectRecord: (v: unknown) =>
      !!v && typeof v === "object" && !Array.isArray(v),
    satisfiesRoleGate: () => true,
    readViewInteractionClientId: () => undefined,
    createSelfApiRequestHeaders: () => ({}),
    resolveSelfApiBaseUrl: () => "http://fixture.invalid",
    dispatchApiRoute: async () => {
      dispatches++;
      throw Error("must not dispatch invalid input");
    },
    listViews: () => [
      { id: "notes", label: "Notes", path: "/notes" },
      { id: "chat", label: "Home", path: "/chat" },
    ],
    getViewClientScope: () => undefined,
    ...overrides,
  };
  const action = new Function(
    ...Object.keys(ports),
    js + ";return viewsAction;",
  )(...Object.values(ports)) as Action;
  return {
    action,
    deny: () => {
      owner = false;
    },
    get dispatches() {
      return dispatches;
    },
  };
}
test("canonical promoted VIEWS_SHOW tool requires destination while list and parent remain compatible", () => {
  const f = fixture();
  const promoted = promoteSubactionsToActions(f.action);
  const show = promoted.find((a) => a.name === "VIEWS_SHOW")!;
  const list = promoted.find((a) => a.name === "VIEWS_LIST")!;
  const schema = actionToTool(show).function.parameters;
  expect(schema).toMatchObject({
    required: expect.arrayContaining(["view"]),
    properties: { action: { enum: ["show"], default: "show" } },
  });
  expect(actionToTool(list).function.parameters.required ?? []).not.toContain(
    "view",
  );
  expect(f.action.parameters?.find((p) => p.name === "view")?.required).toBe(
    false,
  );
});
test("promoted show injects its canonical discriminator but never invents a missing destination", async () => {
  const f = fixture();
  const show = promoteSubactionsToActions(f.action).find(
    (a) => a.name === "VIEWS_SHOW",
  )!;
  const runtime = {} as IAgentRuntime,
    message = {
      id: "message",
      roomId: "room",
      entityId: "actor",
      content: {},
    } as Memory;
  const missing = await show.handler(runtime, message, undefined, {
    parameters: {},
  });
  expect(missing).toMatchObject({
    success: false,
    data: { navigation: { status: "invalid" } },
  });
  const specified = await show.handler(runtime, message, undefined, {
    parameters: { view: "notes" },
  });
  expect(specified).toMatchObject({
    success: false,
    data: { navigation: { status: "unavailable" } },
    text: expect.stringContaining("No originating renderer"),
  });
  expect(f.dispatches).toBe(0);
});
test("navigation owner and exact registered destination checks still fail closed", async () => {
  const f = fixture();
  const show = promoteSubactionsToActions(f.action).find(
    (a) => a.name === "VIEWS_SHOW",
  )!;
  const runtime = {} as IAgentRuntime,
    message = {
      id: "message",
      roomId: "room",
      entityId: "actor",
      content: {},
    } as Memory;
  const unknown = await show.handler(runtime, message, undefined, {
    parameters: { view: "invented" },
  });
  expect(unknown).toMatchObject({
    data: { navigation: { status: "not-found" } },
  });
  f.deny();
  const denied = await show.handler(runtime, message, undefined, {
    parameters: { view: "notes" },
  });
  expect(denied).toMatchObject({
    data: { navigation: { status: "forbidden" } },
  });
  expect(f.dispatches).toBe(0);
});

test("an enrolled phone's view profile narrows list and show to enabled screens", async () => {
  const runtime = {} as IAgentRuntime;
  const registry = [
    { id: "chat", label: "Home", path: "/chat", installationId: "i" },
    {
      id: "calendar",
      label: "Calendar",
      path: "/calendar",
      installationId: "i",
    },
    { id: "wallet", label: "Wallet", path: "/wallet", installationId: "i" },
    { id: "todos", label: "Todos", path: "/todos", available: false },
  ];
  let routes = 0;
  const device = (views?: string[]) =>
    fixture({
      listViews: () => registry,
      readViewInteractionClientId: () => "client",
      getViewClientScope: () => ({ request: {}, hostKey: {} }),
      getDeviceActionTurn: () =>
        views ? { runtime, viewProfile: { views } } : undefined,
      dispatchApiRoute: async (input: { path: string }) => {
        routes++;
        const viewId = decodeURIComponent(input.path.split("/")[3]);
        return {
          status: 200,
          body: {
            ok: true,
            viewId,
            status: "prepared",
            completedActionHandoffId: "step",
            navigationBinding: {
              requestId: "step",
              clientId: "client",
              viewId,
              viewType: "gui",
              installationId: "i",
            },
          },
        };
      },
    }).action;
  const message = {
    id: "message",
    roomId: "room",
    entityId: "actor",
    content: { metadata: { viewDelivery: "completed-action" } },
  } as unknown as Memory;
  const run = (action: Action, parameters: Record<string, string>) =>
    action.handler(runtime, message, undefined, { parameters });
  const ids = (result: unknown) =>
    (result as { data: { views: Array<{ id: string }> } }).data.views.map(
      (v) => v.id,
    );

  // "home" is the phone's id for the registry's chat view.
  const phone = device(["home", "calendar"]);
  expect(ids(await run(phone, { action: "list" }))).toEqual([
    "chat",
    "calendar",
  ]);
  expect(await run(phone, { action: "show", view: "wallet" })).toMatchObject({
    success: false,
    data: { navigation: { status: "not-found" } },
  });
  expect(routes).toBe(0);
  expect(await run(phone, { action: "show", view: "calendar" })).toMatchObject({
    success: true,
    values: { navigationPrepared: true, viewId: "calendar" },
  });
  expect(routes).toBe(1);
  // A profile listing the registry id itself also enables that view.
  expect(
    ids(await run(device(["chat", "calendar"]), { action: "list" })),
  ).toEqual(["chat", "calendar"]);

  // Off-device every role-permitted view remains; list still omits the
  // unavailable view that show would refuse.
  const desktop = device();
  expect(ids(await run(desktop, { action: "list" }))).toEqual([
    "chat",
    "calendar",
    "wallet",
  ]);
  expect(await run(desktop, { action: "show", view: "todos" })).toMatchObject({
    data: { navigation: { status: "unavailable" } },
  });
});
