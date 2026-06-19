import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ChannelContribution } from "../src/lifeops/channels/contract.js";
import { registerDefaultChannelPack } from "../src/lifeops/channels/default-pack.js";
import {
  createChannelRegistry,
  registerChannelRegistry,
} from "../src/lifeops/channels/index.js";
import type { DispatchResult } from "../src/lifeops/connectors/contract.js";
import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "../src/lifeops/scheduled-task/completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "../src/lifeops/scheduled-task/consolidation-policy.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "../src/lifeops/scheduled-task/escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "../src/lifeops/scheduled-task/gate-registry.js";
import {
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
} from "../src/lifeops/scheduled-task/runner.js";
import { createProductionScheduledTaskDispatcher } from "../src/lifeops/scheduled-task/runtime-wiring.js";
import { createInMemoryScheduledTaskLogStore } from "../src/lifeops/scheduled-task/state-log.js";
import type { ScheduledTask } from "../src/lifeops/scheduled-task/types.js";
import {
  createSendPolicyRegistry,
  registerSendPolicyRegistry,
} from "../src/lifeops/send-policy/index.js";
import {
  deliverPrivateSensitiveRequest,
  type LifeOpsSensitiveRequestDeliveryRecord,
} from "../src/lifeops/sensitive-request-delivery.js";

function sendCapableChannel(
  send: ChannelContribution["send"],
): ChannelContribution {
  return {
    kind: "telegram",
    describe: { label: "Telegram" },
    capabilities: {
      send: true,
      read: true,
      reminders: true,
      voice: false,
      attachments: true,
      quietHoursAware: true,
    },
    send,
  };
}

const request: LifeOpsSensitiveRequestDeliveryRecord = {
  id: "sr_123",
  kind: "secret",
  status: "pending",
  delivery: {
    kind: "secret",
    mode: "cloud_authenticated_link",
    privateRouteRequired: true,
    publicLinkAllowed: false,
    authenticated: true,
    linkBaseUrl: "https://cloud.example",
  },
  expiresAt: "2026-05-10T13:00:00.000Z",
};

const baseTask = (
  overrides: Partial<Omit<ScheduledTask, "taskId" | "state">> = {},
): Omit<ScheduledTask, "taskId" | "state"> => ({
  kind: "reminder",
  promptInstructions: "Open the private request to continue.",
  trigger: { kind: "manual" },
  priority: "low",
  respectsGlobalPause: true,
  source: "user_chat",
  createdBy: "tester",
  ownerVisible: true,
  ...overrides,
});

function makeRunner(runtime: IAgentRuntime) {
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);

  return createScheduledTaskRunner({
    agentId: "agent-test",
    store: createInMemoryScheduledTaskStore(),
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    ownerFacts: async () => ({}),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: createProductionScheduledTaskDispatcher({ runtime }),
    channelKeys: () => new Set(["telegram"]),
    newTaskId: () => "task_sensitive_request",
    now: () => new Date("2026-05-10T12:00:00.000Z"),
  });
}

describe("sensitive request private delivery", () => {
  it("sends a private DM payload and returns status-only public success text", async () => {
    const sent: unknown[] = [];
    const channel = sendCapableChannel(async (payload) => {
      sent.push(payload);
      return { ok: true, messageId: "dm_1" };
    });

    const result = await deliverPrivateSensitiveRequest({
      request,
      channel,
      target: "owner-dm",
      form: {
        type: "sensitive_request_form",
        kind: "secret",
        mode: "inline_owner_app",
        fields: [
          {
            name: "OPENAI_API_KEY",
            label: "OPENAI_API_KEY",
            input: "secret",
            required: true,
          },
        ],
        submitLabel: "Save secret",
        statusOnly: true,
      },
    });

    expect(result.dispatchResult).toEqual({ ok: true, messageId: "dm_1" });
    expect(result.publicStatusText).toBe("I sent a private setup request.");
    expect(result.publicStatusText).not.toContain("https://cloud.example");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      target: "owner-dm",
      metadata: {
        sensitiveRequest: {
          id: "sr_123",
          kind: "secret",
          status: "pending",
        },
        form: {
          type: "sensitive_request_form",
          statusOnly: true,
        },
      },
    });
  });

  it("returns typed DM failure with public fallback text only", async () => {
    const result = await deliverPrivateSensitiveRequest({
      request,
      channel: null,
      target: "owner-dm",
    });

    expect(result.dispatchResult).toMatchObject({
      ok: false,
      reason: "disconnected",
      userActionable: true,
    });
    expect(result.publicStatusText).toBe(
      "I could not send the private setup request. Please DM me or open the owner app as the owner.",
    );
    expect(result.publicStatusText).not.toContain("sr_123");
    expect(result.publicStatusText).not.toContain("https://cloud.example");
  });
});

