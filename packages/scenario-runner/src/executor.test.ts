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
