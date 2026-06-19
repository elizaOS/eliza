import { describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api";
import {
  applyStreamingTextModification,
  type StreamingTextSetter,
} from "../useStreamingText";

/**
 * Build a tiny test harness around React's `useState` setter contract.
 * We don't need React here — just somewhere to apply the updater function
 * and capture the resulting array reference.
 */
function makeSetter(initial: ConversationMessage[]) {
  let current = initial;
  const setter: StreamingTextSetter = (value) => {
    current = typeof value === "function" ? value(current) : value;
  };
  return {
    setter,
    get current() {
      return current;
    },
  };
}

function userMsg(id: string, text: string): ConversationMessage {
  return { id, role: "user", text, timestamp: 0 };
}

function assistantMsg(
  id: string,
  text: string,
  extras: Partial<ConversationMessage> = {},
): ConversationMessage {
  return { id, role: "assistant", text, timestamp: 0, ...extras };
}

describe("applyStreamingTextModification", () => {
  it("append accumulates a token onto the targeted assistant turn", () => {
    const initial = [userMsg("u1", "hi"), assistantMsg("a1", "Hello")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "append",
      token: " world",
    });

    expect(harness.current[1].text).toBe("Hello world");
    expect(harness.current[0]).toBe(initial[0]);
    expect(harness.current).not.toBe(initial);
  });

  it("replace overwrites text from a cumulative snapshot", () => {
    const initial = [assistantMsg("a1", "Hel")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "replace",
      fullText: "Hello world",
    });

    expect(harness.current[0].text).toBe("Hello world");
  });

  it("complete is idempotent on identical text + failure state", () => {
    const initial = [assistantMsg("a1", "Done")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "complete",
      fullText: "Done",
    });

    expect(harness.current).toBe(initial);
  });

  it("complete updates text and stamps failureKind together", () => {
    const initial = [assistantMsg("a1", "partial")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "complete",
      fullText: "Connect a provider in Settings.",
      failureKind: "no_provider",
    });

    expect(harness.current[0].text).toBe("Connect a provider in Settings.");
    expect(harness.current[0].failureKind).toBe("no_provider");
  });

  it("complete clears a stale failureKind when none is provided", () => {
    const initial = [
      assistantMsg("a1", "partial", { failureKind: "no_provider" }),
    ];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "complete",
      fullText: "Recovered text",
    });

    expect(harness.current[0].text).toBe("Recovered text");
    expect(harness.current[0].failureKind).toBeUndefined();
  });

  it("fail sets failureKind without touching text", () => {
    const initial = [assistantMsg("a1", "Streaming text")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "fail",
      failureKind: "no_provider",
    });

    expect(harness.current[0].text).toBe("Streaming text");
    expect(harness.current[0].failureKind).toBe("no_provider");
  });

  it("fail is idempotent when the same failureKind is already set", () => {
    const initial = [assistantMsg("a1", "x", { failureKind: "no_provider" })];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "fail",
      failureKind: "no_provider",
    });

    expect(harness.current).toBe(initial);
  });

  it("interrupt stamps the interrupted flag once", () => {
    const initial = [assistantMsg("a1", "partial")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "interrupt",
    });

    expect(harness.current[0].interrupted).toBe(true);

    const afterFirst = harness.current;
    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "interrupt",
    });
    expect(harness.current).toBe(afterFirst);
  });

  it("drop removes the assistant turn entirely", () => {
    const initial = [userMsg("u1", "hi"), assistantMsg("a1", "")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "drop",
    });

    expect(harness.current).toHaveLength(1);
    expect(harness.current[0].id).toBe("u1");
  });

  it("missing messageId returns the previous reference unchanged", () => {
    const initial = [assistantMsg("a1", "Hello")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "does-not-exist",
      mode: "replace",
      fullText: "ignored",
    });

    expect(harness.current).toBe(initial);
  });

  it("a no-op replace returns the previous reference unchanged", () => {
    const initial = [assistantMsg("a1", "same")];
    const harness = makeSetter(initial);

    applyStreamingTextModification(harness.setter, {
      messageId: "a1",
      mode: "replace",
      fullText: "same",
    });

    expect(harness.current).toBe(initial);
  });

  it("calls the setter exactly once per modification", () => {
    const setter = vi.fn<StreamingTextSetter>();
    setter.mockImplementation(() => undefined);

    applyStreamingTextModification(setter, {
      messageId: "a1",
      mode: "interrupt",
    });

    expect(setter).toHaveBeenCalledTimes(1);
  });
});
