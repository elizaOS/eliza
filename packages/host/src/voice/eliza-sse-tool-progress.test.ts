import { expect, test } from "vitest";
import { streamElizaConversation } from "./eliza-sse-bridge";

const sse = (...frames: Record<string, unknown>[]) =>
  frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");

async function run(body: string) {
  const progress: string[] = [];
  const chunks: string[] = [];
  const result = await streamElizaConversation(
    {
      endpoint: "https://fixture.invalid",
      authorization: "fixture-only",
      model: "unused",
      transcript: "open the calendar and tell me what is on it this week",
      agentId: "agent",
      conversationId: "conversation",
      traceId: "a".repeat(32),
      signal: new AbortController().signal,
      onProgress: (text) => {
        progress.push(text);
      },
      fetchImpl: Object.assign(
        async () =>
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
        { preconnect() {} },
      ),
    },
    (text) => chunks.push(text),
  );
  expect(result.completed).toBe(true);
  return { progress, reply: chunks.join("") };
}

test("tool work without a model acknowledgement stays quiet", async () => {
  expect(
    await run(
      sse(
        { type: "status", kind: "thinking" },
        { type: "status", kind: "running_tool", toolName: "VIEWS_SHOW" },
        { type: "status", kind: "running_tool", toolName: "CALENDAR_FEED" },
        { type: "status", kind: "running_action", actionName: "CALENDAR" },
        { type: "done", fullText: "Nothing on your calendar this week." },
      ),
    ),
  ).toEqual({
    progress: [],
    reply: "Nothing on your calendar this week.",
  });
});

test("a drafted acknowledgement is spoken instead of the fixed cue", async () => {
  expect(
    await run(
      sse(
        { type: "status", kind: "thinking" },
        { type: "status", kind: "thinking", label: "Checking your calendar." },
        {
          type: "status",
          kind: "running_tool",
          toolName: "CALENDAR_FEED",
          label: "Checking your calendar.",
        },
        { type: "done", fullText: "You have lunch on Monday." },
      ),
    ),
  ).toEqual({
    progress: ["Checking your calendar."],
    reply: "You have lunch on Monday.",
  });
});

test("a direct reply with no tool work stays silent until the reply", async () => {
  expect(
    await run(
      sse(
        { type: "status", kind: "thinking" },
        { type: "status", kind: "streaming" },
        { type: "token", text: "hey, what's up?" },
        { type: "done", fullText: "hey, what's up?" },
      ),
    ),
  ).toEqual({ progress: [], reply: "hey, what's up?" });
});

test("tool status after the reply is authorized adds no cue", async () => {
  expect(
    await run(
      sse(
        { type: "token", text: "Opening Calendar." },
        { type: "status", kind: "running_action", actionName: "VIEWS" },
        { type: "done", fullText: "Opening Calendar." },
      ),
    ),
  ).toEqual({ progress: [], reply: "Opening Calendar." });
});

test("model acknowledgments are preserved exactly and emitted once", async () => {
  const words = "Let me have a look.";
  expect(
    await run(
      sse(
        { type: "status", kind: "thinking", label: words },
        { type: "status", kind: "thinking", label: words },
        {
          type: "status",
          kind: "running_tool",
          toolName: "LOOKUP",
          label: words,
        },
        { type: "done", fullText: "All checked." },
      ),
    ),
  ).toEqual({ progress: [words], reply: "All checked." });
});

test("a provisional progress-shaped phrase cannot manufacture periodic speech", async () => {
  expect(
    await run(
      sse(
        { type: "token", text: "Checking.", provisional: true },
        { type: "status", kind: "running_tool", toolName: "LOOKUP" },
        { type: "done", fullText: "All checked." },
      ),
    ),
  ).toEqual({ progress: [], reply: "All checked." });
});

test("a model acknowledgment after reply authorization is not spoken", async () => {
  expect(
    await run(
      sse(
        { type: "token", text: "All checked." },
        { type: "status", kind: "thinking", label: "Let me check." },
        { type: "done", fullText: "All checked." },
      ),
    ),
  ).toEqual({ progress: [], reply: "All checked." });
});

test("waiting on provisional text never creates a repeating synthetic cue", async () => {
  const progress: string[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encode = (text: string) => new TextEncoder().encode(text);
      controller.enqueue(
        encode(sse({ type: "token", text: "Checking.", provisional: true })),
      );
      setTimeout(() => {
        controller.enqueue(
          encode(sse({ type: "done", fullText: "All checked." })),
        );
        controller.close();
      }, 25);
    },
  });
  const result = await streamElizaConversation(
    {
      endpoint: "https://fixture.invalid",
      authorization: "fixture-only",
      model: "unused",
      transcript: "check notes",
      agentId: "agent",
      conversationId: "conversation",
      traceId: "a".repeat(32),
      signal: new AbortController().signal,
      progressIntervalMs: 1,
      onProgress: (text) => {
        progress.push(text);
      },
      fetchImpl: Object.assign(
        async () =>
          new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          }),
        { preconnect() {} },
      ),
    },
    () => {},
  );
  expect(result.completed).toBe(true);
  expect(progress).toEqual([]);
});

test("activity labels are shown once each, in order, and never spoken", async () => {
  const progress: string[] = [];
  const activity: string[] = [];
  const body = sse(
    { type: "status", kind: "thinking", label: "Let me have a look." },
    {
      type: "status",
      kind: "running_tool",
      toolName: "CALENDAR",
      label: "Using Calendar",
    },
    { type: "status", kind: "evaluating", label: "Using Calendar" },
    {
      type: "status",
      kind: "running_tool",
      toolName: "CALENDAR",
      label: "Using Calendar",
    },
    {
      type: "status",
      kind: "running_tool",
      toolName: "NOTES",
      label: "Using Notes",
    },
    { type: "status", kind: "running_tool", toolName: "LOOKUP" },
    { type: "token", text: "Two meetings and one note." },
    {
      type: "status",
      kind: "running_tool",
      toolName: "VIEWS",
      label: "Using Views",
    },
    { type: "done", fullText: "Two meetings and one note." },
  );
  const result = await streamElizaConversation(
    {
      endpoint: "https://fixture.invalid",
      authorization: "fixture-only",
      model: "unused",
      transcript: "what's on my calendar and do I have any notes",
      agentId: "agent",
      conversationId: "conversation",
      traceId: "a".repeat(32),
      signal: new AbortController().signal,
      onProgress: (text) => {
        progress.push(text);
      },
      onActivity: (label) => {
        activity.push(label);
      },
      fetchImpl: Object.assign(
        async () =>
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
        { preconnect() {} },
      ),
    },
    () => {},
  );
  expect(result.completed).toBe(true);
  expect(progress).toEqual(["Let me have a look."]);
  expect(activity).toEqual(["Using Calendar", "Using Notes"]);
});
