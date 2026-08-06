import { Bot } from "grammy";
import type { Agent } from "../agent/agent";
import type { ToolCall, ToolResult } from "../types/index";
import { loadUserSettings, resolveTelegramStreamSettings } from "../utils/settings";
import { getTelegramAudioSource, transcribeTelegramAudioMessage } from "./audio-input";
import { splitTelegramMessage, TELEGRAM_MAX_MESSAGE } from "./limits";
import { registerPairingCode } from "./pairing";
import { runTelegramPartialReply } from "./preview-stream";
import { sendFileToTelegram } from "./send-file";
import type { TurnCoordinator } from "./turn-coordinator";
import { startTypingRefresh } from "./typing-refresh";

export { splitTelegramMessage, TELEGRAM_MAX_MESSAGE } from "./limits";

export interface TelegramBridgeOptions {
  token: string;
  getApprovedUserIds: () => number[];
  coordinator: TurnCoordinator;
  getTelegramAgent: (userId: number) => Agent;
  onUserMessage?: (event: { turnKey: string; userId: number; content: string }) => void;
  onAssistantMessage?: (event: { turnKey: string; userId: number; content: string; done: boolean }) => void;
  onToolCalls?: (event: { turnKey: string; userId: number; toolCalls: ToolCall[] }) => void;
  onToolResult?: (event: { turnKey: string; userId: number; toolCall: ToolCall; toolResult: ToolResult }) => void;
  onError?: (message: string) => void;
}

export interface TelegramBridgeHandle {
  start: () => void;
  stop: () => Promise<void>;
  sendDm: (userId: number, text: string) => Promise<void>;
}

