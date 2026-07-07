/**
 * Covers the production dispatcher's owner-facing composition: delegated
 * morning-brief assembly (structural `metadata.delegatesAssemblyTo`) delivers
 * the assembled summaryText, everything else is rendered through the model —
 * raw instruction-voice `promptInstructions` never reaches chat, notification,
 * or channel surfaces, and a render failure fails closed. Deterministic: the
 * model is stubbed at the runtime boundary (`useModel`).
 */
import { type IAgentRuntime, logger, ServiceType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dailyRhythmPack } from "../../default-packs/daily-rhythm.js";
import { morningBriefPack } from "../../default-packs/morning-brief.js";
import {
  createChannelRegistry,
  registerChannelRegistry,
} from "../channels/registry.js";
import { reportSuppressedSleepCycleMorningCheckin } from "../checkin/morning-checkin-ownership.js";
import { createProductionScheduledTaskDispatcher } from "./runtime-wiring.js";

const agentMocks = vi.hoisted(() => ({
  eventService: { emit: vi.fn() },
}));

vi.mock("../repository.js", () => ({
  LifeOpsRepository: class LifeOpsRepository {},
}));

// Spread the shared PA agent stub so the owner-contact channel-target
// resolution the dispatcher performs before a connector send stays real; the
// telegram contact gives the connected-channel test a resolvable target, and
// the event service is this file's spy.
vi.mock("@elizaos/agent", async () => {
  const stub = await import("../../../test/stubs/agent.ts");
  return {
    ...stub,
    createLocalAgentBackup: vi.fn(),
    getAgentEventService: vi.fn(() => agentMocks.eventService),
    loadOwnerContactsConfig: vi.fn(() => ({
      telegram: { channelId: "owner-telegram-channel" },
    })),
  };
});

const morningBriefMocks = vi.hoisted(() => ({
  assembleMorningBrief: vi.fn(),
}));

vi.mock("../../default-packs/morning-brief.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../default-packs/morning-brief.js")
    >();
  return {
    ...actual,
    assembleMorningBrief: morningBriefMocks.assembleMorningBrief,
  };
});

const RENDERED = "Here's your gentle nudge from me.";

function makeRuntime(
  options: {
    notify?: ReturnType<typeof vi.fn>;
    reportError?: ReturnType<typeof vi.fn>;
    /** Model handler; pass `null` to build a runtime with NO model surface. */
    model?: ((params: { prompt: string }) => string) | null;
  } = {},
): { runtime: IAgentRuntime; modelPrompts: string[] } {
  const notify = options.notify;
  const modelPrompts: string[] = [];
  const model = options.model === undefined ? () => RENDERED : options.model;
  const runtime = {
    agentId: "agent-test",
    getService: vi.fn((serviceType: string) => {
      if (serviceType === ServiceType.NOTIFICATION && notify) {
        return { notify };
      }
      return null;
    }),
    getSetting: vi.fn(() => undefined),
    reportError: options.reportError ?? vi.fn(),
    ...(model
      ? {
          useModel: async (_type: string, params: { prompt: string }) => {
            modelPrompts.push(params.prompt);
            return model(params);
          },
        }
      : {}),
  } as unknown as IAgentRuntime;
  return { runtime, modelPrompts };
}

