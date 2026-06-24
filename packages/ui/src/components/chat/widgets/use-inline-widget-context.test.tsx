// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInlineWidgetContext } from "./use-inline-widget-context";

/**
 * The hook is the single source of truth both chat surfaces build their
 * InlineWidgetContext from (#9304). These assertions pin the exact behavior of
 * each handler so the two surfaces can never drift.
 */
describe("useInlineWidgetContext", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sendAction sends the raw value through the action-message pipeline", () => {
    const send = vi.fn(async () => {});
    const setInput = vi.fn();
    const { result } = renderHook(() => useInlineWidgetContext(send, setInput));
    result.current.sendAction("yes");
    expect(send).toHaveBeenCalledWith("yes");
    expect(setInput).not.toHaveBeenCalled();
  });

  it("prefillComposer fills the composer draft, never sends", () => {
    const send = vi.fn(async () => {});
    const setInput = vi.fn();
    const { result } = renderHook(() => useInlineWidgetContext(send, setInput));
    result.current.prefillComposer("draft text");
    expect(setInput).toHaveBeenCalledWith("draft text");
    expect(send).not.toHaveBeenCalled();
  });

  it("navigate dispatches a viewPath for a /-prefixed payload", () => {
    const send = vi.fn(async () => {});
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("eliza:navigate:view", listener);
    const { result } = renderHook(() => useInlineWidgetContext(send, vi.fn()));
    result.current.navigate("/orchestrator?taskId=abc");
    window.removeEventListener("eliza:navigate:view", listener);
    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({
      viewPath: "/orchestrator?taskId=abc",
    });
  });

  it("navigate dispatches a viewId for a non-/ payload", () => {
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("eliza:navigate:view", listener);
    const { result } = renderHook(() =>
      useInlineWidgetContext(
        vi.fn(async () => {}),
        vi.fn(),
      ),
    );
    result.current.navigate("wallet");
    window.removeEventListener("eliza:navigate:view", listener);
    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ viewId: "wallet" });
  });

  it("submitForm encodes the form id + JSON values as an action message", () => {
    const send = vi.fn(async () => {});
    const { result } = renderHook(() => useInlineWidgetContext(send, vi.fn()));
    result.current.submitForm("signup", { email: "a@b.c", agree: true });
    expect(send).toHaveBeenCalledWith(
      `[form:submit signup] ${JSON.stringify({ email: "a@b.c", agree: true })}`,
    );
  });

  it("returns a stable reference while its inputs are unchanged", () => {
    const send = vi.fn(async () => {});
    const setInput = vi.fn();
    const { result, rerender } = renderHook(
      ({ s, i }) => useInlineWidgetContext(s, i),
      { initialProps: { s: send, i: setInput } },
    );
    const first = result.current;
    rerender({ s: send, i: setInput });
    expect(result.current).toBe(first);
  });
});
