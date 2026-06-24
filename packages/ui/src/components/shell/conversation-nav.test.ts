import { describe, expect, it, vi } from "vitest";
import type { Conversation } from "../../api/client-types-chat";
import { buildConversationNav } from "./useShellController";

/**
 * The conversation list is most-recent-first, so index 0 is the newest. "prev"
 * walks toward newer (lower index), "next" toward older (higher index). These
 * tests pin the boundary semantics and the adjacent-id selection that the
 * overlay's horizontal swipe (#8929) depends on.
 */

function conv(id: string): Conversation {
  return {
    id,
    title: id,
    roomId: `room-${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const LIST = [conv("a"), conv("b"), conv("c")];

describe("buildConversationNav", () => {
  it("at the newest (first) conversation: only next is navigable", () => {
    const onSelect = vi.fn();
    const nav = buildConversationNav(LIST, "a", onSelect);
    expect(nav.hasPrev).toBe(false);
    expect(nav.hasNext).toBe(true);

    nav.goPrev();
    expect(onSelect).not.toHaveBeenCalled();

    nav.goNext();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("in the middle: both directions select the adjacent conversation", () => {
    const onSelect = vi.fn();
    const nav = buildConversationNav(LIST, "b", onSelect);
    expect(nav.hasPrev).toBe(true);
    expect(nav.hasNext).toBe(true);

    nav.goPrev();
    expect(onSelect).toHaveBeenLastCalledWith("a");

    nav.goNext();
    expect(onSelect).toHaveBeenLastCalledWith("c");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("at the oldest (last) conversation: only prev is navigable", () => {
    const onSelect = vi.fn();
    const nav = buildConversationNav(LIST, "c", onSelect);
    expect(nav.hasPrev).toBe(true);
    expect(nav.hasNext).toBe(false);

    nav.goNext();
    expect(onSelect).not.toHaveBeenCalled();

    nav.goPrev();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("when the active conversation is not in the list: neither direction navigates", () => {
    const onSelect = vi.fn();
    const nav = buildConversationNav(LIST, "missing", onSelect);
    expect(nav.hasPrev).toBe(false);
    expect(nav.hasNext).toBe(false);

    nav.goPrev();
    nav.goNext();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("with a single conversation: neither direction navigates", () => {
    const onSelect = vi.fn();
    const nav = buildConversationNav([conv("solo")], "solo", onSelect);
    expect(nav.hasPrev).toBe(false);
    expect(nav.hasNext).toBe(false);
  });

  it("tolerates an empty / nullish list without throwing", () => {
    const onSelect = vi.fn();
    for (const list of [[], null, undefined]) {
      const nav = buildConversationNav(list, "a", onSelect);
      expect(nav.hasPrev).toBe(false);
      expect(nav.hasNext).toBe(false);
      nav.goPrev();
      nav.goNext();
    }
    expect(onSelect).not.toHaveBeenCalled();
  });
});
