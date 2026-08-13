/**
 * Serves a deterministic subset of the OpenAI API for offline end-to-end tests.
 * Requests cross a real HTTP boundary and receive usage-bearing chat completions.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface OpenAiMockOptions {
  host?: string;
  port?: number;
  reply?: string;
  echoContext?: boolean;
}

export interface RunningOpenAiMock {
  url: string;
  port: number;
  requestCount: () => number;
  stop: () => Promise<void>;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
}

interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

async function readJson(req: IncomingMessage): Promise<ChatRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? (JSON.parse(raw) as ChatRequest) : {};
  } catch {
    // error-policy:J3 malformed provider input becomes an explicit empty request shape.
    return {};
  }
}

export async function startOpenAiMock(
  options: OpenAiMockOptions = {},
): Promise<RunningOpenAiMock> {
  const host = options.host ?? "127.0.0.1";
  const reply = options.reply ?? "PONG";
  let count = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, requests: count }));
        return;
      }
      if (req.method === "POST" && url.endsWith("/chat/completions")) {
        const body = await readJson(req);
        const users = (body.messages ?? []).filter(
          (message) => message.role === "user",
        );
        const latest = contentText(users.at(-1)?.content);
        const content = options.echoContext
          ? `turn ${users.length} (prior user turns: ${Math.max(0, users.length - 1)}): ${latest}`
          : reply;
        const promptText = (body.messages ?? [])
          .map((message) => contentText(message.content))
          .join(" ");
        const promptTokens = Math.max(8, Math.ceil(promptText.length / 4));
        count += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: `chatcmpl-local-${count}`,
            object: "chat.completion",
            created: 0,
            model: body.model ?? "local-parity-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: 8,
              total_tokens: promptTokens + 8,
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
    })().catch((error) => {
      // error-policy:J1 the HTTP mock boundary translates handler failure to a 500 response.
      if (!res.headersSent)
        res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}/v1`,
    port: address.port,
    requestCount: () => count,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
