// @vitest-environment jsdom

// Drives the InboxView GUI data wrapper through the rendered DOM. Asserts the
// loading/error/empty/populated states, the
// channel-filter toggle (re-fetches with a server-side channel scope), the
// connect affordance routing through chat, and the per-item Open handoff —
// functional parity with the owner inbox surface.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { sendChatMessage } = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: () => "http://test.local",
    sendChatMessage,
  },
}));

import {
  type InboxFetchers,
  type InboxSourceStatusWire,
  InboxView,
} from "./InboxView.tsx";

function agent(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

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
    subject: "Invoice 42 overdue",
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

const ALL_COUNTS = {
  gmail: { total: 0, unread: 0 },
  discord: { total: 0, unread: 0 },
  telegram: { total: 0, unread: 0 },
  signal: { total: 0, unread: 0 },
  imessage: { total: 0, unread: 0 },
  whatsapp: { total: 0, unread: 0 },
  sms: { total: 0, unread: 0 },
  x_dm: { total: 0, unread: 0 },
};

const HEALTHY_SOURCES: InboxSourceStatusWire[] = [
  { source: "chat", state: "ok", degradations: [] },
  { source: "gmail", state: "ok", degradations: [] },
];

const GMAIL_AUTH_EXPIRED_SOURCE: InboxSourceStatusWire = {
  source: "gmail",
  state: "degraded",
  degradations: [
    {
      axis: "auth-expired",
      code: "gmail_needs_reauth",
      message:
        "Gmail authorization has expired — reconnect Google to resume inbox sync.",
      retryable: false,
    },
  ],
};

function populatedInbox(sources: InboxSourceStatusWire[] = HEALTHY_SOURCES) {
  return {
    messages: [gmailMessage(), discordMessage()],
    channelCounts: {
      ...ALL_COUNTS,
      gmail: { total: 1, unread: 1 },
      discord: { total: 1, unread: 0 },
    },
    fetchedAt: "2026-06-17T12:00:00.000Z",
    sources,
  };
}

function emptyInbox(
  connected = false,
  sources: InboxSourceStatusWire[] = HEALTHY_SOURCES,
) {
  return {
    messages: [],
    channelCounts: connected
      ? { ...ALL_COUNTS, gmail: { total: 1, unread: 0 } }
      : { ...ALL_COUNTS },
    fetchedAt: "2026-06-17T12:00:00.000Z",
    sources,
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

describe("InboxView — populated list", () => {
  it("loads the inbox on mount and renders the triage items grouped by channel", async () => {
    render(<InboxView fetchers={makeFetchers()} />);
    await screen.findByText("Invoice 42 overdue");
    expect(screen.getByText("guildmate")).toBeTruthy();
    // Per-item Open handoffs are addressable by message id.
    expect(agent("open:gmail:msg-1")).toBeTruthy();
    expect(agent("open:discord:msg-7")).toBeTruthy();
  });

  it("Open routes the thread through the assistant chat", async () => {
    render(<InboxView fetchers={makeFetchers()} />);
    await screen.findByText("Invoice 42 overdue");
    fireEvent.click(agent("open:gmail:msg-1"));
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(sendChatMessage.mock.calls[0]?.[0]).toContain("Acme Billing");
  });
});

describe("InboxView — channel filter", () => {
  it("re-fetches with a server-side channel scope when a channel chip is toggled", async () => {
    const channelQueries: string[][] = [];
    const fetchInbox = async (channels: string[]) => {
      channelQueries.push(channels);
      return populatedInbox();
    };
    render(<InboxView fetchers={makeFetchers({ fetchInbox })} />);
    await screen.findByText("Invoice 42 overdue");
    expect(channelQueries[0]).toEqual([]);

    fireEvent.click(agent("inbox-channel-gmail"));
    await waitFor(() => expect(channelQueries).toHaveLength(2));
    expect(channelQueries[1]).toEqual(["gmail"]);
  });
});

describe("InboxView — empty states", () => {
  it("shows the connect-a-channel empty state when nothing is connected", async () => {
    render(
      <InboxView
        fetchers={makeFetchers({ fetchInbox: async () => emptyInbox(false) })}
      />,
    );
    await screen.findByText("None");
    expect(agent("connect")).toBeTruthy();
  });

  it("the connect affordance routes through the assistant chat", async () => {
    render(
      <InboxView
        fetchers={makeFetchers({ fetchInbox: async () => emptyInbox(false) })}
      />,
    );
    await screen.findByText("None");
    fireEvent.click(agent("connect"));
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("shows the inbox-zero empty state when channels are connected but nothing to triage", async () => {
    render(
      <InboxView
        fetchers={makeFetchers({ fetchInbox: async () => emptyInbox(true) })}
      />,
    );
    await screen.findByText(/Inbox zero/i);
    expect(screen.queryByText("None")).toBeNull();
  });
});

describe("InboxView — degraded connector", () => {
  it("renders the degraded banner alongside messages from healthy channels", async () => {
    render(
      <InboxView
        fetchers={makeFetchers({
          fetchInbox: async () =>
            populatedInbox([
              { source: "chat", state: "ok", degradations: [] },
              GMAIL_AUTH_EXPIRED_SOURCE,
            ]),
        })}
      />,
    );
    await screen.findByText("Gmail unavailable");
    // Partial degradation: the healthy channels' messages still render.
    expect(screen.getByText("Invoice 42 overdue")).toBeTruthy();
    expect(screen.getByText(/Gmail authorization has expired/i)).toBeTruthy();
    expect(agent("reconnect:gmail")).toBeTruthy();
  });

  it("an empty inbox with a degraded source never reads as inbox zero", async () => {
    render(
      <InboxView
        fetchers={makeFetchers({
          fetchInbox: async () =>
            emptyInbox(true, [
              { source: "chat", state: "ok", degradations: [] },
              GMAIL_AUTH_EXPIRED_SOURCE,
            ]),
        })}
      />,
    );
    await screen.findByText("Gmail unavailable");
    expect(screen.queryByText(/Inbox zero/i)).toBeNull();
    expect(
      screen.getByText(/No messages from reachable channels/i),
    ).toBeTruthy();
  });

  it("Reconnect routes a reauth request for the degraded connector through chat", async () => {
    render(
      <InboxView
        fetchers={makeFetchers({
          fetchInbox: async () => populatedInbox([GMAIL_AUTH_EXPIRED_SOURCE]),
        })}
      />,
    );
    await screen.findByText("Gmail unavailable");
    fireEvent.click(agent("reconnect:gmail"));
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    const prompt = String(sendChatMessage.mock.calls[0]?.[0]);
    expect(prompt).toContain("Reconnect Gmail");
    expect(prompt).toContain("Gmail authorization has expired");
  });

  it("disconnected (never-connected) sources do not render the degraded banner", async () => {
    render(
      <InboxView
        fetchers={makeFetchers({
          fetchInbox: async () =>
            emptyInbox(false, [
              {
                source: "gmail",
                state: "disconnected",
                degradations: [
                  {
                    axis: "disconnected",
                    code: "gmail_disconnected",
                    message: "Gmail is not connected.",
                    retryable: false,
                  },
                ],
              },
            ]),
        })}
      />,
    );
    // Not-connected is the connect empty state, not a degradation warning.
    await screen.findByText("None");
    expect(screen.queryByText("Gmail unavailable")).toBeNull();
    expect(agent("connect")).toBeTruthy();
  });
});

describe("InboxView — audit settle signal (#15912)", () => {
  it("exposes data-view-status=loading until the fetch settles, then drops it", async () => {
    // The loading placeholder lists all 8 channels in its filter row while the
    // settled list shows only the connected two, so the loading frame is denser.
    // A host readiness/aesthetic-audit gate that samples before the fetch
    // resolves must be able to tell "still loading" apart from "settled" — else
    // it measures the denser placeholder and flips the divider-density ratchet
    // between identical-code runs (#15912). The shared `data-view-status`
    // settle marker is that signal.
    let resolveFetch!: (value: ReturnType<typeof populatedInbox>) => void;
    const gate = new Promise<ReturnType<typeof populatedInbox>>((resolve) => {
      resolveFetch = resolve;
    });
    render(<InboxView fetchers={makeFetchers({ fetchInbox: () => gate })} />);

    // Loading: the settle marker is present and the placeholder lists all 8
    // channel chips (the denser frame a racing capture would otherwise measure).
    const loadingMarker = document.querySelector(
      '[data-view-status="loading"]',
    );
    expect(loadingMarker).not.toBeNull();
    expect(
      document.querySelectorAll('[data-agent-id^="inbox-channel-"]'),
    ).toHaveLength(8);

    resolveFetch(populatedInbox());
    await screen.findByText("Invoice 42 overdue");

    // Settled: the marker is gone (capture proceeds) and only the two connected
    // channels remain in the filter row — the sparser, baselined frame.
    expect(document.querySelector('[data-view-status="loading"]')).toBeNull();
    expect(
      document.querySelectorAll('[data-agent-id^="inbox-channel-"]'),
    ).toHaveLength(2);
  });
});

describe("InboxView — error path", () => {
  it("shows the error state with a Retry that refetches into the populated state", async () => {
    let attempt = 0;
    const fetchInbox = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return populatedInbox();
    };
    render(<InboxView fetchers={makeFetchers({ fetchInbox })} />);
    await screen.findByText(/Couldn't load inbox/i);
    fireEvent.click(agent("retry"));
    await screen.findByText("Invoice 42 overdue");
  });
});
