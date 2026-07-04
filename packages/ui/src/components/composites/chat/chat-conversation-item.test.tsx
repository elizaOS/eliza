// @vitest-environment jsdom
/**
 * Renders ChatConversationItem in jsdom and asserts row selection, the
 * more-actions/right-click menus, the game-modal inline rename+delete, the
 * delete-confirm flow, and mobile long-press (with trailing-click suppression).
 * RTL, no live model.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatConversationItem } from "./chat-conversation-item";
import type { ChatConversationSummary } from "./chat-types";

afterEach(cleanup);

const conversation: ChatConversationSummary = {
  id: "conv-1",
  title: "Planning the launch",
  updatedAtLabel: "2h ago",
};

const labels = {
  actions: "More actions",
  delete: "Delete",
  deleteConfirm: "Delete?",
  deleteNo: "No",
  deleteYes: "Yes",
  rename: "Rename",
};

function renderItem(
  props: Partial<React.ComponentProps<typeof ChatConversationItem>> = {},
) {
  const onSelect = props.onSelect ?? vi.fn();
  const result = render(
    <ChatConversationItem
      conversation={conversation}
      isActive={false}
      labels={labels}
      onSelect={onSelect}
      {...props}
    />,
  );
  return { ...result, onSelect };
}

describe("ChatConversationItem", () => {
  it("renders the conversation title and marks the active row", () => {
    renderItem({ isActive: true });
    expect(screen.getByText("Planning the launch")).toBeTruthy();
    expect(screen.getByTestId("conv-item").getAttribute("data-active")).toBe(
      "true",
    );
  });

  it("fires onSelect when the row is clicked", () => {
    const { onSelect } = renderItem();
    fireEvent.click(screen.getByTestId("conv-select"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("opens the actions menu via the more-actions button (default variant)", () => {
    const onOpenActions = vi.fn();
    renderItem({ onOpenActions });
    fireEvent.click(screen.getByTestId("conv-actions"));
    expect(onOpenActions).toHaveBeenCalledTimes(1);
    // The summary is forwarded so the menu can target this conversation.
    expect(onOpenActions.mock.calls[0]?.[1]).toMatchObject({ id: "conv-1" });
  });

  it("opens the actions menu on right-click (desktop context menu)", () => {
    const onOpenActions = vi.fn();
    renderItem({ onOpenActions });
    fireEvent.contextMenu(screen.getByTestId("conv-select"));
    expect(onOpenActions).toHaveBeenCalledTimes(1);
  });

  it("exposes inline rename + delete affordances in the game-modal variant", () => {
    const onRequestRename = vi.fn();
    const onRequestDeleteConfirm = vi.fn();
    renderItem({
      variant: "game-modal",
      onRequestRename,
      onRequestDeleteConfirm,
    });

    fireEvent.click(screen.getByTestId("conv-rename"));
    expect(onRequestRename).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("conv-delete"));
    expect(onRequestDeleteConfirm).toHaveBeenCalledTimes(1);
  });

  it("renders the delete-confirm prompt and wires Yes/No while confirming", () => {
    const onConfirmDelete = vi.fn();
    const onCancelDelete = vi.fn();
    renderItem({
      isConfirmingDelete: true,
      onConfirmDelete,
      onCancelDelete,
    });

    // The inline more-actions button is replaced by the confirm prompt.
    expect(screen.queryByTestId("conv-actions")).toBeNull();
    expect(screen.getByText("Delete?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(onConfirmDelete).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(onCancelDelete).toHaveBeenCalledTimes(1);
  });

  it("disables the confirm buttons while a delete is in flight", () => {
    renderItem({ isConfirmingDelete: true, deleting: true });
    const yes = screen.getByRole("button", { name: "..." });
    expect((yes as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens actions on a mobile long-press and suppresses the trailing click", () => {
    vi.useFakeTimers();
    try {
      const onOpenActions = vi.fn();
      const onSelect = vi.fn();
      renderItem({ mobile: true, onOpenActions, onSelect });

      const select = screen.getByTestId("conv-select");
      fireEvent.touchStart(select, {
        touches: [{ clientX: 10, clientY: 10 }],
      });
      // The 450ms long-press timer fires the actions menu.
      vi.advanceTimersByTime(460);
      expect(onOpenActions).toHaveBeenCalledTimes(1);

      // The click that follows the long-press release is swallowed (no select).
      fireEvent.click(select);
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the long-press when the touch ends early (still selects on tap)", () => {
    vi.useFakeTimers();
    try {
      const onOpenActions = vi.fn();
      const onSelect = vi.fn();
      renderItem({ mobile: true, onOpenActions, onSelect });

      const select = screen.getByTestId("conv-select");
      fireEvent.touchStart(select, {
        touches: [{ clientX: 10, clientY: 10 }],
      });
      fireEvent.touchEnd(select); // released before the 450ms threshold
      vi.advanceTimersByTime(460);
      expect(onOpenActions).not.toHaveBeenCalled();

      fireEvent.click(select);
      expect(onSelect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
