// @vitest-environment jsdom

/**
 * Desktop hover coverage for the per-message action plate. The test runs in its
 * own file because ChatMessage caches the hover MediaQueryList at module scope,
 * so a sibling touch-suite install would otherwise poison this device branch.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("ChatMessage desktop hover action plate", () => {
  it("reveals the overlay's bare actions on hover without changing row flow", () => {
    render(
      <ChatMessage
        appearance="glass"
        message={makeMessage()}
        onCopy={vi.fn()}
        onReply={vi.fn()}
        onSpeak={vi.fn()}
      />,
    );

    const message = screen.getByTestId("thread-line");
    const actions = screen.getByTestId("thread-line-actions");
    const surface = screen.getByTestId("thread-line-action-surface");
    const content = actions.parentElement;

    expect(actions.getAttribute("aria-hidden")).toBe("true");
    expect(actions.className).toContain("absolute");
    expect(content?.className).toContain("pb-7");
    expect(content?.className).toContain("pointer-coarse:pb-11");
    expect(message.className).toContain("mb-0.5");
    expect(surface.className).not.toContain("bg-black/55");

    fireEvent.mouseEnter(message);
    expect(actions.getAttribute("aria-hidden")).toBe("false");
    expect(actions.hasAttribute("inert")).toBe(false);

    fireEvent.mouseLeave(message);
    expect(actions.getAttribute("aria-hidden")).toBe("true");
    expect(actions.hasAttribute("inert")).toBe(true);
  });

  it("fades and settles the neutral action plate without a delete control", () => {
    render(
      <ChatMessage
        message={makeMessage()}
        onCopy={vi.fn()}
        onReply={vi.fn()}
        onSpeak={vi.fn()}
      />,
    );
    const message = screen.getByTestId("chat-message");
    const rail = screen.getByTestId("chat-message-action-rail");
    const surface = screen.getByTestId("chat-message-actions");

    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
    expect(surface.className).toContain("bg-black/55");
    expect(rail.className).toContain("transition-[opacity,transform]");
    expect(rail.className).toContain("pointer-events-none");
    expect(rail.className).toContain("opacity-0");
    expect(rail.className).toContain("translate-y-1");
    expect(rail.className).toContain("scale-[0.98]");
    expect(rail.hasAttribute("inert")).toBe(true);

    fireEvent.mouseEnter(message);

    expect(rail.className).not.toContain("pointer-events-none");
    expect(rail.className).toContain("opacity-100");
    expect(rail.className).toContain("translate-y-0");
    expect(rail.className).toContain("scale-100");
    expect(rail.hasAttribute("inert")).toBe(false);

    fireEvent.mouseLeave(message);

    expect(rail.className).toContain("pointer-events-none");
    expect(rail.className).toContain("opacity-0");
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
    expect(bubble?.classList.contains("py-2")).toBe(true);
  });
});
