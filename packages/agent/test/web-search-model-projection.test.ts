/** Actual agent action → canonical planner wire → evaluator wire; no provider I/O. */
import {
  type ActionResult,
  type ChatMessage,
  type ContextObject,
  type IAgentRuntime,
  isObjectRecord,
  type Memory,
  type PlannerTrajectory,
} from "@elizaos/core";
import { searchBrowserFirstWeb } from "@elizaos/plugin-web-search/browser-web-search";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runEvaluator } from "../../../plugins/plugin-assistant/src/runtime/evaluator.ts";
import { actionResultToPlannerToolResult } from "../../../plugins/plugin-assistant/src/runtime/planner-loop.ts";
import {
  toolMessageContent,
  trajectoryStepsToMessages,
} from "../../../plugins/plugin-assistant/src/runtime/planner-rendering.ts";
import { webSearch } from "../src/runtime/actions/web-search.ts";

vi.mock("@elizaos/plugin-web-search/browser-web-search", () => ({
  searchBrowserFirstWeb: vi.fn(),
  isKeylessWebSearchUnavailableError: () => false,
}));
afterEach(() => vi.resetAllMocks());

const body = JSON.stringify({
  results: [
    {
      url: "https://bun.sh/docs",
      title: "Bun docs",
      excerpts: ["Keep two  spaces.\nExact Ω🙂 text."],
    },
  ],
});
async function searchReceipt() {
  vi.mocked(searchBrowserFirstWeb).mockResolvedValue({
    provider: "parallel",
    text: body,
    truncated: false,
  });
  const callback = vi.fn();
  const result = (await webSearch.handler(
    {} as IAgentRuntime,
    {} as Memory,
    undefined,
    { parameters: { query: "Bun docs" } },
    callback,
  )) as ActionResult;
  expect(callback).not.toHaveBeenCalled();
  return result;
}

describe("WEB_SEARCH explicit lossless model projection", () => {
  it("preserves the complete raw receipt and declares only its duplicate body omitted from data", async () => {
    const result = await searchReceipt();
    expect(result.text).toBe(body);
    expect(result.data).toEqual({
      actionName: "WEB_SEARCH",
      query: "Bun docs",
      provider: "parallel",
      value: body,
      truncated: false,
    });
    expect(result.promptDataMode).toBe("replace-data");
    expect(result.promptData).toEqual({
      actionName: "WEB_SEARCH",
      query: "Bun docs",
      provider: "parallel",
      truncated: false,
    });
  });

  it("sends full evidence once through the existing native planner renderer without mutating raw data", async () => {
    const result = await searchReceipt(),
      original = structuredClone(result);
    const planner = actionResultToPlannerToolResult(result);
    const steps = [
      {
        iteration: 1,
        toolCall: {
          id: "search-1",
          name: "WEB_SEARCH",
          params: { query: "Bun docs" },
        },
        result: planner,
      },
    ];
    const messages = trajectoryStepsToMessages(steps);
    const content = messages[1].content;
    if (!Array.isArray(content)) throw new Error("Planner tool parts missing.");
    const part = content[0];
    if (
      !("output" in part) ||
      !isObjectRecord(part.output) ||
      typeof part.output.value !== "string"
    )
      throw new Error("Planner tool result missing.");
    const wire = JSON.parse(part.output.value);
    expect(part).toMatchObject({ toolCallId: "search-1" });
    expect(wire.text).toBe(body);
    expect(wire.data).toEqual(result.promptData);
    expect(wire.data).not.toHaveProperty("value");
    expect(wire).not.toHaveProperty("promptData");
    expect(result).toEqual(original);
    expect(planner.data?.value).toBe(body);
    expect(Buffer.byteLength(part.output.value)).toBeLessThan(
      Buffer.byteLength(
        toolMessageContent({
          ...planner,
          promptData: undefined,
          promptDataMode: undefined,
        }),
      ),
    );
  });

  it("the actual evaluator sees the projected full evidence and keeps canonical trajectory data intact", async () => {
    const result = await searchReceipt(),
      original = structuredClone(result);
    const context: ContextObject = {
      id: "web-search-context",
      events: [
        {
          id: "request",
          type: "message_handler",
          metadata: { plan: { intents: ["find Bun documentation"] } },
        },
      ],
    };
    const trajectory: PlannerTrajectory = {
      context,
      steps: [
        {
          iteration: 1,
          toolCall: {
            id: "search-1",
            name: "WEB_SEARCH",
            params: { query: "Bun docs" },
          },
          result: actionResultToPlannerToolResult(result),
        },
      ],
      evaluatorOutputs: [],
      archivedSteps: [],
      plannedQueue: [],
    };
    let received: ChatMessage[] = [];
    await runEvaluator({
      context,
      trajectory,
      runtime: {
        useModel: async (_type, options) => {
          received = options.messages ?? [];
          return JSON.stringify({
            decision: "CONTINUE",
            success: false,
            thought: "Controlled offline wire inspection.",
          });
        },
      },
    });
    const message = received.find((message) => message.role === "tool");
    expect(message).toBeDefined();
    if (!message) throw new Error("Evaluator omitted canonical tool evidence.");
    const content = message.content;
    if (!Array.isArray(content))
      throw new Error("Evaluator tool parts missing.");
    const part = content[0];
    if (
      !("output" in part) ||
      !isObjectRecord(part.output) ||
      typeof part.output.value !== "string"
    )
      throw new Error("Evaluator tool result missing.");
    const wire = JSON.parse(part.output.value);
    expect(wire.text).toBe(body);
    expect(wire.data).toEqual(result.promptData);
    expect(wire.data).not.toHaveProperty("value");
    expect(trajectory.steps[0].result?.data?.value).toBe(body);
    expect(result).toEqual(original);
  });

  it.each([
    {
      success: true,
      text: "body A",
      data: { value: "body B", sourceUrls: ["https://bun.sh/docs"] },
    },
    { success: true, data: { value: "only body", revision: "source-v1" } },
    {
      success: false,
      text: "failure evidence",
      data: { value: "failure evidence", retryAfterMs: 500 },
    },
  ])("never infers a projection from undeclared fields: %j", (result) => {
    expect(JSON.parse(toolMessageContent(result))).toEqual(result);
  });

  it("preserves failed-search semantics without inventing a successful projection", async () => {
    vi.mocked(searchBrowserFirstWeb).mockResolvedValue(null);
    const result = (await webSearch.handler(
      {} as IAgentRuntime,
      {} as Memory,
      undefined,
      { parameters: { query: "Bun docs" } },
    )) as ActionResult;
    expect(result.success).toBe(false);
    expect(result.promptDataMode).toBeUndefined();
    expect(result.data).toEqual({
      actionName: "WEB_SEARCH",
      query: "Bun docs",
    });
  });
});
