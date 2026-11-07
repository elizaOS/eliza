/** Actual public runtime, Core, SDK and capture buffer; external HTTP is deterministic. */
import { expect, spyOn, test } from "bun:test";
import { ChannelType } from "@elizaos/core/protocol";
import { runSharedAgentTurn } from "./run-shared-agent-turn";
import { createOwnerCaptureBuffer, type OwnerModelCapture } from "./shared-owner-model-capture";

test("actual public preflight capture retains refused provider evidence and isolates observer failure", async () => {
  const priorKey = process.env.CEREBRAS_API_KEY;
  process.env.CEREBRAS_API_KEY = "csk-offline-public-capture-fixture";
  const providerPayload = {
    results: [
      {
        url: "http://127.0.0.1/not-a-public-source",
        title: "BTC report",
        excerpts: ["BTC report"],
        retainedField: { complete: true },
      },
    ],
  };
  let publicCalls = 0;
  let modelCalls = 0;
  let handlerCalls = 0;
  let evaluationCalls = 0;
  const attemptedHttpUrls: string[] = [];
  const unexpectedHttpUrls: string[] = [];
  const http = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const target = url instanceof Request ? url.url : String(url);
    attemptedHttpUrls.push(target);
    const request = JSON.parse(String(init?.body));
    if (target === "https://api.cerebras.ai/v1/chat/completions") {
      modelCalls++;
      expect(request.model).toBe("zai-glm-4.7");
      if (!request.tools) {
        evaluationCalls++;
        return Response.json({
          id: `public-capture-evaluation-${evaluationCalls}`,
          object: "chat.completion",
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  decision: "FINISH",
                  success: false,
                  thought: "",
                  messageToUser: "I couldn't verify the current BTC price.",
                  replyEffectStatus: "non_applied",
                  requestFullyCovered: true,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      expect(
        request.tools.some(
          (tool: { function?: { name?: string } }) => tool.function?.name === "HANDLE_RESPONSE",
        ),
      ).toBe(true);
      handlerCalls++;
      return Response.json({
        id: `public-capture-fixture-${modelCalls}`,
        object: "chat.completion",
        created: 1,
        model: request.model,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `handler-${modelCalls}`,
                  type: "function",
                  function: {
                    name: "HANDLE_RESPONSE",
                    arguments: JSON.stringify({
                      shouldRespond: "RESPOND",
                      contexts: ["simple"],
                      intents: [],
                      replyText: "I couldn't verify the current BTC price.",
                      replyEffectStatus: "none",
                      candidateActionNames: [],
                      facts: [],
                      relationships: [],
                      topics: [],
                      addressedTo: [],
                      emotion: "none",
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    if (target !== "https://search.parallel.ai/mcp") unexpectedHttpUrls.push(target);
    expect(target).toBe("https://search.parallel.ai/mcp");
    expect(request.params.name).toBe("web_search");
    publicCalls++;
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(providerPayload) }],
      },
    });
  });
  const capture = createOwnerCaptureBuffer(
    {
      organizationId: "11111111-1111-4111-a111-111111111111",
      userId: "22222222-2222-4222-a222-222222222222",
      roomId: "33333333-3333-4333-a333-333333333333",
      traceId: "a".repeat(32),
    },
    { maxCalls: 16, maxBytes: 1024 * 1024, expiresAt: Date.now() + 60_000 },
    () => {},
  );
  const input = {
    character: {
      name: "Public capture fixture",
      system: "You are a test persona.",
      model: "zai-glm-4.7",
    },
    history: [],
    message: "what is btc price rn",
    capabilityText: "what is btc price rn",
    execution: {
      agentKey: "personal-shared:public-capture-fixture",
      roomKey: "dm:public-capture-fixture",
      channel: { type: ChannelType.DM, source: "blooio" },
    },
  };
  try {
    const normal = await runSharedAgentTurn({
      ...input,
      ownerCapture: capture,
    });

    const events = capture
      .snapshot()
      .events.filter((event) => event.kind === "preflight")
      .map(
        (event) =>
          event.payload as {
            stage: string;
            requestedAt: number;
            observedAt: number;
            result: { success: boolean; text: string };
          },
      );
    expect(events.map((event) => event.stage)).toEqual(["provider-result", "authority-result"]);
    expect(events[0].result.success).toBe(true);
    expect(JSON.parse(events[0].result.text)).toEqual(providerPayload);
    expect(events[1].result.success).toBe(false);
    expect(Number.isSafeInteger(events[0].requestedAt)).toBe(true);
    expect(events[0].observedAt).toBeGreaterThanOrEqual(events[0].requestedAt);
    const throwing: OwnerModelCapture = {
      ...capture,
      observe() {
        throw new Error("owner observer failed");
      },
      omission() {
        throw new Error("owner omission failed");
      },
    };
    const unchanged = await runSharedAgentTurn({
      ...input,
      ownerCapture: throwing,
    });
    expect(unchanged.reply).toBe(normal.reply);
    expect(unchanged.degraded).toBe(normal.degraded);
    expect(publicCalls).toBe(2);
    expect(modelCalls).toBe(4);
    expect(handlerCalls).toBe(2);
    expect(evaluationCalls).toBe(2);
    expect(normal.degraded).toBe(false);
    expect(normal.responded).toBe(true);
    expect(attemptedHttpUrls).toEqual([
      "https://search.parallel.ai/mcp",
      ...Array(2).fill("https://api.cerebras.ai/v1/chat/completions"),
      "https://search.parallel.ai/mcp",
      ...Array(2).fill("https://api.cerebras.ai/v1/chat/completions"),
    ]);
    expect(unexpectedHttpUrls).toEqual([]);
    expect(
      attemptedHttpUrls.filter((url) => url === "https://api.cerebras.ai/v1/chat/completions"),
    ).toHaveLength(4);
  } finally {
    http.mockRestore();
    if (priorKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = priorKey;
  }
});
