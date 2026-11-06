/** Real HTTP/SQLite transport of a streamed Stage-1 reply: growing token text, visible revisions, no routing JSON. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
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
  STAGE1_REPLY_STREAM_FIELDS,
  stage1DirectReplyStreamGate,
} from "../../../plugins/plugin-assistant/src/services/message/stage1-reply-stream.ts";
import { startApiServer } from "../src/api/server.ts";

const skeleton: ResponseSkeleton = {
  spans: [
    { kind: "literal", value: '{"shouldRespond":' },
    { kind: "enum", key: "shouldRespond", enumValues: ["RESPOND", "IGNORE"] },
    { kind: "literal", value: ',"contexts":' },
    { kind: "free-json", key: "contexts" },
    { kind: "literal", value: ',"intents":' },
    { kind: "free-json", key: "intents" },
    { kind: "literal", value: ',"replyText":' },
    { kind: "free-string", key: "replyText" },
    { kind: "literal", value: ',"facts":' },
    { kind: "free-json", key: "facts" },
    { kind: "literal", value: "}" },
  ],
};

const envelope = (replyText: string, intents: string[] = []) =>
  JSON.stringify({
    shouldRespond: "RESPOND",
    contexts: intents.length ? ["calendar"] : ["simple"],
    intents,
    replyText,
    facts: ["the user is planning a trip"],
  });

type SseEvent = Record<string, unknown> & { type: string };

/**
 * Runs one conversation turn whose message service makes one Stage-1-shaped
 * structured call per envelope (a retry per extra envelope), then delivers
 * `finalText` as the validated reply.
 */
async function runTurn(
  envelopes: string[],
  finalText: string,
): Promise<SseEvent[]> {
  const directory = await mkdtemp(join(tmpdir(), "chat-reply-stream-"));
  const token = randomUUID();
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
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
            streamFieldGate: stage1DirectReplyStreamGate,
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
          didRespond: true,
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
    return (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as SseEvent);
  } finally {
    await server?.close();
    await runtime.stop();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}

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
  const texts = clientTexts(events);
  expect(texts.length).toBeGreaterThan(5);
  for (const [index, text] of texts.entries()) {
    expect(reply.startsWith(text)).toBe(true);
    if (index > 0) expect(text.length).toBeGreaterThan(texts[index - 1].length);
  }
  expect(texts.at(-1)).toBe(reply);
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
  expect(retried.startsWith(texts[restart])).toBe(true);
  expect(texts).toContain(retried);
  // The validated rewrite replaces the buffer even though it is shorter.
  expect(texts.at(-1)).toBe(validated);
  expect(tokens.at(-1)).toEqual({ type: "token", fullText: validated });
  expect(events.find((event) => event.type === "reply_ready")).toMatchObject(
    { fullText: validated },
  );
}, 60_000);

it("keeps planned-work acknowledgements off the token stream", async () => {
  const events = await runTurn(
    [envelope("On it, checking your calendar.", ["read the calendar"])],
    "You have two meetings tomorrow.",
  );
  const texts = clientTexts(events);
  expect(texts.join("\n")).not.toContain("On it");
  expect(texts.at(-1)).toBe("You have two meetings tomorrow.");
}, 60_000);
