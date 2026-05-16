// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionBar } from "../../companion/desktop-bar/CompanionBar";

afterEach(() => {
  cleanup();
});

describe("CompanionBar — desktop tray behaviour", () => {
  it("Ctrl+Space toggles the expanded panel", () => {
    const onExpandChange = vi.fn();
    render(<CompanionBar hooks={{ onExpandChange }} />);
    const pill = screen.getByRole("button", { name: /elizaos companion/i });
    expect(pill.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      fireEvent.keyDown(window, { code: "Space", ctrlKey: true });
    });
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(onExpandChange).toHaveBeenLastCalledWith(true);

    act(() => {
      fireEvent.keyDown(window, { code: "Space", ctrlKey: true });
    });
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(onExpandChange).toHaveBeenLastCalledWith(false);
  });

  it("spacebar inside the expanded composer fires push-to-talk down + up", () => {
    const onPushToTalkDown = vi.fn();
    const onPushToTalkUp = vi.fn();
    render(
      <CompanionBar
        mode="expanded"
        hooks={{ onPushToTalkDown, onPushToTalkUp }}
      />,
    );
    const sendButton = screen.getByRole("button", { name: /send message/i });
    const composer = sendButton.closest("form");
    expect(composer).not.toBeNull();
    if (!composer) throw new Error("composer not found");

    act(() => {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { code: "Space", bubbles: true }),
      );
    });
    expect(onPushToTalkDown).toHaveBeenCalledTimes(1);

    act(() => {
      composer.dispatchEvent(
        new KeyboardEvent("keyup", { code: "Space", bubbles: true }),
      );
    });
    expect(onPushToTalkUp).toHaveBeenCalledTimes(1);
  });

  it("micState='always-on' adds the soft red glow class while collapsed", () => {
    render(<CompanionBar micState="always-on" />);
    const pill = screen.getByRole("button", { name: /elizaos companion/i });
    expect(pill.className).toContain("is-glow-red");
  });

  it("micState='always-on' does NOT glow red while expanded", () => {
    render(<CompanionBar micState="always-on" mode="expanded" />);
    const pill = screen.getByRole("button", { name: /elizaos companion/i });
    expect(pill.className).not.toContain("is-glow-red");
  });

  it("spacebar inside a text input does NOT fire push-to-talk", () => {
    const onPushToTalkDown = vi.fn();
    render(
      <CompanionBar mode="expanded" hooks={{ onPushToTalkDown }} />,
    );
    const input = screen.getByLabelText(/message eliza/i);

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { code: "Space", bubbles: true }),
      );
    });
    expect(onPushToTalkDown).not.toHaveBeenCalled();
  });
});
