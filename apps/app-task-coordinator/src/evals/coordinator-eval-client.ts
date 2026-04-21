import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface CoordinatorEvalRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface CoordinatorEvalConversationMessage {
  id?: string;
  text?: string;
  content?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface CoordinatorEvalConversation {
  id: string;
  title?: string;
}

function ensureAbsoluteBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error(`Invalid Eliza base URL: ${baseUrl}`);
  }
  return normalized;
}

function formatRequestError(pathname: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Request failed ${pathname}: ${message}`);
}

export function resolveCoordinatorEvalBaseUrl(explicit?: string): string {
  if (explicit?.trim()) {
    return ensureAbsoluteBaseUrl(explicit);
  }
  const port =
    process.env.ELIZA_API_PORT?.trim() ||
    process.env.ELIZA_PORT?.trim() ||
    "31337";
  return ensureAbsoluteBaseUrl(`http://127.0.0.1:${port}`);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export class CoordinatorEvalClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = ensureAbsoluteBaseUrl(baseUrl);
  }

  async requestJson<T>(
    pathname: string,
    options: CoordinatorEvalRequestOptions = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}`, {
        method: options.method ?? "GET",
        headers: {
          ...(options.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(options.headers ?? {}),
        },
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
        ...(typeof options.timeoutMs === "number" && options.timeoutMs > 0
          ? { signal: AbortSignal.timeout(options.timeoutMs) }
          : {}),
      });
    } catch (error) {
      throw formatRequestError(pathname, error);
    }

    const data = (await readResponseBody(response)) as T;
    if (!response.ok) {
      throw new Error(
        `Request failed (${response.status}) ${pathname}: ${JSON.stringify(data)}`,
      );
    }
    return data;
  }

  async requestBuffer(
    pathname: string,
    options: CoordinatorEvalRequestOptions = {},
  ): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}`, {
        method: options.method ?? "GET",
        headers: {
          ...(options.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(options.headers ?? {}),
        },
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
        ...(typeof options.timeoutMs === "number" && options.timeoutMs > 0
          ? { signal: AbortSignal.timeout(options.timeoutMs) }
          : {}),
      });
    } catch (error) {
      throw formatRequestError(pathname, error);
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) {
      throw new Error(
        `Request failed (${response.status}) ${pathname}: ${new TextDecoder().decode(buffer)}`,
      );
    }
    return buffer;
  }

  async createConversation(
    title: string,
    timeoutMs?: number,
  ): Promise<CoordinatorEvalConversation> {
    const response = await this.requestJson<{
      conversation?: { id?: string; title?: string };
    }>("/api/conversations", {
      method: "POST",
      body: { title, includeGreeting: false },
      timeoutMs,
    });
    const conversationId = response.conversation?.id?.trim();
    if (!conversationId) {
      throw new Error("Conversation create response did not include an id");
    }
    return {
      id: conversationId,
      title: response.conversation?.title,
    };
  }

  async listConversationMessages(
    conversationId: string,
    timeoutMs?: number,
  ): Promise<CoordinatorEvalConversationMessage[]> {
    const response = await this.requestJson<{
      messages?: CoordinatorEvalConversationMessage[];
    }>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
      timeoutMs,
    });
    return Array.isArray(response.messages) ? response.messages : [];
  }

  async postConversationMessage(params: {
    conversationId: string;
    text: string;
    channelType?: string;
    source?: string;
    metadata?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<{ text: string; raw: Record<string, unknown> }> {
    const response = await this.requestJson<Record<string, unknown>>(
      `/api/conversations/${encodeURIComponent(params.conversationId)}/messages`,
      {
        method: "POST",
        body: {
          text: params.text,
          channelType: params.channelType ?? "DM",
          ...(params.source ? { source: params.source } : {}),
          ...(params.metadata ? { metadata: params.metadata } : {}),
        },
        timeoutMs: params.timeoutMs,
      },
    );

    return {
      text:
        typeof response.text === "string"
          ? response.text
          : typeof response.response === "string"
            ? response.response
            : "",
      raw: response,
    };
  }

  async writeJson(outputPath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}
