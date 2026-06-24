// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FROZEN_EPOCH_MS, withFrozenClock } from "../../../../test/determinism";
import type { Conversation } from "../../../api/client-types-chat";
import { MockAppProvider } from "../../../storybook/mock-providers";
import { MessagesWidget } from "./messages";

afterEach(() => {
  cleanup();
});

/**
 * Build a `Conversation` whose `updatedAt` is `minutesAgo` before the frozen
 * clock instant, so `formatRelativeTime` is deterministic under the wrapped
 * clock. `title` is passed through verbatim (empty string exercises the
 * "Untitled" fallback).
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

// #9143/#9304 — the populated branch of the frontpage Messages widget.
// messages.test.tsx covers only the empty return-null branch; this asserts the
// real rendered behaviour: sort order, the top-4 cap, the "Untitled" fallback,
// and relative-time labels (frozen for determinism).
describe("MessagesWidget — populated (#9304)", () => {
  beforeEach(() => withFrozenClock());

  it("orders conversations newest-updated first", () => {
    // Provided out of order: middle, oldest, newest.
    renderWithConversations([
      conversation("b", "Middle chat", 30),
      conversation("c", "Oldest chat", 120),
      conversation("a", "Newest chat", 2),
    ]);

    const items = screen.getAllByRole("listitem");
    expect(
      items.map((li) => within(li).getByText(/chat$/).textContent),
    ).toEqual(["Newest chat", "Middle chat", "Oldest chat"]);
  });

  it("caps the list at the top 4 most-recent conversations", () => {
    renderWithConversations([
      conversation("c1", "One", 1),
      conversation("c2", "Two", 2),
      conversation("c3", "Three", 3),
      conversation("c4", "Four", 4),
      conversation("c5", "Five", 5),
      conversation("c6", "Six", 6),
    ]);

    const titles = screen
      .getAllByRole("listitem")
      .map(
        (li) =>
          within(li).getByText(/^(One|Two|Three|Four|Five|Six)$/).textContent,
      );
    expect(titles).toEqual(["One", "Two", "Three", "Four"]);
    expect(screen.queryByText("Five")).toBeNull();
    expect(screen.queryByText("Six")).toBeNull();
  });

  it("renders 'Untitled' for a conversation with an empty title", () => {
    renderWithConversations([conversation("blank", "", 5)]);
    expect(screen.getByText("Untitled").textContent).toBe("Untitled");
  });

  it("renders deterministic relative-time labels under the frozen clock", () => {
    renderWithConversations([
      conversation("a", "Just now chat", 0),
      conversation("b", "Minutes chat", 5),
      conversation("c", "Hours chat", 3 * 60),
      conversation("d", "Days chat", 2 * 24 * 60),
    ]);

    const labels = screen
      .getAllByText(/(just now|\dm ago|\dh ago|\dd ago)/)
      .map((el) => el.textContent);
    expect(labels).toEqual(["just now", "5m ago", "3h ago", "2d ago"]);
  });
});
