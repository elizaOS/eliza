import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

const { hasAdminAccessMock, runCrossChannelSearchMock } = vi.hoisted(() => ({
  hasAdminAccessMock: vi.fn(async () => true),
  runCrossChannelSearchMock: vi.fn(),
}));

vi.mock("@elizaos/agent", () => ({
  hasAdminAccess: hasAdminAccessMock,
}));

vi.mock("../lifeops/cross-channel-search.js", () => ({
  CROSS_CHANNEL_SEARCH_CHANNELS: [
    "gmail",
    "memory",
    "telegram",
    "discord",
    "imessage",
    "whatsapp",
    "signal",
    "x",
    "x-dm",
    "calendly",
    "calendar",
  ],
  runCrossChannelSearch: runCrossChannelSearchMock,
}));

import { searchAcrossChannelsAction } from "./search-across-channels.js";

function runtimeWithPlan(plan: unknown): IAgentRuntime {
  return {
    useModel: vi.fn(async () => JSON.stringify(plan)),
  } as unknown as IAgentRuntime;
}

const message = {
  content: { text: "search everywhere for Frontier Tower" },
} as Memory;

describe("searchAcrossChannelsAction", () => {
  it("asks for clarification instead of running a vague search", async () => {
    runCrossChannelSearchMock.mockReset();
    const result = await searchAcrossChannelsAction.handler!(
      runtimeWithPlan({
        query: null,
        person: null,
        startIso: null,
        endIso: null,
        channels: null,
        shouldAct: false,
        clarification: "What should I search for?",
      }),
      message,
      undefined,
      undefined,
      undefined,
    );

    expect(result.success).toBe(true);
    expect(result.values).toMatchObject({ noop: true });
    expect(result.text).toBe("What should I search for?");
    expect(runCrossChannelSearchMock).not.toHaveBeenCalled();
  });

  it("passes explicit X feed and X DM channel searches through to the use-case", async () => {
    runCrossChannelSearchMock.mockReset();
    runCrossChannelSearchMock.mockResolvedValueOnce({
      query: "elizaOS",
      hits: [
        {
          channel: "x",
          id: "x:1",
          sourceRef: "1",
          timestamp: "2026-04-01T00:00:00.000Z",
          speaker: "@alice",
          text: "elizaOS update",
          citation: { platform: "x", label: "@alice" },
        },
      ],
      unsupported: [],
      degraded: [],
      channelsWithHits: ["x"],
      resolvedPerson: null,
    });

    const runtime = {} as IAgentRuntime;
    const result = await searchAcrossChannelsAction.handler!(
      runtime,
      message,
      undefined,
      {
        parameters: {
          query: "elizaOS",
          channels: ["x", "x-dm"],
          limit: 3,
        },
      },
      undefined,
    );

    expect(result.success).toBe(true);
    expect(runCrossChannelSearchMock).toHaveBeenCalledWith(runtime, {
      query: "elizaOS",
      personRef: undefined,
      timeWindow: undefined,
      channels: ["x", "x-dm"],
      worldId: undefined,
      limit: 3,
    });
    expect(result.data).toMatchObject({
      query: "elizaOS",
      channelsWithHits: ["x"],
    });
  });

  it("filters extracted channels to registered channel values", async () => {
    runCrossChannelSearchMock.mockReset();
    runCrossChannelSearchMock.mockResolvedValueOnce({
      query: "venue",
      hits: [],
      unsupported: [],
      degraded: [],
      channelsWithHits: [],
      resolvedPerson: null,
    });

    const runtime = runtimeWithPlan({
      query: "venue",
      person: null,
      startIso: null,
      endIso: null,
      channels: ["x", "x-dm", "bogus"],
      shouldAct: true,
      clarification: null,
    });
    await searchAcrossChannelsAction.handler!(
      runtime,
      { content: { text: "search X for venue" } } as Memory,
      undefined,
      undefined,
      undefined,
    );

    expect(runCrossChannelSearchMock).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({ channels: ["x", "x-dm"] }),
    );
  });
});