export function createTelegramBridge(opts: TelegramBridgeOptions): TelegramBridgeHandle {
  const bot = new Bot(opts.token);
  let running = false;

  const buildTurnKey = (ctx: { chat: { id: number }; message: { message_id: number } }) =>
    `telegram:${ctx.chat.id}:${ctx.message.message_id}`;

  const ensureApprovedUser = async (ctx: { from?: { id?: number }; reply: (text: string) => Promise<unknown> }) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return null;

    const approved = opts.getApprovedUserIds();
    if (!approved.includes(userId)) {
      await ctx.reply("Not paired yet. Send /pair to get a code, then approve in Clawd.");
      return null;
    }

    return userId;
  };

  const replyTurnError = async (
    ctx: { reply: (text: string) => Promise<unknown>; chat: { id: number }; message: { message_id: number } },
    userId: number,
    message: string,
  ) => {
    const clipped = message.slice(0, TELEGRAM_MAX_MESSAGE);
    opts.onAssistantMessage?.({
      turnKey: buildTurnKey(ctx),
      userId,
      content: `Error: ${clipped}`,
      done: true,
    });
    try {
      await ctx.reply(`Error: ${clipped}`);
    } catch {
      /* user blocked bot or chat forbids messages */
    }
  };

  const runAgentTurn = async (
    ctx: {
      chat: { id: number };
      from?: { id?: number };
      message: { message_id: number; message_thread_id?: number };
      reply: (text: string) => Promise<unknown>;
    },
    userId: number,
    userContent: string,
    promptText: string,
  ) => {
    const agent = opts.getTelegramAgent(userId);
    await opts.coordinator.run(async () => {
      agent.setSendTelegramFile((filePath) =>
        sendFileToTelegram(
          { api: bot.api, chatId: ctx.chat.id, messageThreadId: ctx.message.message_thread_id },
          filePath,
        ),
      );
      try {
        const turnKey = buildTurnKey(ctx);
        opts.onUserMessage?.({ turnKey, userId, content: userContent });
        const stream = resolveTelegramStreamSettings(loadUserSettings().telegram);

        if (stream.streaming === "off") {
          const stopTyping = startTypingRefresh(
            bot.api,
            ctx.chat.id,
            ctx.message.message_thread_id,
            stream.typingIndicator,
          );
          let acc = "";
          try {
            for await (const chunk of agent.processMessage(promptText)) {
              switch (chunk.type) {
                case "content":
                  if (chunk.content) {
                    acc += chunk.content;
                    opts.onAssistantMessage?.({ turnKey, userId, content: acc, done: false });
                  }
                  break;
                case "tool_calls":
                  if (chunk.toolCalls) {
                    opts.onToolCalls?.({ turnKey, userId, toolCalls: chunk.toolCalls });
                  }
                  break;
                case "tool_result":
                  if (chunk.toolCall && chunk.toolResult) {
                    opts.onToolResult?.({
                      turnKey,
                      userId,
                      toolCall: chunk.toolCall,
                      toolResult: chunk.toolResult,
                    });
                  }
                  break;
              }
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            await replyTurnError(ctx, userId, msg);
            return;
          } finally {
            stopTyping();
          }
          const trimmed = acc.trim() || "(no text output)";
          opts.onAssistantMessage?.({ turnKey, userId, content: trimmed, done: true });
          const parts = splitTelegramMessage(trimmed);
          for (const part of parts) {
            await ctx.reply(part);
          }
          return;
        }

        await runTelegramPartialReply(bot.api, {
          chatId: ctx.chat.id,
          messageThreadId: ctx.message.message_thread_id,
          typingIndicator: stream.typingIndicator,
          stream: agent.processMessage(promptText),
          onAssistantMessage: (event) => {
            opts.onAssistantMessage?.({
              turnKey,
              userId,
              content: event.content,
              done: event.done,
            });
          },
          onToolCalls: (toolCalls) => {
            opts.onToolCalls?.({ turnKey, userId, toolCalls });
          },
          onToolResult: (event) => {
            opts.onToolResult?.({
              turnKey,
              userId,
              toolCall: event.toolCall,
              toolResult: event.toolResult,
            });
          },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await replyTurnError(ctx, userId, msg);
      } finally {
        agent.setSendTelegramFile(null);
      }
    });
  };

  const handleAudioMessage = async (ctx: {
    chat: { id: number };
    from?: { id?: number };
    message: {
      message_id: number;
      message_thread_id?: number;
      voice?: { file_id: string; mime_type?: string };
      audio?: { file_id: string; file_name?: string; mime_type?: string };
    };
    reply: (text: string) => Promise<unknown>;
  }) => {
    const userId = await ensureApprovedUser(ctx);
    if (userId === null) return;

    const source = getTelegramAudioSource(ctx.message);
    if (!source) return;

    try {
      await bot.api.sendChatAction(ctx.chat.id, "typing");
      const transcription = await transcribeTelegramAudioMessage({
        api: bot.api,
        token: opts.token,
        source,
        telegramSettings: loadUserSettings().telegram,
      });
      await runAgentTurn(ctx, userId, transcription.userContent, transcription.promptText);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await replyTurnError(ctx, userId, `Audio transcription failed: ${msg}`);
    }
  };

  bot.command("start", async (ctx) => {
    await ctx.reply("Send /pair to link this chat to Clawd, then approve the code in the terminal.");
  });

  bot.command("pair", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const code = registerPairingCode(userId);
    await ctx.reply(`Your pairing code: ${code}\nEnter this code in Clawd (/remote-control → Telegram) to approve.`);
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const userId = await ensureApprovedUser(ctx);
    if (userId === null) return;

    await runAgentTurn(ctx, userId, text, text);
  });

  bot.on("message:voice", async (ctx) => {
    await handleAudioMessage(ctx);
  });

  bot.on("message:audio", async (ctx) => {
    await handleAudioMessage(ctx);
  });

  bot.catch((err) => {
    opts.onError?.(err instanceof Error ? err.message : String(err));
  });

  return {
    start() {
      if (running) return;
      running = true;
      void bot
        .start({
          allowed_updates: ["message"],
          drop_pending_updates: true,
        })
        .catch((err: unknown) => {
          running = false;
          opts.onError?.(err instanceof Error ? err.message : String(err));
        });
    },

    async stop() {
      if (!running) return;
      await bot.stop();
      running = false;
    },

    async sendDm(userId: number, text: string) {
      for (const part of splitTelegramMessage(text)) {
        await bot.api.sendMessage(userId, part);
      }
    },
  };
}
