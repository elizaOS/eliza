/**
 * Scenario test for the pinned task board against a mock Bot API: `/tasks`
 * renders the board, task status advances, and the same Bot API message is
 * edited in place rather than re-posted. Drives the real command through a faked
 * Telegraf/Bot-API surface.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  registerTelegramTaskBoardCommand,
  type TaskBoardEntry,
} from "./task-board";

type DigestSink = (
  target: { source: string; roomId: UUID },
  content: unknown,
) => Promise<boolean | undefined> | boolean | undefined;

interface ScenarioCall {
  method: "sendMessage" | "pinChatMessage" | "editMessage";
  args: unknown[];
}

function makeRuntime(options: {
  tasks: TaskBoardEntry[];
  onRegister: (source: string, sink: DigestSink) => void;
}): IAgentRuntime {
  const mem = new Map<string, Memory>();
  const taskService = {
    listTasks: vi.fn(async () => options.tasks),
  };
  const supervisor = {
    registerDigestSink: vi.fn((source: string, sink: DigestSink) => {
      options.onRegister(source, sink);
      return vi.fn();
    }),
  };
  return {
    agentId: "00000000-0000-0000-0000-000000008902" as UUID,
    getMemoryById: async (id: UUID) => mem.get(id) ?? null,
    createMemory: async (m: Memory) => {
      mem.set(m.id as string, m);
      return m.id as UUID;
    },
    updateMemory: async (m: Partial<Memory> & { id: UUID }) => {
      const prev = mem.get(m.id as string);
      mem.set(
        m.id as string,
        {
          ...(prev as Memory),
          ...m,
          content: m.content ?? prev?.content,
        } as Memory,
      );
      return true;
    },
    getRoom: async () => ({
      channelId: "-1008902000000-17",
      metadata: { telegramThreadId: "17" },
    }),
    getService: (serviceType: string) => {
      if (serviceType === "ORCHESTRATOR_TASK_SERVICE") return taskService;
      if (serviceType === "ORCHESTRATOR_TASK_SUPERVISOR") return supervisor;
      return undefined;
    },
  } as unknown as IAgentRuntime;
}

function maybeWriteReport(report: unknown): void {
  const output = process.env.TELEGRAM_TASK_BOARD_SCENARIO_REPORT;
  if (!output) return;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}

describe("Telegram task board mock Bot API scenario (#8902 AC4)", () => {
  it("runs /tasks, advances task status, and edits the same Bot API message", async () => {
    const calls: ScenarioCall[] = [];
    let commandHandler:
      | ((ctx: {
          chat?: { id: number };
          message?: { message_thread_id?: number };
        }) => Promise<void>)
      | undefined;
    let capturedSink: DigestSink | undefined;
    const bot = {
      command: vi.fn(
        (_name: string, handler: NonNullable<typeof commandHandler>) => {
          commandHandler = handler;
        },
      ),
      telegram: {
        sendMessage: vi.fn(async (...args: unknown[]) => {
          calls.push({ method: "sendMessage", args });
          return { message_id: 8902 };
        }),
        pinChatMessage: vi.fn(async (...args: unknown[]) => {
          calls.push({ method: "pinChatMessage", args });
        }),
      },
    };
    const messageManager = {
      editMessage: vi.fn(async (...args: unknown[]) => {
        calls.push({ method: "editMessage", args });
      }),
    };
    const runtime = makeRuntime({
      tasks: [{ id: "task-1", title: "ship task board", status: "active" }],
      onRegister: (_source, sink) => {
        capturedSink = sink;
      },
    });

    registerTelegramTaskBoardCommand(bot, runtime, messageManager);
    await commandHandler?.({
      chat: { id: -1008902000000 },
      message: { message_thread_id: 17 },
    });

    (
      runtime.getService("ORCHESTRATOR_TASK_SERVICE") as {
        listTasks: ReturnType<typeof vi.fn>;
      }
    ).listTasks.mockResolvedValueOnce([
      { id: "task-1", title: "ship task board", status: "validating" },
    ]);
    const handled = await capturedSink?.(
      {
        source: "telegram",
        roomId: "00000000-0000-4000-8000-000000000890" as UUID,
      },
      { text: "digest" },
    );

    const report = {
      issue: 8902,
      scenario: "telegram-task-board-mock-bot-api",
      result: handled === true ? "passed" : "failed",
      assertions: {
        sentOnce: bot.telegram.sendMessage.mock.calls.length === 1,
        pinnedOnce: bot.telegram.pinChatMessage.mock.calls.length === 1,
        editedSameMessage: messageManager.editMessage.mock.calls.some(
          (args) => args[1] === 8902 && String(args[2]).includes("validating"),
        ),
      },
      calls,
    };
    maybeWriteReport(report);

    expect(handled).toBe(true);
    expect(bot.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(bot.telegram.pinChatMessage).toHaveBeenCalledTimes(1);
    expect(messageManager.editMessage).toHaveBeenCalledWith(
      "-1008902000000",
      8902,
      expect.stringContaining("validating"),
      17,
    );
  });
});
