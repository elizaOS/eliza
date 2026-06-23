// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatConversationItem } from "./chat-conversation-item";
import type { ChatConversationSummary } from "./chat-types";

afterEach(() => cleanup());

const conversation: ChatConversationSummary = {
  id: "conv-1",
  title: "Planning the launch sequence",
  updatedAtLabel: "2h ago",
};

function renderItem(
  over: Partial<React.ComponentProps<typeof ChatConversationItem>> = {},
) {
  const onSelect = vi.fn();
  const utils = render(
    <ChatConversationItem
      conversation={conversation}
      isActive={false}
      onSelect={onSelect}
      {...over}
    />,
  );
  return { onSelect, ...utils };
}

describe("ChatConversationItem", () => {
  it("renders the conversation title", () => {
    renderItem();
    expect(screen.getByText("Planning the launch sequence")).toBeTruthy();
  });

  it("prefers an explicit displayTitle over the conversation title", () => {
    renderItem({ displayTitle: "Renamed thread" });
    expect(screen.getByText("Renamed thread")).toBeTruthy();
    expect(screen.queryByText("Planning the launch sequence")).toBeNull();
  });

  it("reflects the active state via data-active", () => {
    const { container, rerender, onSelect } = renderItem({ isActive: true });
    expect(
      container
        .querySelector('[data-testid="conv-item"]')
        ?.getAttribute("data-active"),
    ).toBe("true");
    rerender(
      <ChatConversationItem
        conversation={conversation}
        isActive={false}
        onSelect={onSelect}
      />,
    );
    expect(
      container
        .querySelector('[data-testid="conv-item"]')
        ?.getAttribute("data-active"),
    ).toBeNull();
  });

  it("calls onSelect when the row is clicked", () => {
    const { onSelect } = renderItem();
    fireEvent.click(screen.getByTestId("conv-select"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders an unread indicator only when isUnread is set", () => {
    const { container, rerender, onSelect } = renderItem({ isUnread: true });
    expect(
      container
        .querySelector('[data-testid="conv-select"]')
        ?.querySelector("span.rounded-full"),
    ).toBeTruthy();
    rerender(
      <ChatConversationItem
        conversation={conversation}
        isActive={false}
        isUnread={false}
        onSelect={onSelect}
      />,
    );
    expect(
      container
        .querySelector('[data-testid="conv-select"]')
        ?.querySelector("span.rounded-full"),
    ).toBeFalsy();
  });

  it("invokes onOpenActions from the actions button with the conversation", () => {
    const onOpenActions = vi.fn();
    renderItem({ onOpenActions });
    fireEvent.click(screen.getByTestId("conv-actions"));
    expect(onOpenActions).toHaveBeenCalledTimes(1);
    expect(onOpenActions.mock.calls[0]?.[1]).toBe(conversation);
  });

  it("drives the delete-confirm flow (Yes → confirm, No → cancel)", () => {
    const onConfirmDelete = vi.fn();
    const onCancelDelete = vi.fn();
    const { rerender } = renderItem({
      isConfirmingDelete: true,
      onConfirmDelete,
      onCancelDelete,
    });
    // While confirming, the actions button is hidden in favor of Yes/No.
    expect(screen.queryByTestId("conv-actions")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(onConfirmDelete).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(onCancelDelete).toHaveBeenCalledTimes(1);

    // Respects custom labels.
    rerender(
      <ChatConversationItem
        conversation={conversation}
        isActive={false}
        isConfirmingDelete
        labels={{ deleteYes: "Confirm", deleteNo: "Keep" }}
        onConfirmDelete={onConfirmDelete}
        onCancelDelete={onCancelDelete}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });
});
