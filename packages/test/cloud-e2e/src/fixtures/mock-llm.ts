/**
 * Minimal OpenAI-compatible mock LLM server for the cloud-e2e stack.
 *
 * The real creator-monetization journey (`creator-monetization-journey.spec.ts`)
 * is gated behind `CEREBRAS_API_KEY` because the cloud's default provider is
 * Cerebras and there is no keyless path through `POST /api/v1/messages`. This
 * mock fills that gap: it answers the OpenAI chat-completions API with a
 * deterministic completion and realistic non-zero token usage, so the messages
 * route's `getLanguageModel("openai/<model>")` → `getOpenAIClient().chat()`
 * call (which honours `OPENAI_BASE_URL`) hits this server instead of a paid
 * upstream. The billing/markup/earnings seam downstream is fully real.
 *
 * Wire it in by booting it before the cloud-api worker and exporting its
 * `/v1` URL as `OPENAI_BASE_URL` (+ any `OPENAI_API_KEY`); see the `mockLlm`
 * option in `stack.ts`. Non-streaming only — `/api/v1/messages` uses
 * `generateText`, which never opens an SSE stream to the upstream.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RunningMockLlm {
  /** Base URL including the `/v1` suffix — use as `OPENAI_BASE_URL`. */
  url: string;
  port: number;
  /** Completions served so far (lets a spec assert the seam was exercised). */
  requestCount: () => number;
  stop: () => Promise<void>;
}

export interface MockLlmOptions {
  /** Fixed assistant reply. Default `"PONG"`. */
  reply?: string;
  /** Reported completion tokens. Default `8`. */
  completionTokens?: number;
}

interface ChatCompletionRequestBody {
  model?: string;
  messages?: Array<{ role: string; content: unknown }>;
}

/** Rough token estimate so prompt_tokens scales with the request (never 0). */
function estimatePromptTokens(body: ChatCompletionRequestBody): number {
  const text = (body.messages ?? [])
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .join(" ");
  return Math.max(8, Math.ceil(text.length / 4));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Boot the mock on a free loopback port. Resolves once it is accepting
 * connections. The returned `url` is the `/v1` base the OpenAI SDK appends
 * `/chat/completions` to.
 */
export async function startMockLlm(
  options: MockLlmOptions = {},
): Promise<RunningMockLlm> {
  const reply = options.reply ?? "PONG";
  const completionTokens = options.completionTokens ?? 8;
  let count = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      if (req.method === "POST" && url.endsWith("/chat/completions")) {
        const raw = await readBody(req);
        let body: ChatCompletionRequestBody = {};
        try {
          body = raw ? (JSON.parse(raw) as ChatCompletionRequestBody) : {};
        } catch {
          body = {};
        }
        count += 1;
        const promptTokens = estimatePromptTokens(body);
        const payload = {
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: 0,
          model: body.model ?? "mock-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: reply },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }
      // /v1/models and anything else: minimal OK so SDK probes don't error.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requestCount: () => count,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
