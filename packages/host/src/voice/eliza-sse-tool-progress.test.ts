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

test("tool work without a drafted acknowledgement speaks one fixed cue", async () => {
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
    progress: ["On it."],
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
