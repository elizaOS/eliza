// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getBaseUrlMock, publishHomeAttentionSpy } = vi.hoisted(() => ({
  getBaseUrlMock: vi.fn(() => "http://localhost"),
  publishHomeAttentionSpy: vi.fn(),
}));

vi.mock("../../../api", () => ({
  client: { getBaseUrl: getBaseUrlMock },
}));

vi.mock("../../../widgets/home-attention-store", () => ({
  usePublishHomeAttention: publishHomeAttentionSpy,
}));

import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import { InboxUnreadWidget } from "./inbox-unread";

// Wire message matching the /api/lifeops/inbox InboxWire shape
// (plugins/plugin-inbox/src/components/inbox/InboxView.tsx InboxMessageWire).
function message(patch: {
  id: string;
  sender?: string;
  subject?: string | null;
  snippet?: string;
  unread?: boolean;
}) {
  return {
    id: patch.id,
    channel: "gmail",
    sender: {
      id: "s-1",
      displayName: patch.sender ?? "Alex",
      email: null,
      avatarUrl: null,
    },
    subject: patch.subject ?? null,
    snippet: patch.snippet ?? "",
    receivedAt: "2026-01-01T00:00:00.000Z",
    unread: patch.unread ?? true,
  };
}

function mockInbox(messages: ReturnType<typeof message>[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        messages,
        channelCounts: {},
        fetchedAt: "2026-01-01T00:00:00.000Z",
      }),
    })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  publishHomeAttentionSpy.mockClear();
});

describe("InboxUnreadWidget (#9143)", () => {
  it("renders the unread threads that need a reply", async () => {
    mockInbox([
      message({ id: "m1", sender: "Dana", subject: "Contract review" }),
      message({ id: "m2", sender: "Sam", snippet: "ping", unread: false }),
    ]);

    render(<InboxUnreadWidget pluginId="inbox" />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-inbox-unread")).toBeTruthy();
    });
    // The unread thread surfaces; the read one does not.
    expect(screen.getByText("Dana")).toBeTruthy();
    expect(screen.queryByText("Sam")).toBeNull();
  });

  it("renders nothing when there are no unread threads", async () => {
    mockInbox([message({ id: "m1", unread: false })]);

    const { container } = render(<InboxUnreadWidget pluginId="inbox" />);

    await waitFor(() => {
      expect(globalThis.fetch as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("chat-widget-inbox-unread")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("publishes the message weight while unread threads exist", async () => {
    mockInbox([message({ id: "m1", sender: "Dana" })]);

    render(<InboxUnreadWidget pluginId="inbox" />);

    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-inbox-unread")).toBeTruthy();
    });
    expect(publishHomeAttentionSpy).toHaveBeenCalledWith(
      "inbox/inbox.unread",
      HOME_SIGNAL_WEIGHTS.message,
    );
  });
});
