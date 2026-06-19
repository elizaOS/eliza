export function escapeMarkdownV2(text: string): string {
  if (!text) return "";
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

export function splitMessage(text: string, maxLength = 4096): string[] {
  const chunks: string[] = [];
  if (!text) return chunks;

  let current = "";

  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 <= maxLength) {
      current += (current ? "\n" : "") + line;
    } else {
      if (current) chunks.push(current);
      if (line.length > maxLength) {
        let remaining = line;
        while (remaining.length > maxLength) {
          chunks.push(remaining.slice(0, maxLength));
          remaining = remaining.slice(maxLength);
        }
        current = remaining;
      } else {
        current = line;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

export function createInlineKeyboard(buttons: Array<{ text: string; url: string }>): {
  inline_keyboard: Array<Array<{ text: string; url: string }>>;
} {
  return {
    inline_keyboard: [buttons.map((b) => ({ text: b.text, url: b.url }))],
  };
}

export function createMultiRowKeyboard(
  rows: Array<Array<{ text: string; url?: string; callback_data?: string }>>,
): {
  inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
} {
  return { inline_keyboard: rows };
}

export function parseBotToken(token: string): {
  botId: string;
  valid: boolean;
} {
  const parts = token.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { botId: "", valid: false };
  }
  return { botId: parts[0], valid: true };
}

export function convertToTelegramMarkdown(text: string): string {
  if (!text) return "";

  let result = escapeMarkdownV2(text);
  result = result.replace(/\\\*\\\*([^*]+)\\\*\\\*/g, "*$1*");
  result = result.replace(/\\_([^_]+)\\_/g, "_$1_");
  result = result.replace(/\\`([^`]+)\\`/g, "`$1`");

  return result;
}

export function maskChatId(chatId: string | number): string {
  const id = String(chatId);
  if (id.length <= 4) return id;
  return `${id.slice(0, 2)}...${id.slice(-2)}`;
}

export const TELEGRAM_RATE_LIMITS = {
  MESSAGES_PER_SECOND_GLOBAL: 30,
  MESSAGES_PER_SECOND_SAME_CHAT: 1,
  MESSAGES_PER_MINUTE_SAME_GROUP: 20,
  MAX_MESSAGE_LENGTH: 4096,
  MAX_CAPTION_LENGTH: 1024,
} as const;

export type TelegramUpdateType = "message" | "edited_message" | "channel_post" | "callback_query";

export function extractMessageText(message: { text?: string; caption?: string }): string {
  return message.text || message.caption || "";
}

export function isCommand(text: string): boolean {
  return text.startsWith("/");
}

export function parseCommand(text: string): {
  command: string;
  args: string[];
  raw: string;
} {
  const parts = text.trim().split(/\s+/);
  const commandPart = parts[0] || "";
  const command = commandPart.split("@")[0].toLowerCase();
  return {
    command,
    args: parts.slice(1),
    raw: parts.slice(1).join(" "),
  };
}

export function createTypingRefresh(
  chatId: number,
  botToken: string,
  intervalMs = 4000,
  onError?: (error: unknown) => void,
): { stop: () => void } {
  const id = setInterval(() => {
    fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    }).catch((error) => {
      onError?.(error);
    });
  }, intervalMs);
  return { stop: () => clearInterval(id) };
}
