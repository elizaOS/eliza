// @vitest-environment jsdom

import { ThemeToggle } from "@elizaos/app-core/components/ThemeToggle";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

describe("ThemeToggle", () => {
  it("renders the shared toggle style and flips to dark mode", async () => {
    const setUiTheme = vi.fn();

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(
        <ThemeToggle
          uiTheme="light"
          setUiTheme={setUiTheme}
          variant="companion"
        />,
      );
    });

    const button = tree?.root.findByProps({ "data-testid": "theme-toggle" });
    expect(button?.props.className).toContain("text-txt");
    expect(button?.props.className).toContain("bg-bg/50");
    expect(button?.props.style).toBeUndefined();
    expect(button?.props["data-no-camera-drag"]).toBe("true");

    const stopPropagation = vi.fn();
    await act(async () => {
      button?.props.onPointerDown({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalledTimes(1);

    await act(async () => {
      button?.props.onClick();
    });

    expect(setUiTheme).toHaveBeenCalledWith("dark");
  });
});
