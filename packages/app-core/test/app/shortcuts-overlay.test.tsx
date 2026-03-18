// @vitest-environment jsdom

import { ShortcutsOverlay } from "@elizaos/app-core/components";
import { COMMON_SHORTCUTS } from "@elizaos/app-core/hooks";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

let addListenerSpy: ReturnType<typeof vi.spyOn>;

function getLatestKeydownHandler(): (event: KeyboardEvent) => void {
  const keydownCalls = addListenerSpy.mock.calls.filter(
    (call: unknown[]) => call[0] === "keydown" && typeof call[1] === "function",
  );
  const latestCall = keydownCalls.at(-1);
  if (!latestCall) {
    throw new Error("Expected ShortcutsOverlay to register a keydown handler");
  }
  return latestCall[1] as (event: KeyboardEvent) => void;
}

function findText(
  root: TestRenderer.ReactTestInstance,
  value: string,
): TestRenderer.ReactTestInstance[] {
  return root.findAll((node: TestRenderer.ReactTestInstance) =>
    node.children.some((child) => child === value),
  );
}

describe("ShortcutsOverlay", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    addListenerSpy = vi.spyOn(window, "addEventListener");
  });

  it("opens on Shift+? and renders the shared shortcuts list", () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(React.createElement(ShortcutsOverlay));
    });

    expect(tree.toJSON()).toBeNull();

    const preventDefault = vi.fn();
    act(() => {
      getLatestKeydownHandler()({
        shiftKey: true,
        key: "?",
        preventDefault,
        target: { tagName: "DIV" },
      } as KeyboardEvent);
    });

    const dialog = tree.root.findByProps({ role: "dialog" });
    expect(dialog.props["aria-label"]).toBe("Keyboard shortcuts");
    expect(findText(tree.root, "Open command palette")).toHaveLength(1);
    expect(tree.root.findAllByType("kbd" as React.ElementType)).toHaveLength(
      COMMON_SHORTCUTS.length,
    );
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("ignores the toggle shortcut while typing in an input", () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(React.createElement(ShortcutsOverlay));
    });

    const preventDefault = vi.fn();
    act(() => {
      getLatestKeydownHandler()({
        shiftKey: true,
        key: "?",
        preventDefault,
        target: { tagName: "INPUT" },
      } as KeyboardEvent);
    });

    expect(tree.toJSON()).toBeNull();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("closes on Escape once opened", () => {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(React.createElement(ShortcutsOverlay));
    });

    act(() => {
      getLatestKeydownHandler()({
        shiftKey: true,
        key: "?",
        preventDefault: vi.fn(),
        target: { tagName: "DIV" },
      } as KeyboardEvent);
    });

    const preventDefault = vi.fn();
    act(() => {
      getLatestKeydownHandler()({
        key: "Escape",
        preventDefault,
        target: { tagName: "DIV" },
      } as KeyboardEvent);
    });

    expect(tree.toJSON()).toBeNull();
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
