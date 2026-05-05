// @vitest-environment jsdom

import type { LifeOpsInboxChannel } from "@elizaos/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type InboxChannel, useInbox } from "./useInbox";

const { getLifeOpsInboxMock, translateMock } = vi.hoisted(() => ({
  getLifeOpsInboxMock: vi.fn(),
  translateMock: vi.fn(
    (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? "",
  ),
}));

vi.mock("@elizaos/app-core", () => ({
  client: {
    getLifeOpsInbox: getLifeOpsInboxMock,
  },
  useApp: () => ({
    t: translateMock,
  }),
}));

afterEach(() => {
  getLifeOpsInboxMock.mockReset();
  translateMock.mockClear();
});

describe("useInbox", () => {
  it("resets the selected channel when the allowed inbox scope changes", async () => {
    getLifeOpsInboxMock.mockResolvedValue({
      messages: [],
      channelCounts: {},
      fetchedAt: "2026-04-23T12:00:00.000Z",
    });
    const channel = { current: "all" as InboxChannel };
    const channels: { current: readonly LifeOpsInboxChannel[] } = {
      current: ["discord"],
    };
    const hook = renderHook(() =>
      useInbox({ channel: channel.current, channels: channels.current }),
    );

    await waitFor(() => {
      expect(hook.result.current.loading).toBe(false);
    });

    await act(async () => {
      hook.result.current.setChannel("discord");
    });

    channels.current = ["gmail"];
    channel.current = "gmail";
    hook.rerender();

    await waitFor(() => {
      expect(hook.result.current.channel).toBe("gmail");
    });
  });
});
