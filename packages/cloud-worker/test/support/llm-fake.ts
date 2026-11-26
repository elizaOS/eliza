// spec/cloud/index.md, "Story: Use inference on my subscription or funded pilot account"; spec/cloud/index.md, "A streamed answer sends complete OpenAI frames and settles the same hold"
import type { FakeAnswer, FakeHandler } from "./fakes.ts";
import { secrets } from "./profile.ts";

export const upstreamModel = "upstream-chat";

export type LlmScript =
  | { readonly kind: "whole" }
  | { readonly kind: "stream"; readonly duplicateUsage?: boolean }
  | { readonly kind: "streamWithoutUsage" }
  | { readonly kind: "truncated"; readonly reportUsage?: boolean }
  | { readonly kind: "malformedFrame" }
  | { readonly kind: "oversizedFrame" }
  | { readonly kind: "refuse"; readonly retryAfterSeconds?: number; readonly retryAfterHeader?: string }
  | { readonly kind: "reject"; readonly status: number; readonly body?: object }
  | { readonly kind: "hang"; readonly after: number }
  | { readonly kind: "hangInToolCall" }
  | { readonly kind: "notJson" };

export const replyText = "Héllo";

export const usage = {
  prompt_tokens: 12,
  completion_tokens: 7,
  total_tokens: 19,
  prompt_tokens_details: { cached_tokens: 4 },
  completion_tokens_details: { reasoning_tokens: 3 },
} as const;

export const wholeAnswer = {
  id: "chatcmpl-fake",
  object: "chat.completion",
  created: 1_790_000_000,
  model: upstreamModel,
  choices: [{ index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" }],
  usage,
} as const;

const chunk = (delta: object, finish: string | null) => ({
  id: "chatcmpl-fake",
  object: "chat.completion.chunk",
  created: 1_790_000_000,
  model: upstreamModel,
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const frame = (data: unknown) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

export const contentFrames: ReadonlyArray<string> = [
  frame(chunk({ role: "assistant", content: "" }, null)),
  frame(chunk({ content: replyText.slice(0, 2) }, null)),
  frame(chunk({ content: replyText.slice(2) }, null)),
  frame(chunk({}, "stop")),
];

const toolCallFrame = frame(chunk({
  role: "assistant", content: null, reasoning_content: "Need the weather.",
  tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "SEARCH", arguments: '{"query":"weather in Paris"}' } }],
}, null));

export const usageFrame = frame({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1_790_000_000, model: upstreamModel, choices: [], usage });
export const doneFrame = frame("[DONE]");

export const streamText = [...contentFrames, usageFrame, doneFrame].join("");

function splitMidCodePoint(text: string): ReadonlyArray<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const accent = bytes.indexOf(0xc3);
  const inUsage = new TextEncoder().encode(text.slice(0, text.indexOf(usageFrame) + 20)).length;
  return [bytes.slice(0, accent + 1), bytes.slice(accent + 1, inUsage), bytes.slice(inUsage)];
}

export const streamChunks = splitMidCodePoint(streamText);

export interface LlmFake {
  readonly handler: FakeHandler;
  readonly bodies: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly headers: ReadonlyArray<Readonly<Record<string, string | string[] | undefined>>>;
  readonly aborted: number;
  script(...next: ReadonlyArray<LlmScript>): void;
  untilAborted(count: number): Promise<void>;
}

function answerFor(script: LlmScript, cut: () => void): FakeAnswer {
  switch (script.kind) {
    case "whole":
      return { status: 200, body: wholeAnswer };
    case "stream":
      return { status: 200, chunks: script.duplicateUsage ? splitMidCodePoint([...contentFrames, usageFrame, usageFrame, doneFrame, doneFrame].join("")) : streamChunks };
    case "streamWithoutUsage":
      return { status: 200, chunks: [...contentFrames, doneFrame] };
    case "truncated":
      return { status: 200, chunks: script.reportUsage ? [...contentFrames, usageFrame] : contentFrames };
    case "malformedFrame":
      return { status: 200, chunks: [contentFrames[0] + frame("not JSON"), doneFrame] };
    case "oversizedFrame":
      return { status: 200, chunks: [frame({ choices: [], unused: "a".repeat(256 * 1024) }), doneFrame] };
    case "refuse":
      return {
        status: 429,
        body: { error: { type: "rate_limit_exceeded", message: "slow down" } },
        headers: script.retryAfterHeader !== undefined
            ? { "retry-after": script.retryAfterHeader }
            : script.retryAfterSeconds === undefined ? {} : { "retry-after": String(script.retryAfterSeconds) },
      };
    case "reject":
      return { status: script.status, body: script.body ?? { error: { code: "context_length_exceeded", param: "messages", message: "too long" } } };
    case "hang":
      return { status: 200, chunks: contentFrames, hangAfter: script.after, onClose: (finished) => { if (!finished) cut(); } };
    case "hangInToolCall":
      return { status: 200, chunks: [toolCallFrame, ...contentFrames], hangAfter: 1, onClose: (finished) => { if (!finished) cut(); } };
    case "notJson":
      return { status: 200, body: "<html>upstream gateway</html>", headers: { "content-type": "text/html" } };
  }
}

export function llmFake(models: ReadonlyArray<string> = [upstreamModel]): LlmFake {
  const bodies: Array<Readonly<Record<string, unknown>>> = [];
  const headers: Array<Readonly<Record<string, string | string[] | undefined>>> = [];
  const queue: LlmScript[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  let aborted = 0;
  const cut = () => {
    aborted += 1;
    for (const waiter of waiters.filter((candidate) => candidate.count <= aborted)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  return {
    handler: (request) => {
      if (request.method !== "POST" || request.path !== "/chat/completions") return undefined;
      if (request.headers.authorization !== `Bearer ${secrets.LLM_API_KEY}`) {
        return { status: 401, body: { error: { type: "authentication_error", message: "bad key" } } };
      }
      const body = JSON.parse(request.body) as Record<string, unknown>;
      bodies.push(body);
      headers.push(request.headers);
      if (typeof body.model !== "string" || !models.includes(body.model)) return { status: 404, body: { error: { type: "invalid_request_error", message: "unknown model" } } };
      return answerFor(queue.shift() ?? { kind: body.stream === true ? "stream" : "whole" }, cut);
    },
    bodies,
    headers,
    get aborted() {
      return aborted;
    },
    script: (...next) => {
      queue.push(...next);
    },
    untilAborted: (count) => (aborted >= count ? Promise.resolve() : new Promise((resolve) => waiters.push({ count, resolve }))),
  };
}
