/**
 * A planner tool call cut off at its output cap must surface as incomplete
 * output with its evidence, which the planner retries once, not as an invalid
 * tool call that fails the turn.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { handleActionPlanner } from "../src/models/text";

afterEach(() => vi.restoreAllMocks());

it.each([
  { lane: "buffered", stream: {} },
  { lane: "JSON reply to a stream request", stream: { stream: true, streamStructured: true } },
])("reports a capped tool call as incomplete output ($lane)", async ({ stream }) => {
  const settings: Record<string, string> = {
    ELIZAOS_CLOUD_API_KEY: "synthetic-test-key",
    ELIZAOS_CLOUD_BASE_URL: "https://custom.example/api/v1",
    ELIZAOS_CLOUD_ACTION_PLANNER_MODEL: "qwen-3.8-27b",
  };
  const runtime = {
    character: { name: "Planner cap test", bio: [] },
    getSetting: (key: string) => settings[key],
    emitEvent: vi.fn(),
  } as unknown as IAgentRuntime;
  const requests: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_create",
                type: "function",
                function: {
                  name: "CALENDAR_CREATE_EVENT",
                  arguments: '{"title":"qa dinner","attendees":[{"email":""},{"email":""',
                },
              },
            ],
          },
          finish_reason: "length",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 8192, total_tokens: 8292 },
    });
  });

  const error = await Promise.resolve(
    handleActionPlanner(runtime, {
      messages: [{ role: "user", content: "make event for tomorrow that says qa dinner at 5pm" }],
      tools: [
        {
          name: "CALENDAR_CREATE_EVENT",
          description: "Create a calendar event.",
          parameters: { type: "object", properties: { title: { type: "string" } } },
        },
      ],
      toolChoice: "required",
      maxTokens: 8192,
      ...stream,
    } as never)
  ).catch((caught: unknown) => caught);

  expect(requests[0]).toMatchObject({ max_tokens: 8192 });
  expect(error).toMatchObject({
    code: "MODEL_OUTPUT_INCOMPLETE",
    context: { finishReason: "length", maxTokens: 8192, emptyVisibleOutput: false },
  });
});
