// @vitest-environment jsdom

/**
 * Desktop hover coverage for the per-message delete control. The test runs in
 * its own file because ChatMessage caches the hover MediaQueryList at module
 * scope, so a sibling touch-suite install would otherwise poison the device
 * branch under test.
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
  // Hover device: `(hover: hover) and (pointer: fine)` matches so ChatMessage
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

function deleteControl(): HTMLElement | null {
  return screen.queryByRole("button", {
    name: "Delete message",
    hidden: true,
  });
}

describe("ChatMessage desktop hover-chrome delete control (#13533)", () => {
  it("reveals the delete control on desktop hover when the surface wires onDelete", () => {
    render(
      <ChatMessage
        message={makeMessage()}
        onCopy={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const message = screen.getByTestId("chat-message");
    const rail = screen.getByTestId("chat-message-action-rail");

    expect(deleteControl()).not.toBeNull();
    expect(rail.className).toContain("pointer-events-none");
    expect(rail.className).toContain("opacity-0");

    fireEvent.mouseEnter(message);

    expect(rail.className).not.toContain("pointer-events-none");
    expect(rail.className).toContain("opacity-100");

    fireEvent.mouseLeave(message);

    expect(rail.className).toContain("pointer-events-none");
    expect(rail.className).toContain("opacity-0");
  });

  it("omits the delete control when the surface wires no onDelete", () => {
    render(<ChatMessage message={makeMessage()} onCopy={vi.fn()} />);
    expect(deleteControl()).toBeNull();
  });

  it("omits the delete control on an optimistic (temp-) turn even with onDelete wired", () => {
    render(
      <ChatMessage
        message={makeMessage({ id: "temp-123" })}
        onCopy={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    // A temp turn has no persisted memory row to delete; ChatMessage's canDelete
    // guard excludes `temp-` ids so the control never appears on it.
    expect(deleteControl()).toBeNull();
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
    expect(content?.className).toContain("pb-5");
    expect(content?.className).toContain("pointer-coarse:pb-9");
    expect(actions.className).toContain("absolute");
    expect(actions.getAttribute("aria-hidden")).toBe("true");
    expect(actions.hasAttribute("inert")).toBe(true);

    act(() => bubble.focus());
    expect(actions.getAttribute("aria-hidden")).toBe("false");
    expect(actions.hasAttribute("inert")).toBe(false);
    expect(actions.parentElement?.className).toBe(restingContentClass);

    const edit = screen.getByRole("button", { name: "Edit" });
    act(() => edit.focus());
    fireEvent.mouseLeave(message);
    expect(document.activeElement).toBe(edit);
    expect(actions.getAttribute("aria-hidden")).toBe("false");
    expect(actions.parentElement?.className).toBe(restingContentClass);

    act(() =>
      screen.getByRole("button", { name: "Outside glass message" }).focus(),
    );
    expect(actions.getAttribute("aria-hidden")).toBe("true");
    expect(actions.hasAttribute("inert")).toBe(true);
    expect(actions.parentElement?.className).toBe(restingContentClass);
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
    // reply / copy / delete / play are meaningless on it and the hover rail read
    // as a bug during first-run. Even with every action handler wired, a
    // `first_run` source turn must render no rail.
    render(
      <ChatMessage
        message={makeMessage({ source: "first_run" })}
        appearance="glass"
        onCopy={vi.fn()}
        onDelete={vi.fn()}
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
    expect(deleteControl()).toBeNull();
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("keeps user turns inside the compact right-side glass bubble", () => {
    render(
      <ChatMessage
        message={makeMessage({ role: "user", text: "My message" })}
        appearance="glass"
      />,
    );
    const bubble = screen.getByText("My message").parentElement;
    expect(bubble?.classList.contains("rounded-2xl")).toBe(true);
    expect(bubble?.classList.contains("rounded-br-md")).toBe(true);
    expect(bubble?.classList.contains("border-white/15")).toBe(true);
    expect(bubble?.classList.contains("px-3.5")).toBe(true);
    expect(bubble?.classList.contains("py-[3px]")).toBe(true);
  });
});
