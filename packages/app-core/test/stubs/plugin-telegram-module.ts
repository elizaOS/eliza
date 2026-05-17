import type { Plugin } from "@elizaos/core";

type TelegramChunk = {
  html: string;
  text: string;
};

export function markdownToTelegramChunks(
  markdown: string,
  maxChars = 4096,
): TelegramChunk[] {
  const safeText = markdown.trim();
  if (!safeText) {
    return [];
  }

  const chunks: TelegramChunk[] = [];
  let remaining = safeText;

  while (remaining.length > maxChars) {
    chunks.push({
      html: remaining.slice(0, maxChars),
      text: remaining.slice(0, maxChars),
    });
    remaining = remaining.slice(maxChars).trimStart();
  }

  chunks.push({ html: remaining, text: remaining });
  return chunks;
}

export class MessageManager {
  async handleMessage(_ctx: unknown): Promise<void> {}

  async sendMessageInChunks(
    _ctx: unknown,
    _content: unknown,
    _replyTo?: number,
  ): Promise<unknown[]> {
    return [];
  }
}

export class TelegramService {
  static serviceType = "telegram";

  static async start(_runtime: unknown): Promise<Record<string, unknown>> {
    return {
      bot: {},
      messageManager: new MessageManager(),
    };
  }

  static async stop(_runtime: unknown): Promise<void> {}
}

const telegramPlugin = {
  name: "@elizaos/plugin-telegram",
  description: "Vitest stub for the published Telegram plugin",
  services: [TelegramService],
} as Partial<Plugin> as Plugin;

export default telegramPlugin;
