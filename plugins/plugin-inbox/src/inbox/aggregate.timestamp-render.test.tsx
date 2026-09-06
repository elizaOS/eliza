// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui/api", () => ({
  client: {
    getBaseUrl: () => "http://test.local",
    sendChatMessage: vi.fn(),
  },
}));

import {
  type InboxFetchers,
  InboxView,
} from "../components/inbox/InboxView.tsx";
import { toInboxMessage } from "./aggregate.ts";
import type { InboundMessage } from "./types.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function inboxWire(
  timestamp: number,
): Awaited<ReturnType<InboxFetchers["fetchInbox"]>> {
  const inbound = {
    id: "runtime-message",
    source: "discord",
    senderName: "runtime sender",
    channelName: "general",
    channelType: "group",
    text: "hello",
    snippet: "hello",
    timestamp,
  } satisfies InboundMessage;
  return {
    messages: [toInboxMessage(inbound, "discord", 0)],
    channelCounts: {
      gmail: { total: 0, unread: 0 },
      x_dm: { total: 0, unread: 0 },
      discord: { total: 1, unread: 1 },
      telegram: { total: 0, unread: 0 },
      imessage: { total: 0, unread: 0 },
      whatsapp: { total: 0, unread: 0 },
      sms: { total: 0, unread: 0 },
    },
    fetchedAt: "2026-06-17T12:00:00.000Z",
    sources: [],
  };
}

describe("Inbox timestamp render boundary", () => {
  it("surfaces a malformed timestamp as a load error instead of a dated message", async () => {
    const fetchers: InboxFetchers = {
      fetchInbox: async () => inboxWire(Number.NaN),
    };

    render(<InboxView fetchers={fetchers} />);

    await screen.findByText(
      "Inbox message timestamp must be a finite epoch value",
    );
    expect(screen.queryByText("runtime sender")).toBeNull();
    expect(document.body.textContent).not.toContain("NaN");
    expect(document.body.textContent).not.toContain("1970");
  });

  it("keeps the last valid inbox when a background timestamp conversion fails", async () => {
    vi.useFakeTimers();
    let timestamp = Date.parse("2026-06-17T12:00:00.000Z");
    const fetchInbox = vi.fn(async () => inboxWire(timestamp));

    await act(async () => {
      render(<InboxView fetchers={{ fetchInbox }} />);
    });
    expect(screen.getByText("runtime sender")).toBeTruthy();
    const validContent = document.body.textContent;

    timestamp = Number.NaN;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(fetchInbox).toHaveBeenCalledTimes(2);
    await expect(fetchInbox.mock.results[1]?.value).rejects.toMatchObject({
      code: "INBOX_MESSAGE_TIMESTAMP_INVALID",
    });
    expect(document.body.textContent).toBe(validContent);
  });
});
