// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Conversation,
  ConversationMessage,
} from "../../../api/client-types-chat";
import { reportUserViewSwitch } from "../../../chat/useSlashCommandController";
import { __setAppValueForTests } from "../../../state/app-store";
import { MessagesWidget } from "./messages";

// useWidgetNavigation.openView dispatches the `eliza:navigate:view` rail AND
// reports the switch to the proactive decider. Stub the report so we can assert
// the EXACT (viewId, viewPath) payload the tap fires without hitting fetch.
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
}));
const reportMock = vi.mocked(reportUserViewSwitch);

// The widget seeds from client.listConversations() on a cold home and qualifies
// each candidate via client.getConversationMessages(). Both are collaborators —
// mock them; the widget (unit under test) is never mocked.
const listConversations =
  vi.fn<() => Promise<{ conversations: Conversation[] }>>();
const getConversationMessages =
  vi.fn<(id: string) => Promise<{ messages: ConversationMessage[] }>>();
vi.mock("../../../api/client", () => ({
  client: {
    listConversations: () => listConversations(),
    getConversationMessages: (id: string) => getConversationMessages(id),
  },
}));

let seq = 0;
function msg(
  role: ConversationMessage["role"],
  text: string,
): ConversationMessage {
  seq += 1;
  return { id: `m${seq}`, role, text, timestamp: seq };
}
/** A real user→assistant exchange (qualifies the conversation). */
function exchange(): ConversationMessage[] {
  return [msg("user", "Hi there"), msg("assistant", "Sure thing")];
}

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: "c1",
    title: "Titled chat",
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Conversation;
}
function seed(conversations: Conversation[]): void {
  __setAppValueForTests({ conversations } as never);
}

beforeEach(() => {
  seq = 0;
  reportMock.mockReset();
  listConversations.mockReset().mockResolvedValue({ conversations: [] });
  getConversationMessages.mockReset().mockImplementation(async () => ({
    messages: exchange(),
  }));
});
afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
});

describe("MessagesWidget — interaction & lifecycle behavior", () => {
  it("home tap fires the navigation rail with the exact ('messages', '/messages') payload", async () => {
    seed([conversation({ id: "x", title: "Hello" })]);

    const navPaths: string[] = [];
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navPaths.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", onNav);

    render(<MessagesWidget pluginId="messages" slot="home" />);
    fireEvent.click(await screen.findByTestId("widget-messages"));
    window.removeEventListener("eliza:navigate:view", onNav);

    // Both halves of openView: the CustomEvent rail carries the path, and the
    // proactive report carries the view id ("messages") + path ("/messages").
    expect(navPaths).toEqual(["/messages"]);
    expect(reportMock).toHaveBeenCalledTimes(1);
    expect(reportMock).toHaveBeenCalledWith("messages", "/messages");
  });

  it("rapid-fire double/triple tap is idempotent — every click fires the same payload, no crash", async () => {
    seed([conversation({ id: "x", title: "Hello" })]);

    const navPaths: string[] = [];
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navPaths.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", onNav);

    render(<MessagesWidget pluginId="messages" slot="home" />);
    const card = await screen.findByTestId("widget-messages");
    // Three quick taps in a row.
    fireEvent.click(card);
    fireEvent.click(card);
    fireEvent.click(card);
    window.removeEventListener("eliza:navigate:view", onNav);

    // Each tap independently re-issues the identical target — no accumulation,
    // no divergent payloads, no throw.
    expect(navPaths).toEqual(["/messages", "/messages", "/messages"]);
    for (const call of reportMock.mock.calls) {
      expect(call).toEqual(["messages", "/messages"]);
    }
    expect(reportMock).toHaveBeenCalledTimes(3);
  });

  it("loading: self-hides (renders nothing) while qualification fetches are pending, then appears once they resolve", async () => {
    // Hold the qualification fetch open so we can observe the pending window.
    let release!: (v: { messages: ConversationMessage[] }) => void;
    getConversationMessages.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    seed([conversation({ id: "pending", title: "In flight" })]);

    render(<MessagesWidget pluginId="messages" slot="home" />);

    // While the fetch is unresolved the widget shows NO placeholder card...
    expect(screen.queryByTestId("widget-messages")).toBeNull();
    // ...but it IS loading (fetch was issued for the candidate) — not empty.
    await waitFor(() =>
      expect(getConversationMessages).toHaveBeenCalledWith("pending"),
    );
    expect(screen.queryByTestId("widget-messages")).toBeNull();

    await act(async () => {
      release({ messages: exchange() });
    });

    const card = await screen.findByTestId("widget-messages");
    expect(card.textContent).toContain("In flight");
  });

  it("error: a failed qualification fetch self-hides instead of surfacing a broken card", async () => {
    getConversationMessages.mockRejectedValue(new Error("network down"));
    seed([conversation({ id: "boom", title: "Doomed chat" })]);

    const { container } = render(
      <MessagesWidget pluginId="messages" slot="home" />,
    );

    await waitFor(() =>
      expect(getConversationMessages).toHaveBeenCalledWith("boom"),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("widget-messages")).toBeNull(),
    );
    expect(container.firstChild).toBeNull();
  });

  it("adversarial: a non-array store value is tolerated — no fetch, no crash, self-hides", async () => {
    // A malformed store (e.g. mid-hydration null) must not throw or spuriously
    // seed. With no valid candidates the cold-home seed runs and returns none.
    __setAppValueForTests({ conversations: null } as never);

    const { container } = render(
      <MessagesWidget pluginId="messages" slot="home" />,
    );

    await waitFor(() => expect(listConversations).toHaveBeenCalledTimes(1));
    // listConversations resolved empty → nothing to qualify → never touches
    // getConversationMessages, renders null.
    expect(getConversationMessages).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByTestId("widget-messages")).toBeNull(),
    );
    expect(container.firstChild).toBeNull();
  });

  it("scans only the freshest 8 conversations — the 2 oldest are never fetched", async () => {
    // 10 conversations, descending recency. The scan cap is 8, so the two
    // oldest must not trigger a message fetch.
    const convos = Array.from({ length: 10 }, (_, i) =>
      conversation({
        id: `c${i}`,
        title: `Chat ${i}`,
        updatedAt: new Date(Date.UTC(2026, 0, 20 - i)).toISOString(),
      }),
    );
    seed(convos);

    render(<MessagesWidget pluginId="messages" />);

    await screen.findByTestId("widget-messages");
    await waitFor(() =>
      expect(getConversationMessages).toHaveBeenCalledTimes(8),
    );
    const fetched = getConversationMessages.mock.calls.map((c) => c[0]);
    // The two oldest (c8, c9) fall outside the scanned slice.
    expect(fetched).not.toContain("c8");
    expect(fetched).not.toContain("c9");
    expect(fetched).toContain("c0");
  });
});
