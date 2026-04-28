// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  unsubscribeLifeOpsEmailSenderMock,
  openExternalUrlMock,
  openLifeOpsChatMock,
  useInboxMock,
  useMediaQueryMock,
} = vi.hoisted(() => ({
  unsubscribeLifeOpsEmailSenderMock: vi.fn(),
  openExternalUrlMock: vi.fn(),
  openLifeOpsChatMock: vi.fn(),
  useInboxMock: vi.fn(),
  useMediaQueryMock: vi.fn(() => true),
}));

vi.mock("@elizaos/app-core", () => ({
  Button: "button",
  Input: "input",
  Spinner: () => null,
  client: {
    unsubscribeLifeOpsEmailSender: unsubscribeLifeOpsEmailSenderMock,
  },
  openExternalUrl: openExternalUrlMock,
  useApp: () => ({
    t: (
      _key: string,
      options?: Record<string, unknown> & { defaultValue?: string },
    ) => options?.defaultValue ?? "",
  }),
  useMediaQuery: (query: string) => useMediaQueryMock(query),
}));

vi.mock("../hooks/useInbox.js", () => ({
  useInbox: (options: unknown) => useInboxMock(options),
}));

vi.mock("./LifeOpsChatAdapter.js", () => ({
  buildMessageChatPrefill: () => "chat context",
  buildReplyPrefill: () => "",
  useLifeOpsChatLauncher: () => ({
    openLifeOpsChat: openLifeOpsChatMock,
  }),
}));

vi.mock("./LifeOpsSelectionContext.js", () => ({
  useLifeOpsSelection: () => ({
    selection: { messageId: null },
    select: vi.fn(),
  }),
}));

import { LifeOpsInboxSection } from "./LifeOpsInboxSection";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useInboxMock.mockReset();
  unsubscribeLifeOpsEmailSenderMock.mockReset();
  openLifeOpsChatMock.mockReset();
  useMediaQueryMock.mockReset();
  useMediaQueryMock.mockReturnValue(true);
});

// Single Gmail message used across the tests below. The component now consumes
// `threadGroups` for its primary list, so each fixture wraps the message into a
// group with totalCount: 1.
const SAMPLE_GMAIL_MESSAGE = {
  id: "msg-1",
  channel: "gmail" as const,
  deepLink: null,
  receivedAt: "2026-04-22T12:00:00.000Z",
  sender: {
    avatarUrl: null,
    displayName: "Fluhr, Michael",
    email: "michael@example.test",
    id: "sender-1",
  },
  snippet: "Hey Seb, Yes, this is in progress.",
  sourceRef: {
    channel: "gmail" as const,
    externalId: "msg-1",
  },
  subject: "Fluhr, Michael",
  unread: true,
  chatType: "dm" as const,
  threadId: "thread-1",
};

function gmailFeedFixture(message = SAMPLE_GMAIL_MESSAGE) {
  return {
    channel: "all" as const,
    error: null,
    loading: false,
    messages: [message],
    threadGroups: [
      {
        threadId: message.threadId ?? message.id,
        channel: message.channel,
        chatType: message.chatType ?? "dm",
        latestMessage: message,
        totalCount: 1,
        unreadCount: message.unread ? 1 : 0,
        messages: [message],
      },
    ],
    refresh: vi.fn(),
    searchQuery: "",
    setChannel: vi.fn(),
    setSearchQuery: vi.fn(),
  };
}

describe("LifeOpsInboxSection", () => {
  it("keeps compact inboxes in list mode until a message is selected", () => {
    const onSelect = vi.fn();

    useInboxMock.mockReturnValue(gmailFeedFixture());

    render(
      <LifeOpsInboxSection
        title="Mail"
        selection={{ messageId: null }}
        onSelect={onSelect}
        channels={["gmail"]}
      />,
    );

    expect(screen.getByRole("listbox", { name: "Messages" })).toBeTruthy();
    expect(screen.queryByLabelText("Back to inbox list")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("option"));

    expect(onSelect).toHaveBeenCalledWith({ messageId: "msg-1" });
  });

  it("routes chat actions through the LifeOps chat launcher for the selected message", () => {
    useInboxMock.mockReturnValue(
      gmailFeedFixture({
        ...SAMPLE_GMAIL_MESSAGE,
        deepLink: "https://mail.google.com/mail/u/0/#inbox/msg-1",
      }),
    );

    render(
      <LifeOpsInboxSection
        title="Mail"
        selection={{ messageId: "msg-1", eventId: null, reminderId: null }}
        onSelect={vi.fn()}
        channels={["gmail"]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));

    expect(openLifeOpsChatMock).toHaveBeenCalledWith("chat context", {
      messageId: "msg-1",
    });
  });

  it("uses the sender email for Gmail unsubscribe actions", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    unsubscribeLifeOpsEmailSenderMock.mockResolvedValue({
      record: {
        status: "succeeded",
      },
    });

    useInboxMock.mockReturnValue(
      gmailFeedFixture({
        ...SAMPLE_GMAIL_MESSAGE,
        deepLink: "https://mail.google.com/mail/u/0/#inbox/msg-1",
      }),
    );

    render(
      <LifeOpsInboxSection
        title="Mail"
        selection={{ messageId: "msg-1", eventId: null, reminderId: null }}
        onSelect={vi.fn()}
        channels={["gmail"]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));

    expect(confirmSpy).toHaveBeenCalledWith(
      "Send an unsubscribe request to michael@example.test?",
    );
    expect(unsubscribeLifeOpsEmailSenderMock).toHaveBeenCalledWith({
      senderEmail: "michael@example.test",
      blockAfter: false,
      trashExisting: false,
      confirmed: true,
    });

    confirmSpy.mockRestore();
  });
});
