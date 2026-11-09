/** Real HTTP/SQLite transport of a streamed Stage-1 reply: growing draft text, visible revisions, no routing JSON. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  ChannelType,
  createMessageMemory,
  type IMessageService,
  ModelType,
  type ResponseSkeleton,
  type State,
  type TextStreamResult,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { createV5ReplyStrategyResult } from "../../../plugins/plugin-assistant/src/services/message/reply-policy.ts";
import {
  createStage1DirectReplyStreamGate,
  STAGE1_REPLY_STREAM_FIELDS,
} from "../../../plugins/plugin-assistant/src/services/message/stage1-reply-stream.ts";
import { generateChatResponse } from "../src/api/chat-routes.ts";
import { startApiServer } from "../src/api/server.ts";

const skeleton: ResponseSkeleton = {
  spans: [
    { kind: "literal", value: '{"shouldRespond":' },
    { kind: "enum", key: "shouldRespond", enumValues: ["RESPOND", "IGNORE"] },
    { kind: "literal", value: ',"contexts":' },
    { kind: "free-json", key: "contexts" },
    { kind: "literal", value: ',"contextRequests":' },
    { kind: "free-json", key: "contextRequests" },
    { kind: "literal", value: ',"intents":' },
    { kind: "free-json", key: "intents" },
    { kind: "literal", value: ',"replyEffectStatus":' },
    {
      kind: "enum",
      key: "replyEffectStatus",
      enumValues: ["none", "applied", "non_applied", "pending"],
    },
    { kind: "literal", value: ',"replyText":' },
    { kind: "free-string", key: "replyText" },
    { kind: "literal", value: ',"facts":' },
    { kind: "free-json", key: "facts" },
    { kind: "literal", value: "}" },
  ],
};

const envelope = (
  replyText: string,
  route: {
    contexts?: string[];
    contextRequests?: string[];
    intents?: string[];
    replyEffectStatus?: string;
  } = {},
) =>
  JSON.stringify({
    shouldRespond: "RESPOND",
    contexts:
      route.contexts ?? (route.intents?.length ? ["calendar"] : ["simple"]),
    contextRequests: route.contextRequests ?? [],
    intents: route.intents ?? [],
    replyEffectStatus: route.replyEffectStatus ?? "none",
    replyText,
    facts: ["the user is planning a trip"],
  });

type SseEvent = Record<string, unknown> & { type: string };

/**
 * Runs one turn whose message service makes one Stage-1-shaped structured
 * call per envelope (a retry per extra envelope), then delivers `finalText`
 * as the validated reply (an empty `finalText` is a turn with no reply).
 * `transport` picks the conversation SSE stream (revisable; the result is its
 * `data:` payloads) or an append-only host such as the OpenAI/Anthropic
 * compatible routes, which pass only `onChunk` (one `chunk` event per call).
 */
