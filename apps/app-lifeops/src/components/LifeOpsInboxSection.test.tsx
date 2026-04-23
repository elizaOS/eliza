// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { openExternalUrlMock, useInboxMock, useMediaQueryMock } = vi.hoisted(
  () => ({
    openExternalUrlMock: vi.fn(),
    useInboxMock: vi.fn(),
    useMediaQueryMock: vi.fn(() => true),
  }),
);

vi.mock("@elizaos/app-core", () => ({
  Button: "button",
  Input: "input",
  Spinner: () => null,
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
  buildReplyPrefill: () => "",
  postToChat: vi.fn(),
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
  useInboxMock.mockReset();
  useMediaQueryMock.mockReset();
  useMediaQueryMock.mockReturnValue(true);
});

describe("LifeOpsInboxSection", () => {
  it("keeps compact inboxes in list mode until a message is selected", () => {
    const onSelect = vi.fn();

    useInboxMock.mockReturnValue({
      channel: "all",
      error: null,
      loading: false,
      messages: [
        {
          id: "msg-1",
          channel: "gmail",
          deepLink: null,
          receivedAt: "2026-04-22T12:00:00.000Z",
          sender: {
            avatarUrl: null,
            displayName: "Fluhr, Michael",
          },
          snippet: "Hey Seb, Yes, this is in progress.",
          subject: "Fluhr, Michael",
          unread: true,
        },
      ],
      refresh: vi.fn(),
      searchQuery: "",
      setChannel: vi.fn(),
      setSearchQuery: vi.fn(),
    });

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
});
