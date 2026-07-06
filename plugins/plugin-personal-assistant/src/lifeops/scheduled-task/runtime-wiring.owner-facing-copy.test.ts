import { type IAgentRuntime, ServiceType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dailyRhythmPack } from "../../default-packs/daily-rhythm.js";
import { morningBriefPack } from "../../default-packs/morning-brief.js";
import {
  createChannelRegistry,
  registerChannelRegistry,
} from "../channels/registry.js";
import { createProductionScheduledTaskDispatcher } from "./runtime-wiring.js";

const agentMocks = vi.hoisted(() => ({
  eventService: { emit: vi.fn() },
}));

vi.mock("@elizaos/agent", () => ({
  createLocalAgentBackup: vi.fn(),
  getAgentEventService: vi.fn(() => agentMocks.eventService),
}));

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

function makeRuntime(
  options: {
    notify?: ReturnType<typeof vi.fn>;
    reportError?: ReturnType<typeof vi.fn>;
  } = {},
): IAgentRuntime {
  const notify = options.notify;
  return {
    agentId: "agent-test",
    getService: vi.fn((serviceType: string) => {
      if (serviceType === ServiceType.NOTIFICATION && notify) {
        return { notify };
      }
      return null;
    }),
    getSetting: vi.fn(() => undefined),
    reportError: options.reportError ?? vi.fn(),
  } as unknown as IAgentRuntime;
}

describe("production scheduled-task dispatcher owner-facing copy", () => {
  beforeEach(() => {
    agentMocks.eventService.emit.mockClear();
    morningBriefMocks.assembleMorningBrief.mockReset();
  });

  it("emits daily-rhythm owner-facing chat and notification copy instead of raw promptInstructions", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const runtime = makeRuntime({ notify });
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
    expect(agentMocks.eventService.emit).toHaveBeenCalledTimes(1);
    const emitted = agentMocks.eventService.emit.mock.calls[0]?.[0];
    if (!emitted) throw new Error("assistant event missing");
    expect(emitted.data.text).toBe("Good night. Rest well.");
    expect(emitted.data.text).not.toBe(record.promptInstructions);
    expect(emitted.data.text).not.toContain("Send a gentle good-night");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0].body).toBe("Good night. Rest well.");
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
    const runtime = makeRuntime({ notify });
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

  it("sends owner-facing copy through connected channel payloads", async () => {
    const runtime = makeRuntime();
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

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        message: "Good morning. Hope the day starts gently.",
      }),
    );
    expect(send.mock.calls[0]?.[0].message).not.toBe(record.promptInstructions);
  });

  it("fails closed for unknown scheduled tasks without delivering promptInstructions verbatim", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const reportError = vi.fn();
    const runtime = makeRuntime({ notify, reportError });
    const dispatcher = createProductionScheduledTaskDispatcher({ runtime });
    const promptInstructions =
      "Send a gentle custom reminder with these internal instructions.";

    await dispatcher.dispatch({
      taskId: "task-custom",
      firedAtIso: "2026-07-06T16:00:00.000Z",
      channelKey: "in_app",
      intensity: "normal",
      promptInstructions,
      contextRequest: undefined,
      metadata: { packKey: "custom-pack", recordKey: "custom" },
    });

    const emitted = agentMocks.eventService.emit.mock.calls[0]?.[0];
    if (!emitted) throw new Error("assistant event missing");
    expect(emitted.data.text).toBe("Reminder.");
    expect(emitted.data.text).not.toBe(promptInstructions);
    expect(notify.mock.calls[0]?.[0].body).toBe("Reminder.");
    expect(reportError).toHaveBeenCalledWith(
      "lifeops:scheduled-task:owner-facing-copy",
      expect.any(Error),
      expect.objectContaining({ taskId: "task-custom" }),
    );
  });
});
