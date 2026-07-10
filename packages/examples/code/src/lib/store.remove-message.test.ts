// @vitest-environment node
//
// removeMessage powers the eliza-code error-recovery path (#11266): when a turn
// throws, the empty assistant placeholder is dropped and an error system
// message is shown instead of a lingering blank bubble.

import { beforeEach, describe, expect, it } from "bun:test";
import { useStore } from "./store.js";

describe("store.removeMessage (#11266)", () => {
  beforeEach(() => {
    useStore.setState({ rooms: [] });
  });

  it("removes only the target message, leaving the rest intact", () => {
    const s = useStore.getState();
    const room = s.createRoom("Main");
    s.addMessage(room.id, "user", "hello");
    const placeholder = s.addMessage(room.id, "assistant", "");
    s.addMessage(room.id, "system", "kept");

    useStore.getState().removeMessage(room.id, placeholder.id);

    const after = useStore.getState().rooms.find((r) => r.id === room.id);
    expect(after?.messages.map((m) => m.role)).toEqual(["user", "system"]);
    expect(after?.messages.some((m) => m.id === placeholder.id)).toBe(false);
  });

  it("is a no-op for an unknown id", () => {
    const s = useStore.getState();
    const room = s.createRoom("Main");
    s.addMessage(room.id, "user", "hello");
    useStore.getState().removeMessage(room.id, "does-not-exist");
    const after = useStore.getState().rooms.find((r) => r.id === room.id);
    expect(after?.messages).toHaveLength(1);
  });
});
