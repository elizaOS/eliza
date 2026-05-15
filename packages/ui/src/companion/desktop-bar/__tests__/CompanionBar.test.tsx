// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompanionBar } from "../CompanionBar";
import type { TrayMessage } from "../types";

afterEach(() => {
  cleanup();
});

const SAMPLE_MESSAGES: TrayMessage[] = [
  { id: "m1", role: "agent", text: "good morning", createdAt: 1 },
  { id: "m2", role: "user", text: "remind me at 3pm", createdAt: 2 },
];

describe("CompanionBar", () => {
  it("renders the collapsed pill and expands on click", () => {
    render(<CompanionBar messages={SAMPLE_MESSAGES} />);
    const pill = screen.getByRole("button", { name: /elizaos companion/i });
    expect(pill).toBeDefined();
    expect(pill.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      fireEvent.click(pill);
    });

    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("good morning")).toBeDefined();
    expect(screen.getByText("remind me at 3pm")).toBeDefined();
  });

  it("toggles expand on Ctrl+Space", () => {
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

  it("applies the soft red glow when always-on and collapsed", () => {
    render(<CompanionBar micState="always-on" />);
    const pill = screen.getByRole("button", { name: /elizaos companion/i });
    expect(pill.className).toContain("is-glow-red");
  });

  it("does not glow red when expanded even with always-on mic", () => {
    render(<CompanionBar micState="always-on" mode="expanded" />);
    const pill = screen.getByRole("button", { name: /elizaos companion/i });
    expect(pill.className).not.toContain("is-glow-red");
  });

  it("emits push-to-talk down/up on spacebar hold inside the composer", () => {
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
    if (!composer) {
      throw new Error("composer form missing");
    }

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

  it("submits draft text through onSend and clears the input", () => {
    const onSend = vi.fn();
    render(<CompanionBar mode="expanded" hooks={{ onSend }} />);
    const input = screen.getByLabelText(/message eliza/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello there" } });
    expect(input.value).toBe("hello there");

    const sendButton = screen.getByRole("button", { name: /send message/i });
    act(() => {
      fireEvent.click(sendButton);
    });
    expect(onSend).toHaveBeenCalledWith("hello there");
    expect(input.value).toBe("");
  });

  it("toggles mic always-on via the mic button", () => {
    const onMicStateChange = vi.fn();
    render(<CompanionBar mode="expanded" hooks={{ onMicStateChange }} />);
    const micButton = screen.getByRole("button", {
      name: /toggle microphone/i,
    });
    expect(micButton.getAttribute("aria-pressed")).toBe("false");

    act(() => {
      fireEvent.click(micButton);
    });
    expect(micButton.getAttribute("aria-pressed")).toBe("true");
    expect(onMicStateChange).toHaveBeenLastCalledWith("always-on");
  });
});
