/** Verifies ChatMessage desktop hover chrome through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Desktop hover and keyboard coverage for the stable per-message action rail.
 * The file owns a hover-capable media query because ChatMessage caches that
 * capability on first render.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ChatMessage } from "./chat-message";
import type { ChatMessageData } from "./chat-types";

beforeAll(() => {
  // Wide hover device: the responsive fine-pointer query matches so ChatMessage
  // takes the pointer (panel-rail) chrome, not the touch tap-reveal chrome.
  // Installed before the first render because the MediaQueryList is cached on
  // first read.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(cleanup);

function makeMessage(
  overrides: Partial<ChatMessageData> = {},
): ChatMessageData {
  return {
    id: "msg-1",
    role: "assistant",
    text: "Here are your latest balances.",
    ...overrides,
  };
}

describe("ChatMessage desktop hover chrome", () => {
  it("reveals the neutral action rail without a destructive control", () => {
    render(<ChatMessage message={makeMessage()} onCopy={vi.fn()} />);
    expect(window.matchMedia).toHaveBeenCalledWith(
      "(min-width: 768px) and (hover: hover) and (pointer: fine)",
    );
    const message = screen.getByTestId("chat-message");
    const rail = screen.getByTestId("chat-message-action-rail");

    const copy = screen.getByRole("button", {
      name: "Copy message",
      hidden: true,
    });
    expect(copy.className).toContain("size-8");
    expect(copy.className).toContain("pointer-coarse:min-h-touch");
    expect(copy.className).toContain("pointer-coarse:min-w-touch");
    expect(
      screen.queryByRole("button", { name: /delete/i, hidden: true }),
    ).toBeNull();
    expect(rail.className).toContain("pointer-events-none");
    expect(rail.className).toContain("opacity-0");

    // A response inserted beneath a stationary cursor may synthesize enter;
    // only deliberate pointer movement should reveal its controls.
    fireEvent.mouseEnter(message);

    expect(rail.className).toContain("pointer-events-none");
    expect(rail.className).toContain("opacity-0");

    fireEvent.pointerMove(message, { pointerType: "mouse" });

    expect(rail.className).not.toContain("pointer-events-none");
    expect(rail.className).toContain("opacity-100");

    fireEvent.mouseLeave(message);

    expect(rail.className).toContain("pointer-events-none");
    expect(rail.className).toContain("opacity-0");
  });

  it("keeps panel actions available while keyboard focus remains within the message", () => {
    render(
      <>
        <ChatMessage
          message={makeMessage()}
          onCopy={vi.fn()}
          onReply={vi.fn()}
          onSpeak={vi.fn()}
        />
        <button type="button">Outside panel message</button>
      </>,
    );

    const message = screen.getByTestId("chat-message");
    const rail = screen.getByTestId("chat-message-action-rail");
    expect(message.tabIndex).toBe(0);
    expect(rail.getAttribute("aria-hidden")).toBe("true");
    expect(rail.hasAttribute("inert")).toBe(true);

    const nativeMessageMatches = message.matches.bind(message);
    vi.spyOn(message, "matches").mockImplementation((selector) =>
      selector === ":focus-visible" ? true : nativeMessageMatches(selector),
    );
    act(() => message.focus());
    expect(rail.getAttribute("aria-hidden")).toBe("false");
    expect(rail.hasAttribute("inert")).toBe(false);

    const copy = screen.getByRole("button", { name: "Copy message" });
    act(() => copy.focus());
    fireEvent.mouseLeave(message);
    expect(document.activeElement).toBe(copy);
    expect(rail.getAttribute("aria-hidden")).toBe("false");

    act(() =>
      screen.getByRole("button", { name: "Outside panel message" }).focus(),
    );
    expect(rail.getAttribute("aria-hidden")).toBe("true");
    expect(rail.hasAttribute("inert")).toBe(true);
  });

  it("keeps glass actions visible while keyboard focus moves within the row", () => {
    render(
      <>
        <ChatMessage
          appearance="glass"
          message={makeMessage({ role: "user", text: "Keyboard draft" })}
          onCopy={vi.fn()}
          onEdit={vi.fn()}
          onReply={vi.fn()}
        />
        <button type="button">Outside glass message</button>
      </>,
    );

    const message = screen.getByTestId("thread-line");
    const bubble = screen.getByRole("button", {
      name: "Show message actions",
    });
    const actions = screen.getByTestId("thread-line-actions");
    const content = actions.parentElement;
    const restingContentClass = content?.className;
    expect(message.className).toContain("mb-0");
    expect(content?.className).toContain("pb-6");
    expect(content?.className).toContain("transition-[padding-bottom]");
    expect(content?.className).not.toContain("pb-0");
    expect(content?.className).not.toContain("pb-9");
    expect(actions.className).toContain("bottom-0");
    expect(actions.className).toContain("absolute");
    expect(actions.className).toContain("invisible");
    expect(actions.className).toContain("opacity-0");
    expect(actions.className).toContain("pointer-events-none");
    expect(actions.getAttribute("aria-hidden")).toBe("true");
    expect(actions.hasAttribute("inert")).toBe(true);

    const nativeBubbleMatches = bubble.matches.bind(bubble);
    vi.spyOn(bubble, "matches").mockImplementation((selector) =>
      selector === ":focus-visible" ? true : nativeBubbleMatches(selector),
    );
    act(() => bubble.focus());
    expect(actions.className).toContain("visible");
    expect(actions.className).not.toContain("invisible");
    expect(actions.getAttribute("aria-hidden")).toBe("false");
    expect(actions.hasAttribute("inert")).toBe(false);
    expect(actions.parentElement?.className).toBe(restingContentClass);

    const edit = screen.getByRole("button", { name: "Edit" });
    act(() => edit.focus());
    const nativeMatches = edit.matches.bind(edit);
    vi.spyOn(edit, "matches").mockImplementation((selector) =>
      selector === ":focus-visible" ? true : nativeMatches(selector),
    );
    fireEvent.mouseLeave(message);
    expect(document.activeElement).toBe(edit);
    expect(actions.getAttribute("aria-hidden")).toBe("false");
    expect(actions.parentElement?.className).toBe(restingContentClass);

    act(() =>
      screen.getByRole("button", { name: "Outside glass message" }).focus(),
    );
    expect(actions.className).toContain("invisible");
    expect(actions.className).toContain("opacity-0");
    expect(actions.getAttribute("aria-hidden")).toBe("true");
    expect(actions.hasAttribute("inert")).toBe(true);
    expect(actions.parentElement?.className).toBe(restingContentClass);
  });

  it("does not pin a fine-pointer action rail after bubble click and pointer leave", () => {
    render(
      <ChatMessage
        appearance="glass"
        message={makeMessage({ role: "user", text: "Pointer draft" })}
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onReply={vi.fn()}
      />,
    );

    const message = screen.getByTestId("thread-line");
    const bubble = screen.getByRole("button", {
      name: "Show message actions",
    });
    const actions = screen.getByTestId("thread-line-actions");

    fireEvent.pointerMove(message, { pointerType: "mouse" });
    expect(actions.getAttribute("aria-hidden")).toBe("false");

    fireEvent.click(bubble);
    expect(actions.getAttribute("aria-hidden")).toBe("true");

    fireEvent.mouseLeave(message);
    expect(actions.getAttribute("aria-hidden")).toBe("true");

    fireEvent.pointerMove(message, { pointerType: "mouse" });
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("Pointer draft"));
    const selection = window.getSelection();
    if (!selection) throw new Error("jsdom selection unavailable");
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.click(bubble);
    expect(actions.getAttribute("aria-hidden")).toBe("false");

    fireEvent.mouseLeave(message);
    expect(actions.getAttribute("aria-hidden")).toBe("true");
    selection.removeAllRanges();
  });

  it("returns focus to the visible glass message before Reply hides its actions", () => {
    const onReply = vi.fn();
    render(
      <ChatMessage
        appearance="glass"
        message={makeMessage()}
        onCopy={vi.fn()}
        onReply={onReply}
      />,
    );

    const bubble = screen.getByRole("button", {
      name: "Show message actions",
    });
    const nativeBubbleMatches = bubble.matches.bind(bubble);
    vi.spyOn(bubble, "matches").mockImplementation((selector) =>
      selector === ":focus-visible" ? true : nativeBubbleMatches(selector),
    );
    act(() => bubble.focus());
    const reply = screen.getByRole("button", { name: "Reply" });
    act(() => reply.focus());

    fireEvent.click(reply);

    expect(onReply).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(bubble);
    const actions = screen.getByTestId("thread-line-actions");
    expect(actions.getAttribute("aria-hidden")).toBe("true");
    expect(actions.hasAttribute("inert")).toBe(true);
  });

  it("renders a frosted first-run greeting with no action rail", () => {
    // The onboarding greeting is seeded wallpaper prose with a CTA beneath it;
    // reply / copy / play are meaningless on it and the hover rail read
    // as a bug during first-run. Even with every action handler wired, a
    // `first_run` source turn must render no rail.
    render(
      <ChatMessage
        message={makeMessage({ source: "first_run" })}
        appearance="glass"
        onCopy={vi.fn()}
        onReply={vi.fn()}
        onSpeak={vi.fn()}
      />,
    );
    const bubble = Array.from(
      document.querySelectorAll<HTMLElement>("div"),
    ).find((element) => element.classList.contains("backdrop-blur-md"));
    expect(bubble).toBeTruthy();
    expect(bubble?.classList.contains("border")).toBe(true);
    expect(bubble?.classList.contains("rounded-2xl")).toBe(true);
    expect(bubble?.classList.contains("rounded-bl-md")).toBe(true);
    expect(bubble?.classList.contains("bg-black/35")).toBe(true);
    expect(screen.queryByTestId("chat-message-action-rail")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /delete/i, hidden: true }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });
});
