import type { AppConfig, ChatMessage, ProviderMode } from "./types";

export type ChatResponse = { responseText: string; effectiveMode: ProviderMode };

const DEFAULT_BASE_URL = "http://localhost:8787";

function getBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_CHAT_BACKEND_URL as string | undefined;
  return (fromEnv && fromEnv.trim().length > 0 ? fromEnv : DEFAULT_BASE_URL).replace(/\/+$/, "");
}

async function postJson<T>(path: string, body: object): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const maybe = text.trim();
    throw new Error(maybe || `HTTP ${res.status}`);
  }
  return JSON.parse(text) as T;
}

export async function fetchGreeting(config: AppConfig): Promise<string> {
  const data = await postJson<{ greeting: string }>("/greeting", { config });
  return data.greeting;
}

export async function fetchHistory(config: AppConfig): Promise<ChatMessage[]> {
  const data = await postJson<{ history: ChatMessage[] }>("/history", { config });
  return data.history;
}

export async function resetChat(config: AppConfig): Promise<void> {
  await postJson<{ ok: boolean }>("/reset", { config });
}

export async function sendChat(config: AppConfig, text: string): Promise<ChatResponse> {
  return await postJson<ChatResponse>("/chat", { config, text });
}

