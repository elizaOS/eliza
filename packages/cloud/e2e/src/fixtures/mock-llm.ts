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
  /**
   * Context-aware echo mode (off by default). When on, the assistant reply is
   * DERIVED from the request the caller sent — it echoes the number of prior
   * user turns plus the latest user message — instead of a fixed string. This
   * lets a multi-turn spec assert the reply itself reflects the conversation
   * history that was replayed into the model call (turn 2 sees turn 1), which a
   * fixed reply cannot prove. Off keeps the deterministic `reply` other specs
   * assert on.
   */
  echoContext?: boolean;
}

/** Extract the user-role message contents from a chat-completions request. */
function userMessages(body: ChatCompletionRequestBody): string[] {
  return (body.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    );
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

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
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
  return "";
}

function buildContextEchoReply(body: ChatCompletionRequestBody): string {
  const userMessages = (body.messages ?? []).filter((m) => m.role === "user");
  const lastUser = userMessages.at(-1);
  const turn = Math.max(1, userMessages.length);
  const priorUserTurns = Math.max(0, userMessages.length - 1);
  return `turn ${turn} (prior user turns: ${priorUserTurns}): ${contentToText(
    lastUser?.content,
  )}`;
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
  const echoContext = options.echoContext ?? false;
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
        // In echo mode the reply is computed from the replayed conversation:
        // "turn <N> (prior user turns: <k>): <latest user message>". On turn 1
        // there are no prior user turns; on turn 2 the prior turn is present in
        // `messages` (proving history was replayed), so the count rises. A fixed
        // reply could never reflect that.
        const users = userMessages(body);
        const latestUser = users.at(-1) ?? "";
        const priorUserTurns = Math.max(0, users.length - 1);
        const content = echoContext
          ? `turn ${users.length} (prior user turns: ${priorUserTurns}): ${latestUser}`
          : reply;
        const payload = {
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: 0,
          model: body.model ?? "mock-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
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
