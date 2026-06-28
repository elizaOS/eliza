// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FROZEN_EPOCH_MS, withFrozenClock } from "../../../../test/determinism";
import type {
  Conversation,
  ConversationMessage,
} from "../../../api/client-types-chat";
import { MockAppProvider } from "../../../storybook/mock-providers";
import { MessagesWidget } from "./messages";

// Every conversation is qualified by reading its messages via the client; mock
// it to return a real user→assistant exchange so the populated branch renders.
// listConversations is unused here (the store is always seeded) but mocked so
// the module import resolves cleanly.
const getConversationMessages = vi.fn<
  (id: string) => Promise<{ messages: ConversationMessage[] }>
>(async () => ({
  messages: [
    { id: "u", role: "user", text: "hello", timestamp: 1 },
    { id: "a", role: "assistant", text: "hi", timestamp: 2 },
  ],
}));
vi.mock("../../../api/client", () => ({
  client: {
    listConversations: async () => ({ conversations: [] }),
    getConversationMessages: (id: string) => getConversationMessages(id),
  },
}));

afterEach(() => {
  cleanup();
  getConversationMessages.mockClear();
});

/**
 * Build a `Conversation` whose `updatedAt` is `minutesAgo` before the frozen
 * clock instant, so `formatRelativeTime` is deterministic under the wrapped
 * clock. `title` is passed through verbatim.
 */
function conversation(
  id: string,
  title: string,
  minutesAgo: number,
): Conversation {
  const updatedAt = new Date(FROZEN_EPOCH_MS - minutesAgo * 60_000);
  return {
    id,
    title,
    roomId: `room-${id}`,
    createdAt: updatedAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

function renderWithConversations(conversations: Conversation[]) {
  return render(
    <MockAppProvider value={{ conversations }}>
      <MessagesWidget pluginId="messages" />
    </MockAppProvider>,
  );
}

// #9143/#9304 — the populated branch of the frontpage Messages widget. The
// empty/return-null and named/agent-responded filtering branches are covered in
// messages.test.tsx; this asserts the real rendered list behaviour for already
// qualifying (named, answered) conversations: sort order, the top-4 cap, and
// relative-time labels (frozen for determinism).
describe("MessagesWidget — populated (#9304)", () => {
  beforeEach(() => withFrozenClock());

  it("orders qualifying conversations newest-updated first", async () => {
    // Provided out of order: middle, oldest, newest.
    renderWithConversations([
      conversation("b", "Middle chat", 30),
      conversation("c", "Oldest chat", 120),
      conversation("a", "Newest chat", 2),
    ]);

    const items = await screen.findAllByRole("listitem");
    expect(
      items.map((li) => within(li).getByText(/chat$/).textContent),
    ).toEqual(["Newest chat", "Middle chat", "Oldest chat"]);
  });

  it("caps the list at the top 4 most-recent qualifying conversations", async () => {
    renderWithConversations([
      conversation("c1", "One", 1),
      conversation("c2", "Two", 2),
      conversation("c3", "Three", 3),
      conversation("c4", "Four", 4),
      conversation("c5", "Five", 5),
      conversation("c6", "Six", 6),
    ]);

    const items = await screen.findAllByRole("listitem");
    const titles = items.map(
      (li) =>
        within(li).getByText(/^(One|Two|Three|Four|Five|Six)$/).textContent,
    );
    expect(titles).toEqual(["One", "Two", "Three", "Four"]);
    expect(screen.queryByText("Five")).toBeNull();
    expect(screen.queryByText("Six")).toBeNull();
  });

  it("names a conversation from its latest user message when the title is generic", async () => {
    getConversationMessages.mockResolvedValueOnce({
      messages: [
        {
          id: "u",
          role: "user",
          text: "Draft my quarterly report",
          timestamp: 1,
        },
        { id: "a", role: "assistant", text: "On it", timestamp: 2 },
      ],
    });
    renderWithConversations([conversation("blank", "New Chat", 5)]);

    const item = await screen.findByRole("listitem");
    expect(within(item).getByText(/Draft my quarterly report/)).toBeTruthy();
    expect(screen.queryByText("New Chat")).toBeNull();
  });

  it("renders deterministic relative-time labels under the frozen clock", async () => {
    renderWithConversations([
      conversation("a", "Just now chat", 0),
      conversation("b", "Minutes chat", 5),
      conversation("c", "Hours chat", 3 * 60),
      conversation("d", "Days chat", 2 * 24 * 60),
    ]);

    await screen.findAllByRole("listitem");
    const labels = screen
      .getAllByText(/(just now|\dm ago|\dh ago|\dd ago)/)
      .map((el) => el.textContent);
    expect(labels).toEqual(["just now", "5m ago", "3h ago", "2d ago"]);
  });
});
