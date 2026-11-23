import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, test } from "vitest";
import {
  readViewNavigationReceipt,
  requiredViewNavigationStatus,
} from "../../../../plugins/plugin-assistant/src/runtime/nav-evaluator-eligibility.ts";
import {
  actionResultToPlannerToolResult,
  runPlannerLoop,
} from "../../../../plugins/plugin-assistant/src/runtime/planner-loop.ts";
import {
  resolveViewNavigationTargets,
  viewEnabledByProfile,
  viewNavigationAvailable,
} from "../runtime/view-navigation-targets.ts";

function fixture({
  prepared = true,
  owner = true,
  badBinding = false,
  notesEditor = false,
  viewId = "automations",
  recordSource = "runtime",
} = {}) {
  const source = readFileSync(new URL("./views.ts", import.meta.url), "utf8");
  // Node 26 removed stripTypeScriptTypes' transform mode.
  const code = ts.transpileModule(
    source.replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, ""),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    },
  ).outputText;
  const id = "11111111-1111-4111-8111-111111111111";
  let dispatches = 0;
  const ports = {
    resolveViewNavigationTargets,
    viewEnabledByProfile,
    viewNavigationAvailable,
    getDeviceActionTurn: () => undefined,
    currentAppRecordSource: () => recordSource,
    randomUUID: () => id,
    checkSenderRole: async () => ({
      isOwner: owner,
      role: owner ? "OWNER" : "USER",
    }),
    getStreamingContext: () => undefined,
    getTurnActionConstraint: () => undefined,
    isObjectRecord: (v: unknown) =>
      !!v && typeof v === "object" && !Array.isArray(v),
    satisfiesRoleGate: () => true,
    readViewInteractionClientId: () => "client",
    createSelfApiRequestHeaders: () => ({}),
    resolveSelfApiBaseUrl: () => "http://fixture.invalid",
    getViewClientScope: () => ({ request: {}, hostKey: {} }),
    listViews: () => [
      {
        id: viewId,
        label: viewId === "notes" ? "Notes" : "Workflows",
        path: "/" + viewId,
        installationId: "installed",
      },
    ],
    dispatchApiRoute: async () => {
      dispatches++;
      return {
        status: 200,
        body: {
          ok: true,
          viewId,
          completedActionHandoffId: id,
          ...(prepared
            ? {
                status: "prepared",
                navigationBinding: {
                  requestId: id,
                  clientId: badBinding ? "wrong" : "client",
                  viewId,
                  viewType: "gui",
                  installationId: "installed",
                },
              }
            : { completedActionDelivered: true }),
        },
      };
    },
  };
  const action = new Function(
    ...Object.keys(ports),
    code + ";return viewsAction;",
  )(...Object.values(ports));
  return {
    run: (noteId?: string) =>
      action.handler(
        {
          getService: () => ({
            snapshot: () => ({
              notes: [
                {
                  id: "saved-note",
                  title: "Private title",
                  body: "Private text",
                },
              ],
            }),
          }),
        },
        {
          id: "message",
          roomId: "room",
          entityId: "owner",
          content: {
            metadata: {
              ...(prepared ? { viewDelivery: "completed-action" } : {}),
              ...(notesEditor ? { notesEditorNavigation: 1 } : {}),
            },
          },
        },
        undefined,
        {
          parameters: {
            action: "show",
            view: viewId,
            ...(noteId === undefined ? {} : { noteId }),
          },
        },
      ),
    dispatches: () => dispatches,
  };
}
test("only an exact prepared VIEWS action carries the external execution marker through planner conversion", async () => {
  for (const prepared of [false, true]) {
    const f = fixture({ prepared });
    const result = await f.run();
    expect(result.success).toBe(true);
    expect(result.data.awaitingDeviceExecution).toBe(
      prepared ? true : undefined,
    );
    expect(result.values.awaitingDeviceExecution).toBeUndefined();
    expect(
      actionResultToPlannerToolResult(result).data?.awaitingDeviceExecution,
    ).toBe(prepared ? true : undefined);
    expect(f.dispatches()).toBe(1);
  }
});
test("prepares only the saved note ID for a supported canonical Notes editor", async () => {
  const f = fixture({ viewId: "notes", notesEditor: true });
  const result = await f.run("saved-note");
  expect(result).toMatchObject({
    success: true,
    values: { noteId: "saved-note", viewId: "notes", navigationPrepared: true },
    data: {
      awaitingDeviceExecution: true,
      navigation: { noteId: "saved-note", status: "prepared" },
    },
  });
  const projected = actionResultToPlannerToolResult(result);
  expect(projected.data?.values).toMatchObject({
    noteId: "saved-note",
  });
  const step = {
    toolCall: {
      name: "VIEWS_SHOW",
      params: { view: "notes", noteId: "saved-note" },
    },
    result: projected,
  };
  expect(readViewNavigationReceipt(step as never)?.status).toBe("prepared");
  expect(
    readViewNavigationReceipt({
      ...step,
      toolCall: {
        ...step.toolCall,
        params: { ...step.toolCall.params, noteId: "another-note" },
      },
    } as never),
  ).toBeUndefined();
  const required = {
    context: {
      metadata: {
        requiredViewNavigation: {
          viewId: "notes",
          clientId: "client",
          installationId: "installed",
          noteEditor: true,
        },
      },
    },
    archivedSteps: [],
    steps: [step],
  };
  expect(requiredViewNavigationStatus(required as never)).toBe("prepared");
  const list = await fixture({ viewId: "notes", notesEditor: true }).run();
  expect(
    requiredViewNavigationStatus({
      ...required,
      steps: [
        {
          toolCall: { name: "VIEWS_SHOW", params: { view: "notes" } },
          result: actionResultToPlannerToolResult(list),
        },
      ],
    } as never),
  ).toBe("missing");
  expect(JSON.stringify(result)).not.toContain("Private text");
  expect(f.dispatches()).toBe(1);
});
test("keeps absent, foreign and unsupported editor targets out of delivery", async () => {
  for (const [options, id] of [
    [{ notesEditor: true }, "saved-note"],
    [{ viewId: "notes", notesEditor: true }, "missing-note"],
    [{ viewId: "notes" }, "saved-note"],
    [
      { viewId: "notes", notesEditor: true, recordSource: "device" },
      "saved-note",
    ],
  ] as const) {
    const f = fixture(options);
    expect((await f.run(id)).success).toBe(false);
    expect(f.dispatches()).toBe(0);
  }
});
test("prepared phase reaches partial FINISH after evaluator CONTINUE without executing navigation again", async () => {
  const f = fixture(),
    result = actionResultToPlannerToolResult(await f.run());
  let executions = 0,
    evaluations = 0;
  const prompts: string[] = [];
  const out = await runPlannerLoop({
    codingMode: false,
    context: {
      id: "prepared-nav",
      events: [
        {
          id: "user",
          type: "message",
          source: "user",
          createdAt: 1,
          message: { role: "user", content: "Open Workflows" },
        },
      ],
    },
    postToolReplySeed: {
      toolCall: {
        id: "show",
        name: "VIEWS_SHOW",
        params: { view: "automations" },
      },
      result,
    },
    runtime: {
      useModel: async (_type: unknown, params: unknown) => {
        prompts.push(JSON.stringify(params));
        return { text: "Opening Workflows.", toolCalls: [] };
      },
    },
    executeToolCall: async () => {
      executions++;
      throw Error("Prepared action must not repeat");
    },
    evaluate: async () => {
      evaluations++;
      return {
        decision: "CONTINUE",
        success: true,
        thought: "",
        messageToUser: "Opening Workflows.",
        requestFullyCovered: false,
        replyEffectStatus: "non_applied",
      };
    },
  } as never);
  expect(out.status).toBe("finished");
  expect(out.evaluator).toMatchObject({
    decision: "FINISH",
    success: false,
    requestFullyCovered: false,
    replyEffectStatus: "non_applied",
  });
  expect(out.finalMessage).toBe("Opening Workflows.");
  expect(executions).toBe(0);
  expect(evaluations).toBe(1);
  expect(f.dispatches()).toBe(1);
  expect(prompts.join("\n")).toContain(
    "navigation is prepared for the originating renderer",
  );
  expect(prompts.join("\n")).not.toContain("already settled and complete");
});
test("owner and exact returned binding failures remain unmarked and refused", async () => {
  for (const options of [{ owner: false }, { badBinding: true }]) {
    const f = fixture(options),
      result = await f.run();
    expect(result.success).toBe(false);
    expect(result.data?.awaitingDeviceExecution).toBeUndefined();
    if (options.owner === false) expect(f.dispatches()).toBe(0);
  }
});
