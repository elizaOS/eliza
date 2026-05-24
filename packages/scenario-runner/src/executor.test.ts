import type {
  Action,
  AgentRuntime,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runScenario } from "./executor";

function createRuntime(actions: Action[]): AgentRuntime {
  return {
    actions,
    routes: [],
    ensureConnection: vi.fn(async () => undefined),
    getService: vi.fn(() => null),
    setSetting: vi.fn(),
  } as unknown as AgentRuntime;
}

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
    const runtime = createRuntime([
      {
        name: "VIEWS",
        description: "test action",
        validate,
        handler,
      } as Action,
    ]);

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
    const runtime = createRuntime([
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
    ]);

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
    expect(report.turns[0]?.failedAssertions).toEqual([
      'responseIncludesAny: expected response to include any of [opened remote-ledger], saw "opened local-notes instead"',
    ]);
  });

  it("reports expected and actual action arguments for selectedActionArguments failures", async () => {
    const runtime = createRuntime([
      {
        name: "VIEWS",
        description: "test action",
        validate: vi.fn(async () => true),
        handler: vi.fn(async () => ({
          success: true,
          text: "opened local notes",
        })),
      } as Action,
    ]);

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
        'actionCalled: expected at least one VIEWS call with result.success=true, saw {"actionName":"VIEWS","parameters":{"action":"pin","view":"remote-ledger"},"result":{"success":false,"text":"failed to open remote ledger","data":{"reason":"view missing"}}}',
    });
  });
});
