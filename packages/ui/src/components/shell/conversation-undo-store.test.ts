import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dismissConversationUndo,
  getConversationUndoSnapshot,
  requestConversationResetUndo,
  showConversationUndo,
  subscribeConversationUndo,
} from "./conversation-undo-store";

afterEach(() => {
  dismissConversationUndo();
});

describe("conversation-undo-store", () => {
  it("shows and dismisses the undo request, notifying subscribers", () => {
    const listener = vi.fn();
    const unsub = subscribeConversationUndo(listener);
    expect(getConversationUndoSnapshot()).toBeNull();

    const id = showConversationUndo({
      label: "Conversation cleared",
      actionLabel: "Undo",
      onUndo: () => {},
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getConversationUndoSnapshot()?.id).toBe(id);

    dismissConversationUndo(id);
    expect(getConversationUndoSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
  });

  it("does not dismiss a newer request via a stale id", () => {
    const first = showConversationUndo({
      label: "a",
      actionLabel: "Undo",
      onUndo: () => {},
    });
    const second = showConversationUndo({
      label: "b",
      actionLabel: "Undo",
      onUndo: () => {},
    });
    expect(second).toBeGreaterThan(first);
    // A stale timer firing with the old id must not close the new toast.
    dismissConversationUndo(first);
    expect(getConversationUndoSnapshot()?.id).toBe(second);
  });

  it("requestConversationResetUndo wires restore to the previous id", () => {
    const restore = vi.fn();
    requestConversationResetUndo({
      previousConversationId: "conv-123",
      restore,
    });
    const snapshot = getConversationUndoSnapshot();
    expect(snapshot).not.toBeNull();
    snapshot?.onUndo();
    expect(restore).toHaveBeenCalledWith("conv-123");
  });

  it("requestConversationResetUndo is a no-op without a previous conversation", () => {
    requestConversationResetUndo({
      previousConversationId: null,
      restore: vi.fn(),
    });
    expect(getConversationUndoSnapshot()).toBeNull();
  });

  it("uses translate overrides when provided", () => {
    requestConversationResetUndo({
      previousConversationId: "c1",
      restore: vi.fn(),
      translate: (key) =>
        key === "chat.conversationCleared" ? "Chat geleert" : "Ruckgangig",
    });
    const snapshot = getConversationUndoSnapshot();
    expect(snapshot?.label).toBe("Chat geleert");
    expect(snapshot?.actionLabel).toBe("Ruckgangig");
  });
});