describe("production scheduled-task dispatcher owner-facing copy", () => {
  beforeEach(() => {
    agentMocks.eventService.emit.mockClear();
    morningBriefMocks.assembleMorningBrief.mockReset();
  });

  it("renders daily-rhythm copy through the model instead of raw promptInstructions", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const { runtime, modelPrompts } = makeRuntime({ notify });
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });
    const record = dailyRhythmPack.records.find(
      (candidate) => candidate.metadata?.recordKey === "gn",
    );
    if (!record) throw new Error("daily-rhythm gn record missing");

    const result = await dispatcher.dispatch({
      taskId: record.taskId,
      firedAtIso: "2026-07-06T03:00:00.000Z",
      channelKey: "in_app",
      intensity: "soft",
      promptInstructions: record.promptInstructions,
      contextRequest: record.contextRequest,
      output: record.output,
      metadata: record.metadata,
    });

    expect(result?.ok).toBe(true);
    // The instruction fed the model as opaque prompt payload... Two model calls
    // fire for an in_app dispatch with a notifier: [0] renders the owner-facing
    // message body, [1] renders the notification title from that body
    // (renderScheduledDispatchTitle). The instruction only ever reaches the
    // first (message) prompt.
    expect(modelPrompts).toHaveLength(2);
    expect(modelPrompts[0]).toContain(record.promptInstructions);
    // ...and only the model's rendering reached the user-visible surfaces.
    expect(agentMocks.eventService.emit).toHaveBeenCalledTimes(1);
    const emitted = agentMocks.eventService.emit.mock.calls[0]?.[0];
    if (!emitted) throw new Error("assistant event missing");
    expect(emitted.data.text).toBe(RENDERED);
    expect(emitted.data.text).not.toBe(record.promptInstructions);
    expect(emitted.data.text).not.toContain("Send a gentle good-night");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0].body).toBe(RENDERED);
    expect(notify.mock.calls[0]?.[0].body).not.toBe(record.promptInstructions);
  });

  it("uses the delegated morning checkin assembler summaryText for morning-brief delivery", async () => {
    const summaryText =
      "Good morning. You have two meetings today and one overdue todo.";
    morningBriefMocks.assembleMorningBrief.mockResolvedValueOnce({
      promptText: "internal prompt text",
      report: { summaryText },
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    const { runtime, modelPrompts } = makeRuntime({ notify });
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });
    const record = morningBriefPack.records[0];
    if (!record) throw new Error("morning-brief record missing");

    await dispatcher.dispatch({
      taskId: record.taskId,
      firedAtIso: "2026-07-06T14:00:00.000Z",
      channelKey: "in_app",
      intensity: "normal",
      promptInstructions: record.promptInstructions,
      contextRequest: record.contextRequest,
      output: record.output,
      metadata: record.metadata,
    });

    expect(morningBriefMocks.assembleMorningBrief).toHaveBeenCalledTimes(1);
    // Delegated assembly supplies the real brief, so the message-render seam is
    // never used. The single model call is the notification-title render
    // (renderScheduledDispatchTitle), which derives the title from the already
    // assembled summaryText — never from raw promptInstructions.
    expect(modelPrompts).toHaveLength(1);
    expect(agentMocks.eventService.emit).toHaveBeenCalledTimes(1);
    const emitted = agentMocks.eventService.emit.mock.calls[0]?.[0];
    if (!emitted) throw new Error("assistant event missing");
    expect(emitted.data.text).toBe(summaryText);
    expect(emitted.data.text).not.toBe(record.promptInstructions);
    expect(emitted.data.text).not.toContain(
      "Assemble the owner's morning brief",
    );
    expect(notify.mock.calls[0]?.[0].body).toBe(summaryText);
  });

  it("delivers exactly one morning check-in when the sleep-cycle domain and scheduled spine are both armed", async () => {
    const summaryText =
      "Good morning. Scheduled spine owns this assembled morning brief.";
    morningBriefMocks.assembleMorningBrief.mockResolvedValueOnce({
      promptText: "internal prompt text",
      report: { summaryText },
    });
    const reportError = vi.fn();
    const loggerInfo = vi.spyOn(logger, "info").mockImplementation(() => {});
    const { runtime } = makeRuntime({ reportError });

    reportSuppressedSleepCycleMorningCheckin({
      agentId: "agent-test",
      nowIso: "2026-07-06T14:00:00.000Z",
      timezone: "America/Denver",
      circadianState: "wake",
      wakeAt: "2026-07-06T13:30:00.000Z",
    });

    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });
    const record = morningBriefPack.records[0];
    if (!record) throw new Error("morning-brief record missing");

    const result = await dispatcher.dispatch({
      taskId: record.taskId,
      firedAtIso: "2026-07-06T14:00:00.000Z",
      channelKey: "in_app",
      intensity: "normal",
      promptInstructions: record.promptInstructions,
      contextRequest: record.contextRequest,
      output: record.output,
      metadata: record.metadata,
    });

    expect(result.ok).toBe(true);
    expect(agentMocks.eventService.emit).toHaveBeenCalledTimes(1);
    const emitted = agentMocks.eventService.emit.mock.calls[0]?.[0];
    if (!emitted) throw new Error("assistant event missing");
    expect(emitted.data.text).toBe(summaryText);
    expect(reportError).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-test",
        ownerEngine: "scheduled-task-spine",
        suppressedEngine: "reminders-domain-sleep-cycle",
      }),
      "Suppressed duplicate sleep-cycle morning check-in; scheduled-task spine owns morning delivery.",
    );
    loggerInfo.mockRestore();
  });

  it("sends the model-rendered message through connected channel payloads", async () => {
    const { runtime, modelPrompts } = makeRuntime();
    const send = vi.fn().mockResolvedValue({ ok: true, messageId: "sent-1" });
    const registry = createChannelRegistry();
    registry.register({
      kind: "telegram",
      describe: { label: "Telegram" },
      capabilities: {
        send: true,
        read: false,
        reminders: true,
        voice: false,
        attachments: false,
        quietHoursAware: true,
      },
      send,
    });
    registerChannelRegistry(runtime, registry);
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });
    const record = dailyRhythmPack.records.find(
      (candidate) => candidate.metadata?.recordKey === "gm",
    );
    if (!record) throw new Error("daily-rhythm gm record missing");

    await dispatcher.dispatch({
      taskId: record.taskId,
      firedAtIso: "2026-07-06T14:00:00.000Z",
      channelKey: "telegram",
      intensity: "soft",
      promptInstructions: record.promptInstructions,
      contextRequest: record.contextRequest,
      output: record.output,
      metadata: record.metadata,
    });

    expect(modelPrompts).toHaveLength(1);
    expect(modelPrompts[0]).toContain(record.promptInstructions);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: RENDERED }),
    );
    expect(send.mock.calls[0]?.[0].message).not.toBe(record.promptInstructions);
  });

  it("fails closed when no model surface exists — nothing is emitted, never the raw instruction", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const reportError = vi.fn();
    const { runtime } = makeRuntime({ notify, reportError, model: null });
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });
    const promptInstructions =
      "Send a gentle custom reminder with these internal instructions.";

    const result = await dispatcher.dispatch({
      taskId: "task-custom",
      firedAtIso: "2026-07-06T16:00:00.000Z",
      channelKey: "in_app",
      intensity: "normal",
      promptInstructions,
      contextRequest: undefined,
      metadata: { packKey: "custom-pack", recordKey: "custom" },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "transport_error",
      retryAfterMinutes: 5,
    });
    expect(agentMocks.eventService.emit).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      "lifeops:scheduled-task:dispatch-render",
      expect.any(Error),
      expect.objectContaining({ taskId: "task-custom" }),
    );
  });

  it("degrades honestly when the delegated assembler fails — never the raw instruction", async () => {
    morningBriefMocks.assembleMorningBrief.mockRejectedValueOnce(
      new Error("brief sources unavailable"),
    );
    const notify = vi.fn().mockResolvedValue(undefined);
    const reportError = vi.fn();
    const { runtime, modelPrompts } = makeRuntime({ notify, reportError });
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });
    const record = morningBriefPack.records[0];
    if (!record) throw new Error("morning-brief record missing");

    const result = await dispatcher.dispatch({
      taskId: record.taskId,
      firedAtIso: "2026-07-06T14:00:00.000Z",
      channelKey: "in_app",
      intensity: "normal",
      promptInstructions: record.promptInstructions,
      contextRequest: record.contextRequest,
      output: record.output,
      metadata: record.metadata,
    });

    expect(result?.ok).toBe(true);
    // The message-render seam stays unused on the degrade path (the honest
    // "couldn't assemble" copy is a fixed string, not a model render). The one
    // model call is the notification-title render over that fixed body.
    expect(modelPrompts).toHaveLength(1);
    const emitted = agentMocks.eventService.emit.mock.calls[0]?.[0];
    if (!emitted) throw new Error("assistant event missing");
    expect(emitted.data.text).toBe(
      "Your morning check-in is ready, but I couldn't assemble the full brief right now.",
    );
    expect(emitted.data.text).not.toBe(record.promptInstructions);
    expect(reportError).toHaveBeenCalledWith(
      "lifeops:scheduled-task:owner-facing-copy",
      expect.any(Error),
      expect.objectContaining({ taskId: record.taskId }),
    );
  });
});
