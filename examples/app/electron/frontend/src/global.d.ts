import type { AppConfig, ChatMessage, ProviderMode } from "./types";

declare global {
  interface Window {
    elizaChat: {
      getGreeting: (config?: AppConfig) => Promise<string>;
      getHistory: (config?: AppConfig) => Promise<ChatMessage[]>;
      reset: (config?: AppConfig) => Promise<void>;
      sendMessage: (
        config: AppConfig | undefined,
        text: string,
      ) => Promise<{ responseText: string; effectiveMode: ProviderMode }>;
    };
  }
}

export {};

