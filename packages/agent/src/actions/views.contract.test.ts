import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, test } from "vitest";
import { promoteSubactionsToActions } from "../../../core/src/actions/promote-subactions.ts";
import { actionToTool } from "../../../core/src/actions/to-tool.ts";
import type { Action } from "../../../core/src/types/components.ts";
import type { Memory } from "../../../core/src/types/memory.ts";
import type { IAgentRuntime } from "../../../core/src/types/runtime.ts";

function fixture() {
  const source = readFileSync(new URL("./views.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(
    source
      .replace(/^import[\s\S]*?;\n/gm, "")
      .replace("export const viewsAction", "const viewsAction"),
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
