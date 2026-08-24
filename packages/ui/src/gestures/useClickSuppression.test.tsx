/**
 * Dedicated suite for the compat-click suppression hook: unarmed passthrough,
 * consume-on-click (preventDefault + stopPropagation), boolean arm semantics,
 * consumeArmed interplay, the autoDisarm macrotask (including the
 * latest-rendered option value), instance isolation, and the end-to-end React
 * wiring where a swallowed capture click never reaches the element's own
 * onClick. jsdom-backed via @testing-library/react; the real touch pipeline
 * stays with the CDP-touch e2e runners.
 */
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
} from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ClickSuppressionOptions,
  useClickSuppression,
} from "./useClickSuppression";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function synthesizedClick() {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent;
}

describe("useClickSuppression", () => {
  it("leaves an unarmed click untouched", () => {
    const { result } = renderHook(() => useClickSuppression());
    const evt = synthesizedClick();

    act(() => result.current.onClickCapture(evt));

    expect(evt.preventDefault).not.toHaveBeenCalled();
    expect(evt.stopPropagation).not.toHaveBeenCalled();
    expect(result.current.consumeArmed()).toBe(false);
  });

  it("swallows the armed click with preventDefault and stopPropagation", () => {
    const { result } = renderHook(() => useClickSuppression());
    const evt = synthesizedClick();

    act(() => result.current.arm());
    act(() => result.current.onClickCapture(evt));

    expect(evt.preventDefault).toHaveBeenCalledTimes(1);
    expect(evt.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("disarms on consume, so the immediately following click passes through", () => {
    const { result } = renderHook(() => useClickSuppression());

    act(() => result.current.arm());
    act(() => result.current.onClickCapture(synthesizedClick()));
    expect(result.current.consumeArmed()).toBe(false);

    const later = synthesizedClick();
    act(() => result.current.onClickCapture(later));
    expect(later.preventDefault).not.toHaveBeenCalled();
    expect(later.stopPropagation).not.toHaveBeenCalled();
  });

  it("treats repeated arm() calls as one boolean arm, not a queue", () => {
    const { result } = renderHook(() => useClickSuppression());

    act(() => result.current.arm());
    act(() => result.current.arm());

    const first = synthesizedClick();
    act(() => result.current.onClickCapture(first));
    expect(first.preventDefault).toHaveBeenCalledTimes(1);

    const second = synthesizedClick();
    act(() => result.current.onClickCapture(second));
    expect(second.preventDefault).not.toHaveBeenCalled();
  });

  it("consumeArmed() reads false fresh, then true exactly once per arm()", () => {
    const { result } = renderHook(() => useClickSuppression());

    expect(result.current.consumeArmed()).toBe(false);

    act(() => result.current.arm());
    expect(result.current.consumeArmed()).toBe(true);
    expect(result.current.consumeArmed()).toBe(false);
  });

  it("still swallows a synthesized click that lands before the macrotask boundary", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useClickSuppression());

    act(() => result.current.arm());
    const pending = synthesizedClick();
    act(() => result.current.onClickCapture(pending));
    expect(pending.preventDefault).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    const afterBoundary = synthesizedClick();
    act(() => result.current.onClickCapture(afterBoundary));
    expect(afterBoundary.preventDefault).not.toHaveBeenCalled();
  });

  it("auto-disarms across the macrotask so an unrelated later click survives", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useClickSuppression());

    act(() => result.current.arm());
    act(() => {
      vi.advanceTimersByTime(1);
    });

    const unrelated = synthesizedClick();
    act(() => result.current.onClickCapture(unrelated));
    expect(unrelated.preventDefault).not.toHaveBeenCalled();
    expect(result.current.consumeArmed()).toBe(false);
  });

  it("holds the arm past the macrotask when autoDisarm is false", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useClickSuppression({ autoDisarm: false }),
    );

    act(() => result.current.arm());
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    const trailing = synthesizedClick();
    act(() => result.current.onClickCapture(trailing));
    expect(trailing.preventDefault).toHaveBeenCalledTimes(1);
    expect(trailing.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("governs the macrotask with the latest rendered autoDisarm value", () => {
    vi.useFakeTimers();

    const enabling = renderHook<
      ReturnType<typeof useClickSuppression>,
      ClickSuppressionOptions
    >((props) => useClickSuppression(props), {
      initialProps: { autoDisarm: false },
    });
    enabling.rerender({});
    act(() => enabling.result.current.arm());
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(enabling.result.current.consumeArmed()).toBe(false);

    const disabling = renderHook<
      ReturnType<typeof useClickSuppression>,
      ClickSuppressionOptions
    >((props) => useClickSuppression(props), {
      initialProps: {},
    });
    disabling.rerender({ autoDisarm: false });
    act(() => disabling.result.current.arm());
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(disabling.result.current.consumeArmed()).toBe(true);
  });

  it("keeps separate instances independently armed", () => {
    const pager = renderHook(() => useClickSuppression());
    const toggle = renderHook(() => useClickSuppression());

    act(() => pager.result.current.arm());

    const bystander = synthesizedClick();
    act(() => toggle.result.current.onClickCapture(bystander));
    expect(bystander.preventDefault).not.toHaveBeenCalled();

    const owner = synthesizedClick();
    act(() => pager.result.current.onClickCapture(owner));
    expect(owner.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("prevents the element's own onClick when wired through React's event system", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useClickSuppression());
    const onButtonClick = vi.fn();
    const { getByRole } = render(
      <button
        type="button"
        onClickCapture={result.current.onClickCapture}
        onClick={onButtonClick}
      >
        release point
      </button>,
    );

    act(() => result.current.arm());
    fireEvent.click(getByRole("button"));
    expect(onButtonClick).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    fireEvent.click(getByRole("button"));
    expect(onButtonClick).toHaveBeenCalledTimes(1);
  });
});
