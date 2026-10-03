/** Exercises transcript rendering and scrollback controls with real components in jsdom. */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatSurface } from "../ChatSurface";
import type { ShellMessage } from "../shell-state";

afterEach(() => cleanup());

const MESSAGES: ShellMessage[] = [
  {
    id: "u1",
    role: "user",
    content: "Remind me to call Alex at 3pm",
    createdAt: 0,
  },
  {
    id: "a1",
    role: "assistant",
    content: "Done — reminder set for 3:00 PM.",
    createdAt: 1,
  },
];

describe("ChatSurface transcript", () => {
  it("renders user and assistant messages in conversation order", () => {
    render(<ChatSurface messages={MESSAGES} onSend={() => {}} canSend />);
    const rows = within(
      screen.getByRole("list", { name: "Conversation" }),
    ).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(
      MESSAGES.map((message) => message.content),
    );
  });

  it("replaces an empty assistant turn with an accessible typing status", () => {
    const messages: ShellMessage[] = [
      ...MESSAGES,
      { id: "a2", role: "assistant", content: "", createdAt: 2 },
    ];
    render(<ChatSurface messages={messages} onSend={() => {}} canSend />);
    expect(
      screen.getByRole("status", { name: /eliza is typing/i }),
    ).toBeTruthy();
  });

  it("scrollback remains free of floating controls", () => {
    render(<ChatSurface messages={MESSAGES} onSend={() => {}} canSend />);
    const surface = screen.getByTestId("shell-chat-surface");
    const scroller = surface.querySelector(
      ".overflow-y-auto",
    ) as HTMLDivElement;
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => 2000,
    });
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      get: () => 400,
    });
    let top = 100;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    fireEvent.scroll(scroller);
    expect(screen.queryByTestId("chat-surface-jump-to-latest")).toBeNull();
  });
});
