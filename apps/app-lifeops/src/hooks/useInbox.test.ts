// @vitest-environment jsdom

import type { LifeOpsInboxChannel } from "@elizaos/shared/contracts/lifeops";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type InboxChannel, useInbox } from "./useInbox";

const { getLifeOpsInboxMock } = vi.hoisted(() => ({
  getLifeOpsInboxMock: vi.fn(),
}));

vi.mock("@elizaos/app-core", () => ({
  client: {
    getLifeOpsInbox: getLifeOpsInboxMock,
  },
  useApp: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? "",
  }),
}));

afterEach(() => {
  getLifeOpsInboxMock.mockReset();
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

    act(() => hook.result.current.setChannel("discord"));

    channels.current = ["gmail"];
    channel.current = "gmail";
    hook.rerender();

    await waitFor(() => {
      expect(hook.result.current.channel).toBe("gmail");
    });
  });
});
