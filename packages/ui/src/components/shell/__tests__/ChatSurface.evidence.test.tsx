// @vitest-environment jsdom
//
// Evidence generator (#12348, not a behavioural gate): renders the REAL
// ChatSurface in three states and writes its actual outerHTML to the issue
// evidence dir so a reviewer can confirm — without reading code — that the
// message row is the shared ChatBubble, the typing placeholder is the shared
// TypingIndicator (role="status"), and the jump-to-latest control exists. The
// assertions are minimal presence checks; the artifact is the deliverable.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatSurface } from "../ChatSurface";
import type { ShellMessage } from "../shell-state";

const OUT_DIR = resolve(
  dirname(new URL(import.meta.url).pathname),
  "../../../../../../.github/issue-evidence/12348-one-message-row",
);

function dump(name: string, html: string): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, name), `${html}\n`);
}

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

describe("ChatSurface evidence", () => {
  it("conversation: rows render through the shared ChatBubble", () => {
    render(<ChatSurface messages={MESSAGES} onSend={() => {}} canSend />);
    const surface = screen.getByTestId("shell-chat-surface");
    // ChatBubble's signature class is present on message rows.
    expect(surface.innerHTML).toContain("rounded-sm");
    dump("chatsurface-conversation.html", surface.outerHTML);
  });

  it("typing: placeholder is the shared TypingIndicator (role=status)", () => {
    const messages: ShellMessage[] = [
      ...MESSAGES,
      { id: "a2", role: "assistant", content: "", createdAt: 2 },
    ];
    render(<ChatSurface messages={messages} onSend={() => {}} canSend />);
    const surface = screen.getByTestId("shell-chat-surface");
    expect(screen.getByLabelText(/eliza is typing/i)).toBeTruthy();
    dump("chatsurface-typing.html", surface.outerHTML);
  });

  it("jump-to-latest: control appears when scrolled up", () => {
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
    expect(screen.getByTestId("chat-surface-jump-to-latest")).toBeTruthy();
    dump("chatsurface-jump-to-latest.html", surface.outerHTML);
  });
});