async function runTurn(
  envelopes: string[],
  finalText: string,
  transport: "conversation" | "append-only" = "conversation",
  inspectTiming?: (
    runtime: AgentRuntime,
    base: string,
    token: string,
  ) => Promise<void>,
): Promise<SseEvent[]> {
  const directory = await mkdtemp(join(tmpdir(), "chat-reply-stream-"));
  const token = randomUUID();
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
    ELIZA_HOST_CONTEXT_REVISION: "boot:timing-transport-test",
  }))
    vi.stubEnv(key, value);
  const runtime = new AgentRuntime({
    agentId: randomUUID() as UUID,
    character: { name: "Reply stream fixture", bio: [] },
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      join(directory, "state.sqlite"),
      runtime.agentId,
    ),
  );
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    await runtime.init();
    let attempt = 0;
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async (): Promise<TextStreamResult> => {
        const wire = envelopes[attempt++] ?? "";
        return {
          text: Promise.resolve(wire),
          textStream: (async function* () {
            for (let index = 0; index < wire.length; index += 6) {
              yield wire.slice(index, index + 6);
            }
          })(),
          finishReason: Promise.resolve("stop"),
          usage: Promise.resolve(undefined),
        };
      },
      "scripted-stage1",
      100,
    );
    runtime.messageService = {
      handleMessage: async (_runtime, message, _callback, options) => {
        for (const _ of envelopes) {
          await runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: "HANDLE_RESPONSE",
            streamStructured: true,
            responseSkeleton: skeleton,
            streamFields: STAGE1_REPLY_STREAM_FIELDS,
            streamFieldGate: createStage1DirectReplyStreamGate(() =>
              skeleton.spans.flatMap((span) =>
                span.key ? [{ name: span.key }] : [],
              ),
            ),
            onStreamChunk: options?.onStreamChunk,
          });
        }
        const strategy = createV5ReplyStrategyResult({
          runtime,
          message,
          state: {} as State,
          responseId: randomUUID() as UUID,
          text: finalText,
          thought: "",
        });
        return {
          ...strategy,
          ...(finalText
            ? { didRespond: true }
            : {
                didRespond: false,
                responseContent: null,
                responseMessages: [],
              }),
          outcome: { status: "completed", effects: [] },
        };
      },
      shouldRespond: () => {
        throw new Error("Unexpected response decision in transport fixture");
      },
      deleteMessage: async () => {
        throw new Error("Unexpected message deletion in transport fixture");
      },
      clearChannel: async () => {
        throw new Error("Unexpected channel clearing in transport fixture");
      },
    } satisfies IMessageService;
    if (transport === "append-only") {
      const events: SseEvent[] = [];
      const result = await generateChatResponse(
        runtime,
        createMessageMemory({
          id: randomUUID() as UUID,
          entityId: randomUUID() as UUID,
          agentId: runtime.agentId,
          roomId: randomUUID() as UUID,
          content: {
            text: "What is the capital of France?",
            source: "compat_openai",
            channelType: ChannelType.API,
          },
        }),
        "Reply stream fixture",
        { onChunk: (chunk) => events.push({ type: "chunk", text: chunk }) },
      );
      events.push({ type: "result", text: result.text });
      return events;
    }
    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const created = await fetch(`${base}/api/conversations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Reply stream" }),
    });
    expect(created.status).toBe(200);
    const { conversation } = await created.json();
    const response = await fetch(
      `${base}/api/conversations/${conversation.id}/messages/stream`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          text: "What is the capital of France?",
          clientMessageId: randomUUID(),
        }),
      },
    );
    expect(response.status).toBe(200);
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as SseEvent);
    await inspectTiming?.(runtime, base, token);
    return events;
  } finally {
    await server?.close();
    await runtime.stop();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}

it("projects the completed streamed turn through existing owner status without reading logs", async () => {
  await runTurn(
    [envelope("Paris is the capital.")],
    "Paris is the capital.",
    "conversation",
    async (runtime, base, token) => {
      const getLogs = vi.spyOn(runtime, "getLogs");
      try {
        const response = await fetch(`${base}/api/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        const { nativeInferenceTiming } = await response.json();
        expect(nativeInferenceTiming).toMatchObject({
          version: 1,
          totalMs: expect.any(Number),
          timeToResponseFinalizedMs: expect.any(Number),
          traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
        });
        expect(nativeInferenceTiming.stages.length).toBeGreaterThan(0);
        expect(JSON.stringify(nativeInferenceTiming)).not.toMatch(
          /Paris|scripted-stage1|roomId|turnId|label|meta/,
        );
        expect(getLogs).not.toHaveBeenCalled();
      } finally {
        getLogs.mockRestore();
      }
    },
  );
}, 60_000);

/** The client's text after each token frame (`fullText` replaces, `text` appends). */
function clientTexts(events: SseEvent[]): string[] {
  let text = "";
  const texts: string[] = [];
  for (const event of events) {
    if (event.type !== "token") continue;
    text =
      typeof event.fullText === "string"
        ? event.fullText
        : `${text}${String(event.text ?? "")}`;
    texts.push(text);
  }
  return texts;
}

