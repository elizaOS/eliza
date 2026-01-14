import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, ChatMessage, ProviderMode } from "./types";

export async function getGreeting(config: AppConfig): Promise<string> {
  return await invoke<string>("chat_get_greeting", { config });
}

export async function getHistory(): Promise<ChatMessage[]> {
  return await invoke<ChatMessage[]>("chat_get_history");
}

export async function resetChat(config: AppConfig): Promise<void> {
  await invoke<void>("chat_reset", { config });
}

export async function sendChat(
  config: AppConfig,
  text: string,
): Promise<{ responseText: string; effectiveMode: ProviderMode }> {
  const result = await invoke<[string, ProviderMode]>("chat_send", { config, text });
  return { responseText: result[0], effectiveMode: result[1] };
}

