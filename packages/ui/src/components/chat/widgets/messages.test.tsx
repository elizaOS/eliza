// @vitest-environment jsdom
import {
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
import { __setAppValueForTests } from "../../../state/app-store";
import { MessagesWidget } from "./messages";

// useWidgetNavigation → reportUserViewSwitch (slash-command controller); stub it
// so the home-card click test isolates the navigation rail (the CustomEvent).
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
}));

// The cold-home seed calls client.listConversations(); each candidate's
// qualification reads client.getConversationMessages(). Mock both so the
// empty / seed / qualify branches are deterministic. By default there are no
// conversations to seed and every conversation has a real back-and-forth.
const listConversations = vi.fn<
  () => Promise<{ conversations: Conversation[] }>
>(async () => ({ conversations: [] }));
const messagesById = new Map<string, ConversationMessage[]>();
const getConversationMessages = vi.fn<
  (id: string) => Promise<{ messages: ConversationMessage[] }>
>(async (id) => ({ messages: messagesById.get(id) ?? exchange() }));
vi.mock("../../../api/client", () => ({
  client: {
    listConversations: () => listConversations(),
    getConversationMessages: (id: string) => getConversationMessages(id),
  },
}));

let messageSeq = 0;
function message(
  role: ConversationMessage["role"],
  text: string,
): ConversationMessage {
  messageSeq += 1;
  return { id: `m${messageSeq}`, role, text, timestamp: messageSeq };
}

/** A real exchange: a user message answered by the agent. */
function exchange(userText = "Hi there"): ConversationMessage[] {
  return [message("user", userText), message("assistant", "Sure thing")];
}

/** A greeting-only conversation: the agent's lone turn precedes any user input. */
function greetingOnly(): ConversationMessage[] {
  return [message("assistant", "Hi! How can I help?")];
}

beforeEach(() => {
  messageSeq = 0;
  messagesById.clear();
  listConversations.mockResolvedValue({ conversations: [] });
});

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  listConversations.mockReset();
  getConversationMessages.mockClear();
});

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: "c1",
    title: "Untitled",
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Conversation;
}

function seedConversations(conversations: Conversation[]): void {
  __setAppValueForTests({ conversations } as never);
}

