// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../../../api/client-types-chat";
import { __setAppValueForTests } from "../../../state/app-store";
import { MessagesWidget } from "./messages";

// useWidgetNavigation → reportUserViewSwitch (slash-command controller); stub it
// so the home-card click test isolates the navigation rail (the CustomEvent).
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
}));

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
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
// placeholder card) so the Springboard home isn't cluttered with dead slots.
describe("MessagesWidget (#9143)", () => {
  it("renders nothing when there are no conversations (#9226)", () => {
    const { container } = render(<MessagesWidget pluginId="messages" />);
    expect(screen.queryByTestId("widget-messages")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("home slot: ONE compact, icon-first card — most-recent conversation + count badge, whole card clickable", () => {
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

    const card = screen.getByTestId("widget-messages");
    expect(card.tagName).toBe("BUTTON");
    // The single datum is the most-recent conversation's title; the older one
    // is NOT rendered as a separate row.
    expect(card.textContent).toContain("Latest chat");
    expect(card.textContent).not.toContain("Old chat");
    // Count is a badge.
    expect(card.textContent).toContain("2");
    expect(card.getAttribute("aria-label")).toMatch(/Latest chat/);
  });

  it("home slot: clicking the card navigates to the Messages view", () => {
    seedConversations([conversation({ id: "x", title: "Hello" })]);

    const navEvents: string[] = [];
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navEvents.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", onNav);

    render(<MessagesWidget pluginId="messages" slot="home" />);
    fireEvent.click(screen.getByTestId("widget-messages"));
    window.removeEventListener("eliza:navigate:view", onNav);

    expect(navEvents).toContain("/messages");
  });

  it("chat-sidebar slot: keeps the existing list (a row per conversation, not a single card button)", () => {
    seedConversations([
      conversation({ id: "a", title: "Alpha" }),
      conversation({ id: "b", title: "Beta" }),
    ]);

    render(<MessagesWidget pluginId="messages" slot="chat-sidebar" />);

    const widget = screen.getByTestId("widget-messages");
    expect(widget.tagName).not.toBe("BUTTON");
    expect(widget.textContent).toContain("Alpha");
    expect(widget.textContent).toContain("Beta");
  });
});
