/**
 * Regression coverage for model-mediated scheduled-task dispatch: a task's
 * instruction-voice `promptInstructions` must never reach a user-visible
 * surface (assistant stream, notification body, connector channel send)
 * verbatim — the dispatcher renders it through the model, and a render failure
 * is a typed retryable dispatch failure, never a raw-instruction fallback.
 * Deterministic: the model is stubbed at the runtime boundary (`useModel`).
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  buildScheduledDispatchRenderPrompt,
  buildScheduledDispatchTitlePrompt,
} from "@elizaos/plugin-scheduling";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelContribution } from "../src/lifeops/channels/contract.js";
import {
  createChannelRegistry,
  registerChannelRegistry,
} from "../src/lifeops/channels/index.js";
import { createProductionScheduledTaskDispatcher } from "../src/lifeops/scheduled-task/runtime-wiring.js";
import {
  enableAgentEventServiceStub,
  getAgentEventServiceStubEvents,
  resetAgentBackupStubState,
  resetAgentEventServiceStub,
  setAgentBackupStubState,
} from "./stubs/agent.ts";

const INSTRUCTION =
  "Remind the owner to take their medication and ask how they slept.";
const RENDERED = "Time for your medication — and how did you sleep last night?";
const RENDERED_TITLE = "Medication and sleep check";

interface ReportedErrorCapture {
  scope: string;
  error: unknown;
  context?: Record<string, unknown>;
}

function makeRuntime(opts: {
  model?: (params: { prompt: string }) => string | Promise<string>;
  notifier?: { notify: (input: Record<string, unknown>) => Promise<unknown> };
}) {
  const modelPrompts: string[] = [];
  const reported: ReportedErrorCapture[] = [];
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getService: (type: string) =>
      type === "notification" ? (opts.notifier ?? null) : null,
    getSetting: () => null,
    ...(opts.model
      ? {
          useModel: async (_type: string, params: { prompt: string }) => {
            modelPrompts.push(params.prompt);
            return opts.model?.(params);
          },
        }
      : {}),
    reportError: (
      scope: string,
      error: unknown,
      context?: Record<string, unknown>,
    ) => {
      reported.push({ scope, error, ...(context ? { context } : {}) });
    },
  } as unknown as IAgentRuntime;
  return { runtime, modelPrompts, reported };
}

function inAppRecord(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "st_render_test",
    firedAtIso: "2026-07-05T09:00:00.000Z",
    channelKey: "in_app",
    intensity: "normal" as const,
    promptInstructions: INSTRUCTION,
    contextRequest: undefined,
    output: undefined,
    metadata: undefined,
    ...overrides,
  };
}

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

beforeEach(() => {
  resetAgentEventServiceStub();
  resetAgentBackupStubState();
});

describe("scheduled dispatch renders promptInstructions through the model", () => {
  it("delivers model output — never raw or generic copy — to the assistant stream and notification", async () => {
    enableAgentEventServiceStub();
    const notified: Record<string, unknown>[] = [];
    const { runtime, modelPrompts } = makeRuntime({
      model: ({ prompt }) =>
        prompt.includes("notification title") ? RENDERED_TITLE : RENDERED,
      notifier: {
        notify: async (input) => {
          notified.push(input);
          return { id: "n1" };
        },
      },
    });
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });

    const result = await dispatcher.dispatch(inAppRecord());

    expect(result).toMatchObject({ ok: true });
    // The instruction fed the model as prompt payload...
    expect(modelPrompts).toHaveLength(2);
    expect(modelPrompts[0]).toContain(INSTRUCTION);
    expect(modelPrompts[1]).toContain(RENDERED);
    expect(modelPrompts[1]).not.toContain(INSTRUCTION);
    // ...and only the model's rendering reached the user-visible surfaces.
    const events = getAgentEventServiceStubEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.data.text).toBe(RENDERED);
    expect(String(events[0]?.data.text)).not.toContain(
      "Remind the owner to take",
    );
    expect(notified).toHaveLength(1);
    expect(notified[0]?.title).toBe(RENDERED_TITLE);
    expect(notified[0]?.title).not.toBe("Reminder");
    expect(notified[0]?.title).not.toBe("Approval needed");
    expect(notified[0]?.body).toBe(RENDERED);
    expect(String(notified[0]?.body)).not.toContain("Remind the owner to take");
  });

  it("delivers the model output — never the raw instruction — to a connector channel send", async () => {
    const sent: Array<{ message?: unknown }> = [];
    const { runtime, modelPrompts } = makeRuntime({ model: () => RENDERED });
    const registry = createChannelRegistry();
    registry.register(
      sendCapableChannel(async (payload) => {
        sent.push(payload as { message?: unknown });
        return { ok: true, messageId: "m1" };
      }),
    );
    registerChannelRegistry(runtime, registry);
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });

    const result = await dispatcher.dispatch(
      inAppRecord({
        channelKey: "telegram",
        output: { destination: "channel", target: "telegram:owner-dm" },
      }),
    );

    expect(result).toMatchObject({ ok: true, messageId: "m1" });
    expect(modelPrompts).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message).toBe(RENDERED);
    expect(sent[0]?.message).not.toBe(INSTRUCTION);
  });

  it("a throwing model is a typed retryable failure with reportError — nothing is emitted, no raw fallback", async () => {
    enableAgentEventServiceStub();
    const notified: Record<string, unknown>[] = [];
    const { runtime, reported } = makeRuntime({
      model: () => {
        throw new Error("model backend down");
      },
      notifier: {
        notify: async (input) => {
          notified.push(input);
          return { id: "n1" };
        },
      },
    });
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });

    const result = await dispatcher.dispatch(inAppRecord());

    expect(result).toMatchObject({
      ok: false,
      reason: "transport_error",
      userActionable: false,
      retryAfterMinutes: 5,
    });
    expect(getAgentEventServiceStubEvents()).toHaveLength(0);
    expect(notified).toHaveLength(0);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.scope).toBe("lifeops:scheduled-task:dispatch-render");
  });

  it("a runtime without a model surface fails closed instead of sending the raw instruction", async () => {
    enableAgentEventServiceStub();
    const { runtime, reported } = makeRuntime({});
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });

    const result = await dispatcher.dispatch(inAppRecord());

    expect(result).toMatchObject({
      ok: false,
      reason: "transport_error",
      retryAfterMinutes: 5,
    });
    expect(getAgentEventServiceStubEvents()).toHaveLength(0);
    expect(reported).toHaveLength(1);
  });

  it("blank model output fails closed instead of sending the raw instruction", async () => {
    enableAgentEventServiceStub();
    const { runtime, reported } = makeRuntime({ model: () => "   \n" });
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });

    const result = await dispatcher.dispatch(inAppRecord());

    expect(result).toMatchObject({ ok: false, reason: "transport_error" });
    expect(getAgentEventServiceStubEvents()).toHaveLength(0);
    expect(reported).toHaveLength(1);
  });

  it("a channel-send failure never leaks the raw instruction and preserves the typed result", async () => {
    const { runtime } = makeRuntime({ model: () => RENDERED });
    const registry = createChannelRegistry();
    registry.register(
      sendCapableChannel(async () => ({
        ok: false as const,
        reason: "rate_limited" as const,
        retryAfterMinutes: 8,
        userActionable: false,
      })),
    );
    registerChannelRegistry(runtime, registry);
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });

    const result = await dispatcher.dispatch(
      inAppRecord({
        channelKey: "telegram",
        output: { destination: "channel", target: "telegram:owner-dm" },
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: 8,
    });
  });

  it("structural system operations (local backup) never touch the model", async () => {
    setAgentBackupStubState({
      createdBackup: {
        fileName: "2026-07-05T090000Z.agent-backup.json",
        path: "/tmp/2026-07-05T090000Z.agent-backup.json",
        createdAt: "2026-07-05T09:00:00.000Z",
        agentId: "00000000-0000-0000-0000-0000000000aa",
        stateSha256: "abc123",
        sizeBytes: 4096,
      },
    });
    const { runtime, modelPrompts } = makeRuntime({ model: () => RENDERED });
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });

    const result = await dispatcher.dispatch(
      inAppRecord({
        metadata: {
          systemOperation: "agent.localBackup",
          backupTarget: "local-file",
        },
      }),
    );

    expect(result).toMatchObject({ ok: true });
    expect(modelPrompts).toHaveLength(0);
  });

  it("an unconnected channel fails before rendering — no wasted model call", async () => {
    const { runtime, modelPrompts } = makeRuntime({ model: () => RENDERED });
    registerChannelRegistry(runtime, createChannelRegistry());
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });

    const result = await dispatcher.dispatch(
      inAppRecord({
        channelKey: "missing",
        output: { destination: "channel", target: "missing:owner" },
      }),
    );

    expect(result).toMatchObject({ ok: false, reason: "disconnected" });
    expect(modelPrompts).toHaveLength(0);
  });
});

describe("buildScheduledDispatchRenderPrompt", () => {
  it("embeds the instruction as opaque payload with delivery framing", () => {
    const prompt = buildScheduledDispatchRenderPrompt({
      promptInstructions: INSTRUCTION,
      intensity: "normal",
      firedAtIso: "2026-07-05T09:00:00.000Z",
    });
    expect(prompt).toContain(INSTRUCTION);
    expect(prompt).toContain("not the message itself");
    expect(prompt).toContain("Fired at: 2026-07-05T09:00:00.000Z");
  });

  it("keys urgency framing on the structural intensity field", () => {
    const urgent = buildScheduledDispatchRenderPrompt({
      promptInstructions: INSTRUCTION,
      intensity: "urgent",
      firedAtIso: "2026-07-05T09:00:00.000Z",
    });
    expect(urgent).toContain("urgent");
    const soft = buildScheduledDispatchRenderPrompt({
      promptInstructions: INSTRUCTION,
      intensity: "soft",
      firedAtIso: "2026-07-05T09:00:00.000Z",
    });
    expect(soft).toContain("gentle");
  });
});

describe("buildScheduledDispatchTitlePrompt", () => {
  it("uses the rendered body, not the instruction payload, as notification title context", () => {
    const prompt = buildScheduledDispatchTitlePrompt(
      {
        intensity: "normal",
        firedAtIso: "2026-07-05T09:00:00.000Z",
      },
      RENDERED,
    );
    expect(prompt).toContain(RENDERED);
    expect(prompt).toContain("under 8 words");
    expect(prompt).not.toContain(INSTRUCTION);
  });
});
