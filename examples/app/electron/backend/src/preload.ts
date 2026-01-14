import { contextBridge, ipcRenderer } from "electron";
import type { AppConfig, ChatMessage, ProviderMode } from "./types";

type ChatResponse = { responseText: string; effectiveMode: ProviderMode };

const api = {
  getGreeting: async (config?: AppConfig): Promise<string> => {
    return await ipcRenderer.invoke("chat:getGreeting", config);
  },
  getHistory: async (config?: AppConfig): Promise<ChatMessage[]> => {
    return await ipcRenderer.invoke("chat:getHistory", config);
  },
  reset: async (config?: AppConfig): Promise<void> => {
    await ipcRenderer.invoke("chat:reset", config);
  },
  sendMessage: async (config: AppConfig | undefined, text: string): Promise<ChatResponse> => {
    return await ipcRenderer.invoke("chat:sendMessage", config, text);
  },
};

contextBridge.exposeInMainWorld("elizaChat", api);

export type ElizaChatBridge = typeof api;

