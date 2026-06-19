// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// `@elizaos/ui` is the giant renderer barrel; InboxView only touches
// `client.getBaseUrl()` (default fetcher seam, overridden in every test) and
// `client.sendChatMessage()` (connect affordance). `@elizaos/ui/agent-surface`
// is mocked to an inert hook so the instrumented refresh button + channel chips
// render outside a provider. jest-dom matchers are NOT installed in this repo,
// so we assert against real DOM nodes / Testing Library queries with plain
// Vitest matchers (mirrors plugin-finances/.../FinancesView.test.tsx).
const { sendChatMessage } = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: () => "http://test.local",
    sendChatMessage,
  },
}));
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import {
  type InboxFetchers,
  InboxView,
} from "../src/components/inbox/InboxView.tsx";

// ---------------------------------------------------------------------------
// Wire fixtures — one shape per inbox payload variant.
// ---------------------------------------------------------------------------

function gmailMessage() {
  return {
    id: "gmail:msg-1",
    channel: "gmail",
    sender: {
      id: "s1",
      displayName: "Acme Billing",
      email: "billing@acme.test",
      avatarUrl: null,
    },
    subject: "Invoice #42 overdue",
    snippet: "Please remit payment",
    receivedAt: "2026-06-16T10:00:00.000Z",
    unread: true,
    threadId: "thread-gmail-1",
  };
}

function discordMessage() {
  return {
    id: "discord:msg-7",
    channel: "discord",
    sender: {
      id: "s2",
      displayName: "guildmate",
      email: null,
      avatarUrl: null,
    },
    subject: null,
    snippet: "gm everyone",
    receivedAt: "2026-06-16T09:30:00.000Z",
    unread: false,
    threadId: "thread-discord-7",
  };
}

function populatedInbox() {
  return {
    messages: [gmailMessage(), discordMessage()],
    channelCounts: {
      gmail: { total: 1, unread: 1 },
      discord: { total: 1, unread: 0 },
      telegram: { total: 0, unread: 0 },
      signal: { total: 0, unread: 0 },
      imessage: { total: 0, unread: 0 },
      whatsapp: { total: 0, unread: 0 },
      sms: { total: 0, unread: 0 },
      x_dm: { total: 0, unread: 0 },
    },
    fetchedAt: "2026-06-17T12:00:00.000Z",
  };
}

function emptyInbox(connected = false) {
  return {
    messages: [],
    channelCounts: connected
      ? { ...populatedInbox().channelCounts }
      : {
          gmail: { total: 0, unread: 0 },
          discord: { total: 0, unread: 0 },
          telegram: { total: 0, unread: 0 },
          signal: { total: 0, unread: 0 },
          imessage: { total: 0, unread: 0 },
          whatsapp: { total: 0, unread: 0 },
          sms: { total: 0, unread: 0 },
          x_dm: { total: 0, unread: 0 },
        },
    fetchedAt: "2026-06-17T12:00:00.000Z",
  };
}

function makeFetchers(overrides: Partial<InboxFetchers> = {}): InboxFetchers {
  return {
    fetchInbox: async () => populatedInbox(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  sendChatMessage.mockClear();
});

describe("InboxView", () => {
  it("shows the loading state while the first fetch is in flight", () => {
    const never = new Promise<never>(() => {});
    render(<InboxView fetchers={makeFetchers({ fetchInbox: () => never })} />);
    expect(screen.getByTestId("inbox-loading")).toBeTruthy();
  });

  it("renders the populated triage list grouped + labeled by channel", async () => {
    render(<InboxView fetchers={makeFetchers()} />);
    expect(await screen.findByTestId("inbox-populated")).toBeTruthy();
    // One group card per channel that has items.
    expect(screen.getByTestId("inbox-group-gmail")).toBeTruthy();
    expect(screen.getByTestId("inbox-group-discord")).toBeTruthy();
    // Real DTO fields surfaced: subject, sender, preview.
    expect(screen.getByText("Invoice #42 overdue")).toBeTruthy();
    expect(
      screen.getByText(/Acme Billing — Please remit payment/),
    ).toBeTruthy();
    // Chat channel with no subject falls back to the sender name as the title.
    expect(screen.getByText(/guildmate — gm everyone/)).toBeTruthy();
  });

  it("shows the connect-a-channel empty state when nothing is connected (no fabricated threads)", async () => {
    render(
      <InboxView
        fetchers={makeFetchers({ fetchInbox: async () => emptyInbox(false) })}
      />,
    );
    expect(await screen.findByTestId("inbox-empty")).toBeTruthy();
    expect(screen.getByText(/No channels connected/i)).toBeTruthy();
    expect(screen.queryByTestId("inbox-group-gmail")).toBeNull();
  });

  it("shows the inbox-zero empty state when channels are connected but there is nothing to triage", async () => {
    render(
      <InboxView
        fetchers={makeFetchers({ fetchInbox: async () => emptyInbox(true) })}
      />,
    );
    expect(await screen.findByTestId("inbox-empty")).toBeTruthy();
    expect(screen.getByText(/Inbox zero/i)).toBeTruthy();
    expect(screen.queryByText(/No channels connected/i)).toBeNull();
  });

  it("routes the connect affordance through the assistant chat", async () => {
    render(
      <InboxView
        fetchers={makeFetchers({ fetchInbox: async () => emptyInbox(false) })}
      />,
    );
    await screen.findByTestId("inbox-empty");
    fireEvent.click(
      screen.getByRole("button", { name: /connect a messaging channel/i }),
    );
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("shows the error state with a Retry that refetches into the populated state", async () => {
    let attempt = 0;
    const fetchInbox = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return populatedInbox();
    };
    render(<InboxView fetchers={makeFetchers({ fetchInbox })} />);
    expect(await screen.findByTestId("inbox-error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByTestId("inbox-populated")).toBeTruthy();
  });

  it("refetches when the header refresh control is activated", async () => {
    let calls = 0;
    const fetchInbox = async () => {
      calls += 1;
      return populatedInbox();
    };
    render(<InboxView fetchers={makeFetchers({ fetchInbox })} />);
    await screen.findByTestId("inbox-populated");
    expect(calls).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(calls).toBe(2));
  });

  it("re-fetches with a server-side channel filter when a channel chip is toggled", async () => {
    const channelQueries: string[][] = [];
    const fetchInbox = async (channels: string[]) => {
      channelQueries.push(channels);
      return populatedInbox();
    };
    render(<InboxView fetchers={makeFetchers({ fetchInbox })} />);
    await screen.findByTestId("inbox-populated");
    expect(channelQueries[0]).toEqual([]);

    // The chip's accessible name is exactly its channel label (no aria-label),
    // matching how the e2e channel-filter spec addresses it (/^Email$/).
    const emailChip = screen.getByRole("button", { name: /^Email$/ });
    expect(emailChip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(emailChip);

    // Toggling Email re-fetches with the gmail channel scoped on the server.
    await waitFor(() => expect(channelQueries).toHaveLength(2));
    expect(channelQueries[1]).toEqual(["gmail"]);
    expect(
      screen
        .getByRole("button", { name: /^Email$/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