// #9143 — the frontpage Messages widget renders recent conversations.
// #9226 — when there are no conversations it renders nothing (no empty
// placeholder card) so the Launcher home isn't cluttered with dead slots.
// It only shows NAMED conversations the agent has actually responded in.
describe("MessagesWidget (#9143)", () => {
  it("renders nothing when there are no conversations (#9226)", () => {
    const { container } = render(<MessagesWidget pluginId="messages" />);
    expect(screen.queryByTestId("widget-messages")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("home slot: ONE compact, icon-first card — most-recent qualifying conversation + overflow badge, whole card clickable", async () => {
    seedConversations([
      conversation({
        id: "old",
        title: "Old chat",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      conversation({
        id: "new",
        title: "Latest chat",
        updatedAt: "2026-06-01T00:00:00.000Z",
      }),
    ]);

    render(<MessagesWidget pluginId="messages" slot="home" />);

    const card = await screen.findByTestId("widget-messages");
    expect(card.tagName).toBe("BUTTON");
    // The single datum is the most-recent qualifying conversation's name; the
    // older one is NOT rendered as a separate row.
    expect(card.textContent).toContain("Latest chat");
    expect(card.textContent).not.toContain("Old chat");
    // The remaining qualifying conversation count is a "+N" badge.
    expect(card.textContent).toContain("+1");
    expect(card.getAttribute("aria-label")).toMatch(/Latest chat/);
  });

  it("home slot: skips conversations where the agent has not responded (empty / greeting-only)", async () => {
    messagesById.set("greeting", greetingOnly());
    messagesById.set("draft", []);
    messagesById.set("real", exchange());
    seedConversations([
      conversation({
        id: "greeting",
        title: "Greeting only",
        updatedAt: "2026-06-03T00:00:00.000Z",
      }),
      conversation({
        id: "draft",
        title: "Empty draft",
        updatedAt: "2026-06-02T00:00:00.000Z",
      }),
      conversation({
        id: "real",
        title: "Answered chat",
        updatedAt: "2026-06-01T00:00:00.000Z",
      }),
    ]);

    render(<MessagesWidget pluginId="messages" slot="home" />);

    const card = await screen.findByTestId("widget-messages");
    // Only the conversation with a real exchange surfaces — and with no
    // overflow it has no "+N" badge.
    expect(card.textContent).toContain("Answered chat");
    expect(card.textContent).not.toContain("Greeting only");
    expect(card.textContent).not.toContain("Empty draft");
    expect(card.textContent).not.toContain("+");
  });

  it("self-hides when no conversation has a real agent exchange", async () => {
    messagesById.set("g", greetingOnly());
    seedConversations([conversation({ id: "g", title: "Just a greeting" })]);

    const { container } = render(
      <MessagesWidget pluginId="messages" slot="home" />,
    );

    // It must settle to null — wait for the qualification fetch to resolve.
    await waitFor(() => {
      expect(getConversationMessages).toHaveBeenCalledWith("g");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("widget-messages")).toBeNull();
    });
    expect(container.firstChild).toBeNull();
  });

  it("derives a short name from the latest user message when the title is a server default", async () => {
    messagesById.set("nameless", [
      message("user", "Help me plan a trip to Lisbon next month"),
      message("assistant", "Happy to help"),
    ]);
    // "New Chat" is a generic server-assigned title → fall back to user text.
    seedConversations([conversation({ id: "nameless", title: "New Chat" })]);

    render(<MessagesWidget pluginId="messages" slot="home" />);

    const card = await screen.findByTestId("widget-messages");
    expect(card.textContent).toContain("Help me plan a trip to Lisbon");
    expect(card.textContent).not.toContain("New Chat");
  });

  it("home slot: clicking the card navigates to the Messages view", async () => {
    seedConversations([conversation({ id: "x", title: "Hello" })]);

    const navEvents: string[] = [];
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navEvents.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", onNav);

    render(<MessagesWidget pluginId="messages" slot="home" />);
    fireEvent.click(await screen.findByTestId("widget-messages"));
    window.removeEventListener("eliza:navigate:view", onNav);

    expect(navEvents).toContain("/messages");
  });

  it("chat-sidebar slot: keeps the existing list (a row per qualifying conversation, not a single card button)", async () => {
    seedConversations([
      conversation({ id: "a", title: "Alpha" }),
      conversation({ id: "b", title: "Beta" }),
    ]);

    render(<MessagesWidget pluginId="messages" slot="chat-sidebar" />);

    const widget = await screen.findByTestId("widget-messages");
    expect(widget.tagName).not.toBe("BUTTON");
    expect(widget.textContent).toContain("Alpha");
    expect(widget.textContent).toContain("Beta");
  });

  it("home slot: applies the host-provided grid span to its single root element", async () => {
    seedConversations([conversation({ id: "x", title: "Hello" })]);

    const { container } = render(
      <MessagesWidget
        pluginId="messages"
        slot="home"
        spanClassName="col-span-4 row-span-1"
      />,
    );

    await screen.findByTestId("widget-messages");
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("col-span-4");
    expect(root.className).toContain("row-span-1");
    // The card button lives inside that single grid-item root.
    expect(
      root.querySelector('[data-testid="widget-messages"]'),
    ).not.toBeNull();
  });

  it("home slot: defaults to col-span-2 when no spanClassName is provided", async () => {
    seedConversations([conversation({ id: "x", title: "Hello" })]);

    const { container } = render(
      <MessagesWidget pluginId="messages" slot="home" />,
    );

    await screen.findByTestId("widget-messages");
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("col-span-2");
  });

  it("cold home: seeds from client.listConversations() when the store is empty", async () => {
    // Store empty → the widget fetches the list once, then qualifies each.
    listConversations.mockResolvedValue({
      conversations: [conversation({ id: "seed", title: "Seeded chat" })],
    });

    render(<MessagesWidget pluginId="messages" slot="home" />);

    await waitFor(() => {
      expect(screen.getByTestId("widget-messages").textContent).toContain(
        "Seeded chat",
      );
    });
    expect(listConversations).toHaveBeenCalledTimes(1);
  });

  it("does not seed from the client when the store already has conversations", async () => {
    seedConversations([conversation({ id: "x", title: "Hello" })]);

    render(<MessagesWidget pluginId="messages" slot="home" />);

    expect(await screen.findByTestId("widget-messages")).toBeTruthy();
    expect(screen.getByTestId("widget-messages").textContent).toContain(
      "Hello",
    );
    expect(listConversations).not.toHaveBeenCalled();
  });
});
