import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  scratchpadAddAction,
  scratchpadDeleteAction,
  scratchpadReadAction,
  scratchpadReplaceAction,
  scratchpadSearchAction,
} from "./scratchpad.js";

const runtime = {} as IAgentRuntime;
const message = {} as Memory;

function buildTopic(overrides: Record<string, string | number> = {}) {
  return {
    createdAt: 1_713_916_800_000,
    fragmentCount: 2,
    id: "topic-1",
    summary: "Launch summary",
    text: "Full launch notes",
    title: "Launch plan",
    tokenCount: 42,
    updatedAt: 1_713_916_900_000,
    ...overrides,
  };
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("scratchpad actions", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds a scratchpad topic through the knowledge scratchpad route", async () => {
    const topic = buildTopic();
    fetchMock.mockResolvedValue(jsonResponse({ topic }));

    const result = await scratchpadAddAction.handler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          text: "Full launch notes",
          title: "Launch plan",
        },
      } satisfies HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(result.values?.topicId).toBe("topic-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/knowledge\/scratchpad\/topics$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Full launch notes",
      title: "Launch plan",
    });
  });

  it("reads a scratchpad topic by id", async () => {
    const topic = buildTopic();
    fetchMock.mockResolvedValue(jsonResponse({ topic }));

    const result = await scratchpadReadAction.handler(
      runtime,
      message,
      undefined,
      {
        parameters: { topicId: "topic-1" },
      } satisfies HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("Scratchpad topic: Launch plan");
    expect(result.text).toContain("Full launch notes");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/knowledge\/scratchpad\/topics\/topic-1$/);
  });

  it("searches scratchpad topics with query and limit", async () => {
    const topic = buildTopic();
    fetchMock.mockResolvedValue(
      jsonResponse({
        count: 1,
        limit: 3,
        query: "launch",
        results: [
          {
            matches: [
              {
                fragmentId: "fragment-1",
                score: 0.8,
                text: "launch match",
              },
            ],
            score: 0.8,
            topic,
          },
        ],
      }),
    );

    const result = await scratchpadSearchAction.handler(
      runtime,
      message,
      undefined,
      {
        parameters: { limit: 3, query: "launch" },
      } satisfies HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(result.values?.count).toBe(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(
      /\/api\/knowledge\/scratchpad\/search\?q=launch&limit=3$/,
    );
  });

  it("requires confirmation before replacing or deleting topics", async () => {
    const replaceResult = await scratchpadReplaceAction.handler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          text: "Updated notes",
          title: "Updated plan",
          topicId: "topic-1",
        },
      } satisfies HandlerOptions,
    );
    const deleteResult = await scratchpadDeleteAction.handler(
      runtime,
      message,
      undefined,
      {
        parameters: { topicId: "topic-1" },
      } satisfies HandlerOptions,
    );

    expect(replaceResult.success).toBe(false);
    expect(replaceResult.values?.error).toBe("CONFIRMATION_REQUIRED");
    expect(deleteResult.success).toBe(false);
    expect(deleteResult.values?.error).toBe("CONFIRMATION_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces and deletes topics after confirmation", async () => {
    const updated = buildTopic({
      text: "Updated notes",
      title: "Updated plan",
      tokenCount: 55,
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ topic: updated }))
      .mockResolvedValueOnce(
        jsonResponse({
          deletedFragments: 2,
          ok: true,
          topicId: "topic-1",
        }),
      );

    const replaceResult = await scratchpadReplaceAction.handler(
      runtime,
      message,
      undefined,
      {
        parameters: {
          confirm: true,
          text: "Updated notes",
          title: "Updated plan",
          topicId: "topic-1",
        },
      } satisfies HandlerOptions,
    );
    const deleteResult = await scratchpadDeleteAction.handler(
      runtime,
      message,
      undefined,
      {
        parameters: { confirm: true, topicId: "topic-1" },
      } satisfies HandlerOptions,
    );

    expect(replaceResult.success).toBe(true);
    expect(deleteResult.success).toBe(true);
    const [, replaceInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [, deleteInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(replaceInit.method).toBe("PUT");
    expect(JSON.parse(String(replaceInit.body))).toEqual({
      text: "Updated notes",
      title: "Updated plan",
    });
    expect(deleteInit.method).toBe("DELETE");
  });
});
