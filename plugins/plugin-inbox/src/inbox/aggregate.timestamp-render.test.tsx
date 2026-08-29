// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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

afterEach(cleanup);

describe("Inbox timestamp render boundary", () => {
  it("renders a malformed runtime timestamp through the safe fallback", async () => {
    const message = toInboxMessage(
      {
        id: "runtime-malformed",
        source: "discord",
        senderName: "runtime sender",
        channelName: "general",
        channelType: "group",
        text: "hello",
        snippet: "hello",
        timestamp: Number.NaN,
      } satisfies InboundMessage,
      "discord",
      0,
    );
    const fetchers: InboxFetchers = {
      fetchInbox: async () => ({
        messages: [message],
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
      }),
    };

    render(<InboxView fetchers={fetchers} />);

    await screen.findByText("runtime sender");
    expect(document.body.textContent).not.toContain("NaN");
  });
});
