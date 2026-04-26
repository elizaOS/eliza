// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client";

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

describe("ElizaClient scratchpad methods", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the scratchpad topic and search routes with the expected payloads", async () => {
    const client = new ElizaClient("http://127.0.0.1:31337");
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          count: 0,
          maxTokensPerTopic: 8000,
          maxTopics: 10,
          topics: [],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ topic: { id: "topic-1" } }))
      .mockResolvedValueOnce(jsonResponse({ topic: { id: "topic-1" } }))
      .mockResolvedValueOnce(jsonResponse({ topic: { id: "topic-1" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          deletedFragments: 2,
          ok: true,
          topicId: "topic-1",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          count: 0,
          limit: 3,
          query: "launch",
          results: [],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          summary: "Launch summary",
          tokenCount: 42,
        }),
      );

    await client.listScratchpadTopics();
    await client.createScratchpadTopic({
      text: "Full launch notes",
      title: "Launch plan",
    });
    await client.getScratchpadTopic("topic-1");
    await client.replaceScratchpadTopic("topic-1", {
      text: "Updated notes",
      title: "Updated plan",
    });
    await client.deleteScratchpadTopic("topic-1");
    await client.searchScratchpadTopics("launch", { limit: 3 });
    await client.previewScratchpadSummary({ text: "Full launch notes" });

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toMatch(/\/api\/knowledge\/scratchpad\/topics$/);
    expect(calls[1]?.[0]).toMatch(/\/api\/knowledge\/scratchpad\/topics$/);
    expect(calls[1]?.[1].method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({
      text: "Full launch notes",
      title: "Launch plan",
    });
    expect(calls[2]?.[0]).toMatch(
      /\/api\/knowledge\/scratchpad\/topics\/topic-1$/,
    );
    expect(calls[3]?.[1].method).toBe("PUT");
    expect(JSON.parse(String(calls[3]?.[1].body))).toEqual({
      text: "Updated notes",
      title: "Updated plan",
    });
    expect(calls[4]?.[1].method).toBe("DELETE");
    expect(calls[5]?.[0]).toMatch(
      /\/api\/knowledge\/scratchpad\/search\?q=launch&limit=3$/,
    );
    expect(calls[6]?.[0]).toMatch(
      /\/api\/knowledge\/scratchpad\/summary-preview$/,
    );
    expect(calls[6]?.[1].method).toBe("POST");
    expect(JSON.parse(String(calls[6]?.[1].body))).toEqual({
      text: "Full launch notes",
    });
  });
});