it("streams a direct reply as growing token text before reply_ready", async () => {
  const reply = "Paris is the capital of France. It sits on the Seine.";
  const events = await runTurn([envelope(reply)], reply);

  const types = events.map((event) => event.type);
  const firstToken = types.indexOf("token");
  expect(types.slice(0, firstToken)).toEqual(["status", "status"]);
  expect(events.slice(0, 2)).toEqual([
    { type: "status", kind: "thinking" },
    { type: "status", kind: "streaming" },
  ]);
  // The draft grows on provisional frames (text renders, voice waits); the
  // validated reply then confirms it in one non-provisional frame.
  const tokens = events.filter((event) => event.type === "token");
  const drafts = clientTexts(events).slice(0, -1);
  expect(drafts.length).toBeGreaterThan(5);
  for (const [index, text] of drafts.entries()) {
    expect(tokens[index]?.provisional).toBe(true);
    expect(reply.startsWith(text)).toBe(true);
    if (index > 0)
      expect(text.length).toBeGreaterThan(drafts[index - 1].length);
  }
  expect(drafts.at(-1)).toBe(reply);
  expect(tokens.at(-1)).toEqual({ type: "token", fullText: reply });
  // Routing JSON, the gate's inputs and later fields never reach the wire.
  for (const event of events.filter((entry) => entry.type === "token")) {
    expect(JSON.stringify(event)).not.toMatch(
      /shouldRespond|contexts|intents|facts|planning a trip/,
    );
  }
  const replyReady = events.findIndex((event) => event.type === "reply_ready");
  expect(replyReady).toBeGreaterThan(types.lastIndexOf("token"));
  expect(events[replyReady]).toMatchObject({ fullText: reply });
  const done = events.find((event) => event.type === "done");
  expect(done?.fullText ?? done?.text).toBe(reply);
}, 60_000);

it("makes a retry and a validation rewrite visible as replacing revisions", async () => {
  const first = "Paris, obviously. Everyone knows that one.";
  const retried = "Paris is the capital.";
  // Validation trims the retried reply: a strict prefix of the streamed text.
  const validated = "Paris is the capital";
  const events = await runTurn([envelope(first), envelope(retried)], validated);

  const texts = clientTexts(events);
  const restart = texts.findIndex(
    (text, index) => index > 0 && !text.startsWith(texts[index - 1]),
  );
  expect(texts.slice(0, restart).at(-1)).toBe(first);
  // The retry's first frame is a full-text snapshot that resets the buffer.
  const tokens = events.filter((event) => event.type === "token");
  expect(tokens[restart]).not.toHaveProperty("text");
  expect(tokens[restart]?.provisional).toBe(true);
  expect(retried.startsWith(texts[restart])).toBe(true);
  expect(texts).toContain(retried);
  // The validated rewrite replaces the buffer even though it is shorter.
  expect(texts.at(-1)).toBe(validated);
  expect(tokens.at(-1)).toEqual({ type: "token", fullText: validated });
  expect(events.find((event) => event.type === "reply_ready")).toMatchObject({
    fullText: validated,
  });
}, 60_000);

it("keeps planned-work acknowledgements and effect claims off the token stream", async () => {
  for (const [planned, final] of [
    [
      envelope("On it, checking your calendar.", {
        intents: ["read the calendar"],
      }),
      "You have two meetings tomorrow.",
    ],
    // Simple context, but the effect status, generated before the reply,
    // sends this claim to planning: it must not stream.
    [
      envelope("Done, I've sent the email to Bob.", {
        contexts: ["simple"],
        replyEffectStatus: "applied",
      }),
      "I sent the email to Bob.",
    ],
    // Simple context, but a context read: the text is an acknowledgement
    // and Stage 1 runs again with the read, so it must not stream.
    [
      envelope("Let me look back through our chat.", {
        contexts: ["simple"],
        contextRequests: ["history:all"],
      }),
      "We talked about your trip to Lisbon.",
    ],
  ]) {
    const events = await runTurn([planned], final);
    const texts = clientTexts(events);
    expect(texts.join("\n")).not.toMatch(/On it|Done, I've|Let me look back/);
    expect(texts.at(-1)).toBe(final);
  }
}, 60_000);

it("retracts a streamed draft when the turn delivers no reply", async () => {
  const draft = "Sure, here is the secret plan.";
  const events = await runTurn([envelope(draft)], "");
  const texts = clientTexts(events);
  expect(texts).toContain(draft);
  expect(texts.at(-1)).toBe("");
  for (const event of events.filter((entry) => entry.type !== "token")) {
    expect(JSON.stringify(event)).not.toContain(draft);
  }
}, 60_000);

it("sends append-only hosts the validated reply, never a revised draft", async () => {
  const events = await runTurn(
    [
      envelope("Paris, obviously. Everyone knows that one."),
      envelope("Paris is the capital."),
    ],
    "Paris is the capital",
    "append-only",
  );
  expect(events).toEqual([
    { type: "chunk", text: "Paris is the capital" },
    { type: "result", text: "Paris is the capital" },
  ]);
}, 60_000);
