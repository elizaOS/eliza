// @vitest-environment jsdom

// Unit-tests the shared push-to-talk hold state machine against a real button
// mounted in jsdom, driving pointerdown/up/cancel and fake hold timers. This is
// the one implementation the overlay and ChatComposer both share, so the
// hold/quick-tap/slide-off/click-suppression contract is verified here once.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUSH_TO_TALK_HOLD_MS, usePushToTalk } from "./usePushToTalk";

interface HarnessProps {
  canBegin?: () => boolean;
  onHoldStart: () => void;
  onHoldEnd: (cancelled: boolean) => void;
  onClickAction: () => void;
}

function Harness({
  canBegin = () => true,
  onHoldStart,
  onHoldEnd,
  onClickAction,
}: HarnessProps) {
  const { handlers, shouldSuppressClick } = usePushToTalk({
    canBegin,
    onHoldStart,
    onHoldEnd,
  });
  return (
    <button
      type="button"
      data-testid="mic"
      onClick={() => {
        if (shouldSuppressClick()) return;
        onClickAction();
      }}
      {...handlers}
    >
      mic
    </button>
  );
}

// jsdom has no Pointer Capture; stub it so the hook's capture calls are no-ops
// that still report "not captured" for the release path.
beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

function pointerDown(el: Element, pointerId = 1) {
  fireEvent.pointerDown(el, { button: 0, pointerId });
}

describe("usePushToTalk", () => {
  it("starts capture only after the hold elapses and submits on clean release", () => {
    const onHoldStart = vi.fn();
    const onHoldEnd = vi.fn();
    const onClickAction = vi.fn();
    const { getByTestId } = render(
      <Harness
        onHoldStart={onHoldStart}
        onHoldEnd={onHoldEnd}
        onClickAction={onClickAction}
      />,
    );
    const mic = getByTestId("mic");

    pointerDown(mic);
    expect(onHoldStart).not.toHaveBeenCalled();

    vi.advanceTimersByTime(PUSH_TO_TALK_HOLD_MS);
    expect(onHoldStart).toHaveBeenCalledTimes(1);

    fireEvent.pointerUp(mic, { pointerId: 1 });
    expect(onHoldEnd).toHaveBeenCalledTimes(1);
    expect(onHoldEnd).toHaveBeenCalledWith(false);

    // The trailing click of a held release is swallowed.
    fireEvent.click(mic);
    expect(onClickAction).not.toHaveBeenCalled();
  });

  it("treats a release before the hold as a quick tap: no capture, click runs", () => {
    const onHoldStart = vi.fn();
    const onHoldEnd = vi.fn();
    const onClickAction = vi.fn();
    const { getByTestId } = render(
      <Harness
        onHoldStart={onHoldStart}
        onHoldEnd={onHoldEnd}
        onClickAction={onClickAction}
      />,
    );
    const mic = getByTestId("mic");

    pointerDown(mic);
    vi.advanceTimersByTime(PUSH_TO_TALK_HOLD_MS - 1);
    fireEvent.pointerUp(mic, { pointerId: 1 });

    expect(onHoldStart).not.toHaveBeenCalled();
    expect(onHoldEnd).not.toHaveBeenCalled();

    fireEvent.click(mic);
    expect(onClickAction).toHaveBeenCalledTimes(1);
  });

  it("discards on slide-off cancel and does not suppress the next tap", () => {
    const onHoldStart = vi.fn();
    const onHoldEnd = vi.fn();
    const onClickAction = vi.fn();
    const { getByTestId } = render(
      <Harness
        onHoldStart={onHoldStart}
        onHoldEnd={onHoldEnd}
        onClickAction={onClickAction}
      />,
    );
    const mic = getByTestId("mic");

    pointerDown(mic);
    vi.advanceTimersByTime(PUSH_TO_TALK_HOLD_MS);
    expect(onHoldStart).toHaveBeenCalledTimes(1);

    // Finger slides off the button → pointerleave/cancel discards.
    fireEvent.pointerLeave(mic, { pointerId: 1 });
    expect(onHoldEnd).toHaveBeenCalledWith(true);

    // A cancel never produces a trailing click, and the suppress flag must not
    // leak into a later legitimate tap.
    pointerDown(mic, 2);
    vi.advanceTimersByTime(PUSH_TO_TALK_HOLD_MS - 1);
    fireEvent.pointerUp(mic, { pointerId: 2 });
    fireEvent.click(mic);
    expect(onClickAction).toHaveBeenCalledTimes(1);
  });

  it("ignores the press when canBegin returns false", () => {
    const onHoldStart = vi.fn();
    const onHoldEnd = vi.fn();
    const onClickAction = vi.fn();
    const { getByTestId } = render(
      <Harness
        canBegin={() => false}
        onHoldStart={onHoldStart}
        onHoldEnd={onHoldEnd}
        onClickAction={onClickAction}
      />,
    );
    const mic = getByTestId("mic");

    pointerDown(mic);
    vi.advanceTimersByTime(PUSH_TO_TALK_HOLD_MS * 2);
    fireEvent.pointerUp(mic, { pointerId: 1 });
    expect(onHoldStart).not.toHaveBeenCalled();

    // With no armed press, the click passes straight through.
    fireEvent.click(mic);
    expect(onClickAction).toHaveBeenCalledTimes(1);
  });

  it("ignores non-primary buttons", () => {
    const onHoldStart = vi.fn();
    const { getByTestId } = render(
      <Harness
        onHoldStart={onHoldStart}
        onHoldEnd={vi.fn()}
        onClickAction={vi.fn()}
      />,
    );
    const mic = getByTestId("mic");

    fireEvent.pointerDown(mic, { button: 2, pointerId: 1 });
    vi.advanceTimersByTime(PUSH_TO_TALK_HOLD_MS * 2);
    expect(onHoldStart).not.toHaveBeenCalled();
  });
});
