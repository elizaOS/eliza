import { expect, test } from "vitest";
import { streamElizaConversation } from "./eliza-sse-bridge";

const notes = {
  actionName: "VIEWS",
  success: true,
  values: { mode: "open", viewId: "notes" },
};

async function bridge(
  frames: Record<string, unknown>[],
  onAuthoritativeReplace?: (text: string) => void,
) {
  const chunks: string[] = [];
  let replyReady = 0;
  const result = await streamElizaConversation(
    {
      requireTurnTerminal: true,
      endpoint: "https://fixture.invalid",
      authorization: "fixture-only",
      model: "unused",
      transcript: "open notes",
      agentId: "agent",
      conversationId: "conversation",
      traceId: "a".repeat(32),
      signal: new AbortController().signal,
      onReplyReady: () => replyReady++,
      ...(onAuthoritativeReplace ? { onAuthoritativeReplace } : {}),
      fetchImpl: Object.assign(
        async () =>
          new Response(
            frames
              .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          ),
        { preconnect() {} },
      ),
    },
    (text) => chunks.push(text),
  );
  return { result, spoken: chunks.join(""), replyReady };
}

test("a shorter snapshot of text already streamed adds nothing", async () => {
  const { result, spoken } = await bridge([
    { type: "token", fullText: "Opening Notes now." },
    { type: "token", fullText: "Opening Notes" },
    { type: "done", text: "Opening Notes now.", actionResults: [notes] },
  ]);
  expect(spoken).toBe("Opening Notes now.");
  expect(result.completed).toBe(true);
  expect(result.viewHandoff).toEqual({ viewId: "notes" });
});

test("a final that only differs in trailing whitespace continues the reply", async () => {
  const { result, spoken } = await bridge([
    { type: "token", fullText: "Opening Notes. " },
    { type: "done", text: "Opening Notes.\nDone.", actionResults: [notes] },
  ]);
  expect(spoken).toBe("Opening Notes. Done.");
  expect(result.viewHandoff).toEqual({ viewId: "notes" });
  const trimmed = await bridge([
    { type: "token", fullText: "Opening Notes. " },
    { type: "done", text: "Opening Notes.", actionResults: [notes] },
  ]);
  expect(trimmed.spoken).toBe("Opening Notes. ");
  expect(trimmed.result.completed).toBe(true);
});

test("a rewritten final is handed to the caller and the turn still completes", async () => {
  const wrapped = '{"text":"Opening Notes."}';
  for (const early of [false, true]) {
    const replaced: string[] = [];
    const { result, spoken, replyReady } = await bridge(
      [
        { type: "token", fullText: wrapped },
        ...(early ? [{ type: "reply_ready", text: "Opening Notes." }] : []),
        { type: "done", text: "Opening Notes.", actionResults: [notes] },
      ],
      (text) => replaced.push(text),
    );
    expect(spoken).toBe(wrapped);
    expect(replaced).toEqual(["Opening Notes."]);
    expect(replyReady).toBe(early ? 1 : 0);
    expect(result.completed).toBe(true);
    expect(result.viewHandoff).toEqual({ viewId: "notes" });
  }
});

test("without a replace handler a rewritten final stays a protocol error", async () => {
  await expect(
    bridge([
      { type: "token", fullText: "Opening Calendar." },
      { type: "done", text: "Opening Notes." },
    ]),
  ).rejects.toMatchObject({ code: "protocol_error" });
});
