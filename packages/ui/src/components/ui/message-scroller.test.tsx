/**
 * Verifies the locally owned message-scroller hooks retain the dependency's
 * real provider behavior while keeping stable elizaOS declaration provenance.
 */

// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";
import {
  MessageScrollerProvider,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "./message-scroller";

function Provider({ children }: PropsWithChildren) {
  return <MessageScrollerProvider>{children}</MessageScrollerProvider>;
}

describe("message-scroller public hooks", () => {
  it("delegates controls and observable state through the real provider", () => {
    const { result } = renderHook(
      () => ({
        controls: useMessageScroller(),
        scrollable: useMessageScrollerScrollable(),
        visibility: useMessageScrollerVisibility(),
      }),
      { wrapper: Provider },
    );

    expect(result.current.controls).toEqual({
      scrollToEnd: expect.any(Function),
      scrollToMessage: expect.any(Function),
      scrollToStart: expect.any(Function),
    });
    expect(result.current.scrollable).toEqual({ start: false, end: false });
    expect(result.current.visibility).toEqual({
      currentAnchorId: null,
      visibleMessageIds: [],
    });
  });
});
