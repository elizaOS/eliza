import type {
  Action,
  AgentRuntime,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runScenario } from "./executor";

function createRuntime(
  actions: Action[],
  overrides: Partial<AgentRuntime> = {},
): AgentRuntime {
  return {
    actions,
    routes: [],
    ensureConnection: vi.fn(async () => undefined),
    getService: vi.fn(() => null),
    setSetting: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  } as unknown as AgentRuntime;
}

describe("scenario executor wait turns", () => {
  it("waits for the requested duration without sending a message", async () => {
    const handleMessage = vi.fn();
    const runtime = {
      ...createRuntime([], {
        useModel: vi.fn() as AgentRuntime["useModel"],
      }),
      messageService: { handleMessage },
    } as unknown as AgentRuntime;

    const report = await runScenario(
      {
        id: "wait-turn",
        title: "Wait turn",
        domain: "executor",
        turns: [
          {
            kind: "wait",
            name: "settle",
            durationMs: 5,
            expectedStatus: 200,
            assertResponse(status, body) {
              if (status !== 200) {
                return `expected status 200, saw ${status}`;
              }
              if (
                !body ||
                typeof body !== "object" ||
                (body as { durationMs?: unknown }).durationMs !== 5
              ) {
                return "expected wait response body to include durationMs";
              }
              return undefined;
            },
            assertTurn(turn) {
              if (turn.statusCode !== 200) {
                return `expected statusCode 200, saw ${turn.statusCode}`;
              }
              return undefined;
            },
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("passed");
    expect(handleMessage).not.toHaveBeenCalled();
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(report.turns[0]).toMatchObject({
      kind: "wait",
      responseText: '{"success":true,"durationMs":5}',
      actionsCalled: [],
      failedAssertions: [],
    });
    expect(report.turns[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fails wait turns without a non-negative durationMs", async () => {
    const report = await runScenario(
      {
        id: "invalid-wait-turn",
        title: "Invalid wait turn",
        domain: "executor",
        turns: [
          {
            kind: "wait",
            name: "bad wait",
            durationMs: -1,
          },
        ],
      },
      createRuntime([]),
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(report.error).toContain("requires non-negative durationMs");
  });
});

describe("scenario executor action turns", () => {
  it("executes a registered action turn with real options and captures its trace", async () => {
    const validate = vi.fn(async () => true);
    const handler = vi.fn(
      async (
        _runtime: IAgentRuntime,
        message: Memory,
        _state: unknown,
        options: Record<string, unknown> | undefined,
        callback: HandlerCallback | undefined,
      ) => {
        await callback?.({ text: `opened ${String(options?.view)}` });
        return {
          success: true,
          text: "handler fallback text",
          data: {
            action: message.content.action,
            source: message.content.source,
            view: options?.view,
          },
        };
      },
    );
    const runtime = createRuntime(
      [
        {
          name: "VIEWS",
          description: "test action",
          validate,
          handler,
        } as Action,
      ],
      {
        useModel: vi.fn() as AgentRuntime["useModel"],
      },
    );

    const report = await runScenario(
      {
        id: "action-turn",
        title: "Action turn",
        domain: "executor",
        rooms: [{ id: "main", source: "telegram", title: "Action User" }],
        turns: [
          {
            kind: "action",
            name: "open view",
            text: "open the remote ledger view",
            actionName: "VIEWS",
            options: { action: "pin", view: "remote-ledger" },
            responseIncludesAny: ["opened remote-ledger"],
          },
        ],
        finalChecks: [
          { type: "actionCalled", actionName: "VIEWS", minCount: 1 },
          {
            type: "selectedActionArguments",
            actionName: "VIEWS",
            includesAll: [/pin/, /remote-ledger/],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("passed");
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        content: expect.objectContaining({
          action: "VIEWS",
          source: "telegram",
          text: "open the remote ledger view",
        }),
      }),
      undefined,
      { action: "pin", view: "remote-ledger" },
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(report.turns[0]).toMatchObject({
      kind: "action",
      responseText: "opened remote-ledger",
      actionsCalled: [
        {
          actionName: "VIEWS",
          parameters: { action: "pin", view: "remote-ledger" },
          result: {
            success: true,
            text: "handler fallback text",
          },
        },
      ],
      failedAssertions: [],
    });
  });

  it("fails action turns that do not name an action", async () => {
    const report = await runScenario(
      {
        id: "missing-action",
        title: "Missing action",
        domain: "executor",
        turns: [{ kind: "action", name: "missing" }],
      },
      createRuntime([]),
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(report.error).toContain("missing actionName");
  });

  it("fails action turns when validation rejects the turn", async () => {
    const runtime = createRuntime([
      {
        name: "VIEWS",
        description: "test action",
        validate: vi.fn(async () => false),
        handler: vi.fn(async () => ({ success: true })),
      } as Action,
    ]);

    const report = await runScenario(
      {
        id: "invalid-action",
        title: "Invalid action",
        domain: "executor",
        turns: [{ kind: "action", name: "invalid", actionName: "VIEWS" }],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(report.error).toContain("failed validation");
    expect(runtime.actions[0].handler).not.toHaveBeenCalled();
  });

  it("reports expected and actual response text for responseIncludesAny failures", async () => {
    const runtime = createRuntime(
      [
        {
          name: "VIEWS",
          description: "test action",
          validate: vi.fn(async () => true),
          handler: vi.fn(
            async (_runtime, _message, _state, _options, callback) => {
              await callback?.({ text: "opened local-notes instead" });
              return { success: true };
            },
          ),
        } as Action,
      ],
      {
        useModel: vi.fn() as AgentRuntime["useModel"],
      },
    );

    const report = await runScenario(
      {
        id: "response-includes-any-failure",
        title: "Response includes any failure",
        domain: "executor",
        turns: [
          {
            kind: "action",
            name: "open view",
            actionName: "VIEWS",
            responseIncludesAny: ["opened remote-ledger"],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(report.turns[0]?.failedAssertions).toEqual([
      'responseIncludesAny: expected response to include any of [opened remote-ledger], saw "opened local-notes instead"',
    ]);
  });

  it("matches RegExp patterns in responseIncludesAny assertions", async () => {
    const runtime = createRuntime(
      [
        {
          name: "VIEWS",
          description: "test action",
          validate: vi.fn(async () => true),
          handler: vi.fn(
            async (_runtime, _message, _state, _options, callback) => {
              await callback?.({
                text: "Please clarify which ledger you want opened.",
              });
              return { success: true };
            },
          ),
        } as Action,
      ],
      {
        useModel: vi.fn() as AgentRuntime["useModel"],
      },
    );

    const report = await runScenario(
      {
        id: "response-includes-any-regexp-pass",
        title: "Response includes any RegExp pass",
        domain: "executor",
        turns: [
          {
            kind: "action",
            name: "open view",
            actionName: "VIEWS",
            responseIncludesAny: [/clarif/i],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("passed");
    expect(report.turns[0]?.failedAssertions).toEqual([]);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("reports expected and actual response text for responseIncludesAny RegExp failures", async () => {
    const runtime = createRuntime(
      [
        {
          name: "VIEWS",
          description: "test action",
          validate: vi.fn(async () => true),
          handler: vi.fn(
            async (_runtime, _message, _state, _options, callback) => {
              await callback?.({ text: "opened local notes instead" });
              return { success: true };
            },
          ),
        } as Action,
      ],
      {
        useModel: vi.fn() as AgentRuntime["useModel"],
      },
    );

    const report = await runScenario(
      {
        id: "response-includes-any-regexp-failure",
        title: "Response includes any RegExp failure",
        domain: "executor",
        turns: [
          {
            kind: "action",
            name: "open view",
            actionName: "VIEWS",
            responseIncludesAny: [/remote[- ]ledger/i],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(report.turns[0]?.failedAssertions).toEqual([
      'responseIncludesAny: expected response to include any of [/remote[- ]ledger/i], saw "opened local notes instead"',
    ]);
  });

  it("passes when every responseIncludesAll pattern is present", async () => {
    const runtime = createRuntime(
      [
        {
          name: "VIEWS",
          description: "test action",
          validate: vi.fn(async () => true),
          handler: vi.fn(
            async (_runtime, _message, _state, _options, callback) => {
              await callback?.({ text: "Saved your workout reminder." });
              return { success: true };
            },
          ),
        } as Action,
      ],
      {
        useModel: vi.fn() as AgentRuntime["useModel"],
      },
    );

    const report = await runScenario(
      {
        id: "response-includes-all-pass",
        title: "Response includes all pass",
        domain: "executor",
        turns: [
          {
            kind: "action",
            name: "save reminder",
            actionName: "VIEWS",
            responseIncludesAll: ["saved", /workout/i],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("passed");
    expect(report.turns[0]?.failedAssertions).toEqual([]);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("reports expected and actual response text for responseIncludesAll failures", async () => {
    const runtime = createRuntime(
      [
        {
          name: "VIEWS",
          description: "test action",
          validate: vi.fn(async () => true),
          handler: vi.fn(
            async (_runtime, _message, _state, _options, callback) => {
              await callback?.({ text: "opened local-notes instead" });
              return { success: true };
            },
          ),
        } as Action,
      ],
      {
        useModel: vi.fn() as AgentRuntime["useModel"],
      },
    );

    const report = await runScenario(
      {
        id: "response-includes-all-failure",
        title: "Response includes all failure",
        domain: "executor",
        turns: [
          {
            kind: "action",
            name: "open view",
            actionName: "VIEWS",
            responseIncludesAll: ["opened", "remote-ledger"],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(report.turns[0]?.failedAssertions).toEqual([
      'responseIncludesAll: expected response to include remote-ledger, saw "opened local-notes instead"',
    ]);
  });

  it("passes when responseExcludes patterns are absent from the response", async () => {
    const runtime = createRuntime(
      [
        {
          name: "REMINDERS",
          description: "test action",
          validate: vi.fn(async () => true),
          handler: vi.fn(
            async (_runtime, _message, _state, _options, callback) => {
              await callback?.({
                text: "I kept the reminder active and adjusted the cadence.",
              });
              return { success: true };
            },
          ),
        } as Action,
      ],
      {
        useModel: vi.fn() as AgentRuntime["useModel"],
      },
    );

    const report = await runScenario(
      {
        id: "response-excludes-pass",
        title: "Response excludes pass",
        domain: "executor",
        turns: [
          {
            kind: "action",
            name: "adjust reminder",
            actionName: "REMINDERS",
            responseExcludes: ["disabled", /delet(ed|e)/i],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("passed");
    expect(report.turns[0]?.failedAssertions).toEqual([]);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("reports forbidden string and RegExp hits for responseExcludes failures", async () => {
    const runtime = createRuntime(
      [
        {
          name: "REMINDERS",
          description: "test action",
          validate: vi.fn(async () => true),
          handler: vi.fn(
            async (_runtime, _message, _state, _options, callback) => {
              await callback?.({
                text: "I disabled the reminder and deleted the follow-up.",
              });
              return { success: true };
            },
          ),
        } as Action,
      ],
      {
        useModel: vi.fn() as AgentRuntime["useModel"],
      },
    );

    const report = await runScenario(
      {
        id: "response-excludes-failure",
        title: "Response excludes failure",
        domain: "executor",
        turns: [
          {
            kind: "action",
            name: "adjust reminder",
            actionName: "REMINDERS",
            responseExcludes: ["disabled", /delet(ed|e)/i],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(report.turns[0]?.failedAssertions).toEqual([
      'responseExcludes: response included forbidden pattern(s) [disabled,/delet(ed|e)/i], saw "I disabled the reminder and deleted the follow-up."',
    ]);
  });

  it("enforces planner includes and excludes against the captured selected action trace", async () => {
    const runtime = createRuntime(
      [
        {
          name: "VIEWS",
          description: "test action",
          validate: vi.fn(async () => true),
          handler: vi.fn(
            async (_runtime, _message, _state, options, callback) => {
              await callback?.({ text: `opened ${String(options?.view)}` });
              return {
                success: true,
                data: {
                  route: "finance",
                  view: options?.view,
                },
              };
            },
          ),
        } as Action,
      ],
      {
        useModel: vi.fn() as AgentRuntime["useModel"],
      },
    );

    const report = await runScenario(
      {
        id: "planner-matchers-pass",
        title: "Planner matchers pass",
        domain: "executor",
        turns: [
          {
            kind: "action",
            name: "open view",
            text: "open the remote ledger view",
            actionName: "VIEWS",
            options: { action: "pin", view: "remote-ledger" },
            plannerIncludesAll: ["VIEWS", "remote-ledger"],
            plannerIncludesAny: ["finance", "dashboard"],
            plannerExcludes: ["calendar_action"],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("passed");
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(report.turns[0]?.failedAssertions).toEqual([]);
  });

  it("reports planner matcher failures with the captured selected action trace", async () => {
    const runtime = createRuntime(
      [
        {
          name: "VIEWS",
          description: "test action",
          validate: vi.fn(async () => true),
          handler: vi.fn(async () => ({
            success: true,
            text: "opened local notes",
          })),
        } as Action,
      ],
      {
        useModel: vi.fn() as AgentRuntime["useModel"],
      },
    );

    const report = await runScenario(
      {
        id: "planner-matchers-fail",
        title: "Planner matchers fail",
        domain: "executor",
        turns: [
          {
            kind: "action",
            name: "open view",
            actionName: "VIEWS",
            options: { action: "pin", view: "local-notes" },
            plannerIncludesAll: ["remote-ledger"],
            plannerIncludesAny: ["finance", "remote-ledger"],
            plannerExcludes: ["local-notes"],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(report.turns[0]?.failedAssertions).toEqual([
      'plannerIncludesAll: expected planner trace to include remote-ledger, saw "VIEWS {\\"action\\":\\"pin\\",\\"view\\":\\"local-notes\\"} opened local notes"',
      'plannerIncludesAny: expected planner trace to include any of [finance,remote-ledger], saw "VIEWS {\\"action\\":\\"pin\\",\\"view\\":\\"local-notes\\"} opened local notes"',
      'plannerExcludes: expected planner trace to exclude [local-notes], saw "VIEWS {\\"action\\":\\"pin\\",\\"view\\":\\"local-notes\\"} opened local notes"',
    ]);
  });

  it("does not satisfy planner matchers with a synthesized REPLY trace", async () => {
    const runtime = {
      ...createRuntime([]),
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback({
            text: "I can talk about remote-ledger, but I did not select an action.",
          });
          return {};
        }),
      },
    } as unknown as AgentRuntime;

    const report = await runScenario(
      {
        id: "planner-matchers-synthesized-reply",
        title: "Planner matchers synthesized reply",
        domain: "executor",
        rooms: [{ id: "main", source: "telegram", title: "Action User" }],
        turns: [
          {
            kind: "message",
            name: "free text only",
            text: "open remote ledger",
            plannerIncludesAll: ["REPLY", "remote-ledger"],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(report.turns[0]?.actionsCalled[0]).toMatchObject({
      actionName: "REPLY",
      result: { data: { source: "synthesized-reply" } },
    });
    expect(report.turns[0]?.failedAssertions).toEqual([
      'plannerIncludesAll: expected planner trace to include REPLY, saw ""',
    ]);
  });

  it("matches expectedActions against the action selected during the turn", async () => {
    const runtime = createRuntime(
      [
        {
          name: "CALENDAR_CREATE_EVENT",
          description: "test action",
          validate: vi.fn(async () => true),
          handler: vi.fn(
            async (_runtime, _message, _state, _options, callback) => {
              await callback?.({ text: "created calendar event" });
              return { success: true };
            },
          ),
        } as Action,
      ],
      {
        useModel: vi.fn() as AgentRuntime["useModel"],
      },
    );

    const report = await runScenario(
      {
        id: "expected-actions-pass",
        title: "Expected actions pass",
        domain: "executor",
        turns: [
          {
            kind: "action",
            name: "create event",
            actionName: "CALENDAR_CREATE_EVENT",
            expectedActions: ["CALENDAR_CREATE"],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("passed");
    expect(report.turns[0]?.failedAssertions).toEqual([]);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("reports expected and actual action names for expectedActions failures", async () => {
    const runtime = createRuntime(
      [
        {
          name: "VIEWS",
          description: "test action",
          validate: vi.fn(async () => true),
          handler: vi.fn(
            async (_runtime, _message, _state, _options, callback) => {
              await callback?.({ text: "opened local notes" });
              return { success: true };
            },
          ),
        } as Action,
      ],
      {
        useModel: vi.fn() as AgentRuntime["useModel"],
      },
    );

    const report = await runScenario(
      {
        id: "expected-actions-failure",
        title: "Expected actions failure",
        domain: "executor",
        turns: [
          {
            kind: "action",
            name: "schedule",
            actionName: "VIEWS",
            expectedActions: ["CALENDAR"],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(report.turns[0]?.failedAssertions).toEqual([
      "expectedActions: expected action in [CALENDAR], saw actions [VIEWS]",
    ]);
  });

  it("does not satisfy expectedActions with a synthesized REPLY", async () => {
    const runtime = {
      ...createRuntime([]),
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback({
            text: "I replied in plain text without selecting an action.",
          });
          return {};
        }),
      },
    } as unknown as AgentRuntime;

    const report = await runScenario(
      {
        id: "expected-actions-synthesized-reply",
        title: "Expected actions synthesized reply",
        domain: "executor",
        turns: [
          {
            kind: "message",
            name: "plain reply",
            text: "say hello",
            expectedActions: ["REPLY"],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(report.turns[0]?.actionsCalled[0]).toMatchObject({
      actionName: "REPLY",
      result: { data: { source: "synthesized-reply" } },
    });
    expect(report.turns[0]?.failedAssertions).toEqual([
      "expectedActions: expected action in [REPLY], saw actions [(none)]; captured actions: [REPLY]",
    ]);
  });

  it("uses action callback output directly before scenario assertions", async () => {
    const runtime = createRuntime(
      [
        {
          name: "VIEWS",
          description: "test action",
          validate: vi.fn(async () => true),
          handler: vi.fn(
            async (_runtime, _message, _state, _options, callback) => {
              await callback?.({ text: "stdout: opened view=remote-ledger" });
              return { success: true };
            },
          ),
        } as Action,
      ],
      {
        character: { name: "Example" } as AgentRuntime["character"],
        useModel: vi.fn() as AgentRuntime["useModel"],
      },
    );

    const report = await runScenario(
      {
        id: "action-turn-direct-output",
        title: "Action turn direct output",
        domain: "executor",
        turns: [
          {
            kind: "action",
            name: "open view",
            actionName: "VIEWS",
            responseIncludesAny: ["stdout: opened view=remote-ledger"],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("passed");
    expect(report.turns[0]?.responseText).toBe(
      "stdout: opened view=remote-ledger",
    );
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("reports expected and actual action arguments for selectedActionArguments failures", async () => {
    const runtime = createRuntime(
      [
        {
          name: "VIEWS",
          description: "test action",
          validate: vi.fn(async () => true),
          handler: vi.fn(async () => ({
            success: true,
            text: "opened local notes",
          })),
        } as Action,
      ],
      {
        useModel: vi.fn() as AgentRuntime["useModel"],
      },
    );

    const report = await runScenario(
      {
        id: "selected-action-arguments-failure",
        title: "Selected action arguments failure",
        domain: "executor",
        rooms: [{ id: "main", source: "telegram", title: "Action User" }],
        turns: [
          {
            kind: "action",
            name: "open view",
            actionName: "VIEWS",
            options: { action: "pin", view: "local-notes" },
          },
        ],
        finalChecks: [
          {
            type: "selectedActionArguments",
            actionName: "VIEWS",
            includesAll: [/remote-ledger/],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(report.failedAssertions).toContainEqual({
      label: "selectedActionArguments",
      detail:
        'selectedActionArguments: expected arguments to include /remote-ledger/, saw "VIEWS {\\"action\\":\\"pin\\",\\"view\\":\\"local-notes\\"} opened local notes"',
    });
  });

  it("reports expected and actual action names when selectedActionArguments matches no action", async () => {
    const report = await runScenario(
      {
        id: "selected-action-arguments-no-action",
        title: "Selected action arguments no action",
        domain: "executor",
        turns: [],
        finalChecks: [
          {
            type: "selectedActionArguments",
            actionName: "VIEWS",
            includesAll: [/remote-ledger/],
          },
        ],
      },
      createRuntime([]),
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(report.failedAssertions).toContainEqual({
      label: "selectedActionArguments",
      detail:
        "selectedActionArguments: expected action in [VIEWS], saw actions [(none)]",
    });
  });

  it("does not satisfy selectedActionArguments with a synthesized REPLY", async () => {
    const runtime = {
      ...createRuntime([]),
      messageService: {
        handleMessage: vi.fn(async (_runtime, _message, callback) => {
          await callback({
            text: "I can talk about remote-ledger, but I did not select REPLY.",
          });
          return {};
        }),
      },
    } as unknown as AgentRuntime;

    const report = await runScenario(
      {
        id: "selected-action-arguments-synthesized-reply",
        title: "Selected action arguments synthesized reply",
        domain: "executor",
        rooms: [{ id: "main", source: "telegram", title: "Action User" }],
        turns: [
          {
            kind: "message",
            name: "free text only",
            text: "open remote ledger",
          },
        ],
        finalChecks: [
          {
            type: "selectedActionArguments",
            actionName: "REPLY",
            includesAll: [/remote-ledger/],
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(report.turns[0]?.actionsCalled[0]).toMatchObject({
      actionName: "REPLY",
      result: { data: { source: "synthesized-reply" } },
    });
    expect(report.failedAssertions).toContainEqual({
      label: "selectedActionArguments",
      detail:
        "selectedActionArguments: expected action in [REPLY], saw actions [REPLY]",
    });
  });

  it("reports expected and actual action results for actionCalled success failures", async () => {
    const runtime = createRuntime([
      {
        name: "VIEWS",
        description: "test action",
        validate: vi.fn(async () => true),
        handler: vi.fn(async () => ({
          success: false,
          text: "failed to open remote ledger",
          data: { reason: "view missing" },
        })),
      } as Action,
    ]);

    const report = await runScenario(
      {
        id: "action-called-success-failure",
        title: "Action called success failure",
        domain: "executor",
        rooms: [{ id: "main", source: "telegram", title: "Action User" }],
        turns: [
          {
            kind: "action",
            name: "open view",
            actionName: "VIEWS",
            options: { action: "pin", view: "remote-ledger" },
          },
        ],
        finalChecks: [
          { type: "actionCalled", actionName: "VIEWS", status: "success" },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(report.failedAssertions).toContainEqual({
      label: "actionCalled",
      detail:
        'actionCalled: expected 1 successful VIEWS call(s) with result.success=true, saw 0. Calls: {"actionName":"VIEWS","parameters":{"action":"pin","view":"remote-ledger"},"result":{"success":false,"text":"failed to open remote ledger","data":{"reason":"view missing"}}}',
    });
  });

  it("requires minCount successful actionCalled results when status is success", async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        text: "first attempt failed",
      })
      .mockResolvedValueOnce({
        success: true,
        text: "second attempt worked",
      });
    const runtime = createRuntime([
      {
        name: "VIEWS",
        description: "test action",
        validate: vi.fn(async () => true),
        handler,
      } as unknown as Action,
    ]);

    const report = await runScenario(
      {
        id: "action-called-success-min-count",
        title: "Action called success min count",
        domain: "executor",
        rooms: [{ id: "main", source: "telegram", title: "Action User" }],
        turns: [
          {
            kind: "action",
            name: "open view first",
            actionName: "VIEWS",
            options: { action: "pin", view: "remote-ledger" },
          },
          {
            kind: "action",
            name: "open view second",
            actionName: "VIEWS",
            options: { action: "pin", view: "settings" },
          },
        ],
        finalChecks: [
          {
            type: "actionCalled",
            actionName: "VIEWS",
            status: "success",
            minCount: 2,
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(handler).toHaveBeenCalledTimes(2);
    expect(report.failedAssertions).toContainEqual({
      label: "actionCalled",
      detail:
        'actionCalled: expected 2 successful VIEWS call(s) with result.success=true, saw 1. Calls: {"actionName":"VIEWS","parameters":{"action":"pin","view":"remote-ledger"},"result":{"success":false,"text":"first attempt failed"}} | {"actionName":"VIEWS","parameters":{"action":"pin","view":"settings"},"result":{"success":true,"text":"second attempt worked"}}',
    });
  });
});
