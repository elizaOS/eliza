import { expect, test } from "vitest";
import { streamElizaConversation } from "./eliza-sse-bridge";

const sse = (...frames: Record<string, unknown>[]) =>
  frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");

async function run(
  body: string,
  observed?: { progress: string[]; chunks: string[] },
  requireTurnTerminal = true,
  expectedCompleted = true,
) {
  const progress: string[] = observed?.progress ?? [];
  const chunks: string[] = observed?.chunks ?? [];
  const result = await streamElizaConversation(
    {
      requireTurnTerminal,
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
  expect(result.completed).toBe(expectedCompleted);
  return {
    progress,
    reply: chunks.join(""),
    ...(result.turnOutcome ? { turnOutcome: result.turnOutcome } : {}),
  };
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
  expect(result.completed).toBe(result.turnOutcome === undefined);
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
  expect(result.completed).toBe(result.turnOutcome === undefined);
  expect(progress).toEqual(["Let me have a look."]);
  expect(activity).toEqual(["Using Calendar", "Using Notes"]);
});

test("an activity label never becomes speech through a later thinking frame", async () => {
  expect(
    await run(
      sse(
        { type: "status", kind: "thinking" },
        {
          type: "status",
          kind: "running_tool",
          toolName: "CALENDAR",
          label: "Using Calendar",
        },
        { type: "status", kind: "thinking" },
        { type: "done", fullText: "Two meetings today." },
      ),
    ),
  ).toEqual({ progress: [], reply: "Two meetings today." });
});

// Canonical failures settle the turn; they are not transport recovery.
test.each([
  [
    { failureKind: "handler_error" },
    { outcome: "failed", code: "handler_error" },
  ],
  [
    {
      terminalFailure: {
        kind: "reply_generation_error",
        code: "STAGE1_INVALID_SOURCE_REPLY",
        message: "Private fixture",
        transient: true,
      },
    },
    { outcome: "failed", code: "reply_generation_error" },
  ],
  [{ noResponseReason: "ignored" }, { outcome: "ignored" }],
] as const)(
  "canonical non-success cannot license held text or handoff: %j",
  async (wire, outcome) => {
    const observed = { progress: [] as string[], chunks: [] as string[] };
    const result = await run(
      sse(
        { type: "status", kind: "thinking", label: "Checking the calendar." },
        { type: "action_callback", text: "unconfirmed" },
        {
          type: "done",
          fullText: "Not authorized",
          ...wire,
          actionResults: [
            {
              actionName: "VIEWS",
              success: true,
              values: { mode: "show", viewId: "calendar" },
            },
          ],
        },
      ),
      observed,
      true,
      false,
    );
    expect(result.turnOutcome).toEqual(outcome);
    expect(observed.chunks).toEqual([]);
    expect(observed.progress).toEqual(["Checking the calendar."]);
  },
);

test.each([
  'event: done\ndata: {"type":123,"fullText":"private"}\n\n',
  'event: done\ndata: {"type":null,"fullText":"private"}\n\n',
  sse({ type: "done", fullText: 123 }),
  sse({ type: "done", text: null }),
  "event: done\ndata: null\n\n",
  "event: done\ndata: []\n\n",
  'event: done\ndata: "invalid"\n\n',
  "event: done\ndata: {bad json\n\n",
  'event: done\ndata: {"type":"error","message":"private"}\n\n',
  'event: error\ndata: {"type":"done","fullText":"private"}\n\n',
  sse({ type: "done", failureKind: "invented", fullText: "private" }),
  sse({
    type: "done",
    terminalFailure: { kind: "handler_error" },
    fullText: "private",
  }),
  sse({
    type: "reply_ready",
    failureKind: "handler_error",
    fullText: "private",
  }),
  sse({
    type: "reply_ready",
    noResponseReason: "ignored",
    fullText: "private",
  }),
])(
  "invalid early/terminal envelope is a non-success outcome before held speech",
  async (wire) => {
    const observed = { progress: [] as string[], chunks: [] as string[] };
    const result = await run(
      sse({ type: "action_callback", text: "held" }) + wire,
      observed,
      true,
      false,
    );
    expect(result.turnOutcome?.outcome).toBe("failed");
    expect(observed.chunks).toEqual([]);
  },
);

test.each([
  "Insufficient credits. private-tail",
  "Insufficient credits. " + "x".repeat(4096),
])("failure prose remains internal", async (message) => {
  const result = await run(
    sse({
      type: "done",
      terminalFailure: {
        kind: "insufficient_credits",
        transient: false,
        message,
      },
    }),
    undefined,
    true,
    false,
  );
  expect(result).toEqual({
    progress: [],
    reply: "",
    turnOutcome: { outcome: "failed", code: "insufficient_credits" },
  });
});

test("literal DONE remains a positive framing boundary for both legacy and negotiated clients", async () => {
  for (const required of [false, true])
    expect(await run("data: [DONE]\n\n", undefined, required)).toEqual({
      progress: [],
      reply: "",
    });
});
