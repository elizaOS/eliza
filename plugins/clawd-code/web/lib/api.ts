import type { Message } from "./types";

const getApiUrl = () =>
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export interface StreamChunk {
  type: "text" | "tool_use" | "tool_result" | "done" | "error";
  content?: string;
  tool?: {
    id: string;
    name: string;
    input?: Record<string, unknown>;
    result?: string;
    is_error?: boolean;
  };
  error?: string;
}

export async function* streamChat(
  messages: Pick<Message, "role" | "content">[],
  model: string,
  signal?: AbortSignal,
  options?: { provider?: string; apiKey?: string }
): AsyncGenerator<StreamChunk> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      model,
      stream: true,
      provider: options?.provider ?? "zai",
      apiKey: options?.apiKey,
    }),
    signal,
  });

  if (!response.ok) {
    const err = await response.text();
    yield { type: "error", error: err };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: "error", error: "No response body" };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            yield { type: "done" };
            return;
          }
          try {
            const chunk = JSON.parse(data) as StreamChunk;
            yield chunk;
          } catch {
            // skip malformed chunks
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: "done" };
}

export async function fetchHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${getApiUrl()}/health`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}
