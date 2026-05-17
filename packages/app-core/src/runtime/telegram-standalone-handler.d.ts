import { type AgentRuntime } from "@elizaos/core";

type TelegramStandaloneUser = {
  id?: number | string;
  username?: string;
  first_name?: string;
  is_bot?: boolean;
};
type TelegramStandaloneChat = {
  id: number | string;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
};
type TelegramStandaloneMessage = {
  message_id?: number | string;
  date?: number;
  text?: string;
  from?: TelegramStandaloneUser;
  chat?: TelegramStandaloneChat;
  message_thread_id?: number | string;
  reply_to_message?: {
    message_id?: number | string;
  };
};
export type TelegramStandaloneContext = {
  message?: TelegramStandaloneMessage;
  from?: TelegramStandaloneUser;
  chat?: TelegramStandaloneChat;
  reply: (text: string) => Promise<unknown>;
};
export declare function handleTelegramStandaloneMessage(
  runtime: AgentRuntime,
  ctx: TelegramStandaloneContext,
): Promise<void>;
//# sourceMappingURL=telegram-standalone-handler.d.ts.map