describe("scheduled task production dispatcher", () => {
  it("preserves disconnected and rate-limited typed dispatch failures", async () => {
    const runtime = {} as IAgentRuntime;
    const registry = createChannelRegistry();
    registerChannelRegistry(runtime, registry);
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });

    await expect(
      dispatcher.dispatch({
        taskId: "task_1",
        firedAtIso: "2026-05-10T12:00:00.000Z",
        channelKey: "missing",
        promptInstructions: "private request",
        contextRequest: undefined,
        output: { destination: "channel", target: "missing:owner" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "disconnected",
      userActionable: true,
    });

    const rateLimited: DispatchResult = {
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: 8,
      userActionable: false,
    };
    registry.register(sendCapableChannel(async () => rateLimited));

    await expect(
      dispatcher.dispatch({
        taskId: "task_2",
        firedAtIso: "2026-05-10T12:00:00.000Z",
        channelKey: "telegram",
        promptInstructions: "private request",
        contextRequest: undefined,
        output: { destination: "channel", target: "telegram:owner-dm" },
      }),
    ).resolves.toEqual(rateLimited);
  });

  it("evaluates send policy before channel send", async () => {
    const runtime = {} as IAgentRuntime;
    const registry = createChannelRegistry();
    const send = vi.fn(async () => ({ ok: true as const }));
    registry.register(sendCapableChannel(send));
    registerChannelRegistry(runtime, registry);

    const policies = createSendPolicyRegistry();
    policies.register({
      kind: "block_sensitive_request",
      describe: { label: "Block sensitive request" },
      evaluate: async () => ({
        kind: "deny",
        reason: "Owner approval required.",
        userActionable: true,
        asDispatchResult: {
          ok: false,
          reason: "auth_expired",
          userActionable: true,
          message: "Owner approval required.",
        },
      }),
    });
    registerSendPolicyRegistry(runtime, policies);

    await expect(
      createProductionScheduledTaskDispatcher({ runtime }).dispatch({
        taskId: "task_policy",
        firedAtIso: "2026-05-10T12:00:00.000Z",
        channelKey: "telegram",
        promptInstructions: "private request",
        contextRequest: undefined,
        output: { destination: "channel", target: "telegram:owner-dm" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "auth_expired",
      userActionable: true,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("fires a ScheduledTask through a fake channel sender", async () => {
    const runtime = {} as IAgentRuntime;
    const sent: unknown[] = [];
    const registry = createChannelRegistry();
    registry.register(
      sendCapableChannel(async (payload) => {
        sent.push(payload);
        return { ok: true, messageId: "msg_task" };
      }),
    );
    registerChannelRegistry(runtime, registry);

    const runner = makeRunner(runtime);
    const task = await runner.schedule(
      baseTask({
        output: { destination: "channel", target: "telegram:owner-dm" },
      }),
    );
    const fired = await runner.fire(task.taskId);

    expect(fired.state.status).toBe("fired");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      target: "owner-dm",
      message: "Open the private request to continue.",
      metadata: {
        taskId: "task_sensitive_request",
        firedAtIso: "2026-05-10T12:00:00.000Z",
      },
    });

    const [stored] = await runner.list();
    expect(stored?.metadata?.lastDispatchResult).toEqual({
      ok: true,
      messageId: "msg_task",
    });
  });

  it("does not advertise in_app or push send support without a sender", () => {
    const runtime = {} as IAgentRuntime;
    const registry = createChannelRegistry();
    registerDefaultChannelPack(registry, runtime);

    expect(registry.get("in_app")?.capabilities.send).toBe(false);
    expect(registry.get("in_app")?.send).toBeUndefined();
    expect(registry.get("push")?.capabilities.send).toBe(false);
    expect(registry.get("push")?.send).toBeUndefined();
  });
});
