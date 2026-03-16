// @vitest-environment jsdom

import { useStreamPopoutNavigation } from "@elizaos/app-core/hooks";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

function Harness({ setTab }: { setTab: (tab: string) => void }) {
  useStreamPopoutNavigation(setTab);
  return null;
}

describe("useStreamPopoutNavigation", () => {
  it("does not switch tabs when the stream popout opens or closes", () => {
    const setTab = vi.fn();
    let tree: TestRenderer.ReactTestRenderer | null = null;

    act(() => {
      tree = TestRenderer.create(React.createElement(Harness, { setTab }));
    });

    act(() => {
      globalThis.dispatchEvent(
        new CustomEvent("stream-popout", { detail: "opened" }),
      );
      globalThis.dispatchEvent(
        new CustomEvent("stream-popout", { detail: "closed" }),
      );
    });

    expect(setTab).not.toHaveBeenCalled();

    if (!tree) {
      throw new Error("Expected stream popout harness to be created.");
    }

    act(() => {
      tree.unmount();
    });
  });
});
