// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSurface } from "./ChatSurface";
import type { ShellMessage } from "./shell-state";

function msg(partial: Partial<ShellMessage> & Pick<ShellMessage, "id" | "role" | "content">): ShellMessage {
  return { createdAt: 0, ...partial };
}

function getInput(): HTMLInputElement {
  return screen.getByRole("textbox") as HTMLInputElement;
}

function getSendButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
}

afterEach(() => cleanup());

describe("ChatSurface", () => {
  it("renders the message list from props (user + assistant turns, in order)", () => {
    const messages: ShellMessage[] = [
      msg({ id: "u1", role: "user", content: "hello there" }),
      msg({ id: "a1", role: "assistant", content: "general kenobi" }),
    ];
    render(<ChatSurface messages={messages} onSend={() => {}} canSend />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe("hello there");
    expect(items[1].textContent).toBe("general kenobi");
  });

  it("shows the empty-state greeting (and no list) when there are no messages", () => {
    render(
      <ChatSurface
        messages={[]}
        onSend={() => {}}
        canSend
        greeting="say something"
      />,
    );
    expect(screen.getByText("say something")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("wires the send button to onSend with the trimmed draft and clears the input", () => {
    const onSend = vi.fn();
    render(<ChatSurface messages={[]} onSend={onSend} canSend />);

    const input = getInput();
    fireEvent.change(input, { target: { value: "  ship it  " } });
    fireEvent.click(getSendButton());

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("ship it");
    expect(input.value).toBe("");
  });

  it("sends on Enter (without shift) and swallows the keystroke", () => {
    const onSend = vi.fn();
    render(<ChatSurface messages={[]} onSend={onSend} canSend />);

    const input = getInput();
    fireEvent.change(input, { target: { value: "via enter" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("via enter");
    // Shift+Enter must NOT send (newline composition).
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("renders the in-flight typing indicator for an empty assistant turn", () => {
    const messages: ShellMessage[] = [
      msg({ id: "u1", role: "user", content: "are you there?" }),
      msg({ id: "a1", role: "assistant", content: "" }),
    ];
    render(<ChatSurface messages={messages} onSend={() => {}} canSend />);

    // The streaming/thinking turn exposes a live status region, not raw text.
    const status = screen.getByRole("status");
    expect(status).toBeTruthy();
    expect(status.getAttribute("aria-label")).toContain("is typing");
    // Two turns rendered, second is the indicator (no message text).
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("does not send whitespace-only input (disabled send, no onSend)", () => {
    const onSend = vi.fn();
    render(<ChatSurface messages={[]} onSend={onSend} canSend />);

    fireEvent.change(getInput(), { target: { value: "     " } });
    expect(getSendButton().disabled).toBe(true);
    fireEvent.click(getSendButton());
    expect(onSend).not.toHaveBeenCalled();
  });

  it("blocks sending entirely when canSend is false", () => {
    const onSend = vi.fn();
    render(<ChatSurface messages={[]} onSend={onSend} canSend={false} />);

    const input = getInput();
    expect(input.disabled).toBe(true);
    // Even a keydown while the turn is in flight must not fire onSend.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(getSendButton().disabled).toBe(true);
  });

  it("is idempotent under rapid double-click: fires onSend once, second click is a no-op", () => {
    const onSend = vi.fn();
    render(<ChatSurface messages={[]} onSend={onSend} canSend />);

    fireEvent.change(getInput(), { target: { value: "rapid" } });
    const send = getSendButton();
    fireEvent.click(send);
    // Draft was cleared by the first send; a second synchronous click has an
    // empty (disabled) draft and must not re-fire.
    fireEvent.click(send);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("rapid");
  });

  it("scrolls the transcript to the latest turn when a message is appended", async () => {
    const scrollTopSetter = vi.fn();
    // jsdom has zero layout; simulate a scrollable viewport so the
    // bottom-follow effect has a non-trivial target to write.
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 500;
      },
    });
    const scrollTopSpy = Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return 0;
      },
      set(v: number) {
        scrollTopSetter(v);
      },
    });
    void scrollTopSpy;

    const { rerender } = render(
      <ChatSurface
        messages={[msg({ id: "u1", role: "user", content: "one" })]}
        onSend={() => {}}
        canSend
      />,
    );

    await act(async () => {
      rerender(
        <ChatSurface
          messages={[
            msg({ id: "u1", role: "user", content: "one" }),
            msg({ id: "a1", role: "assistant", content: "two" }),
          ]}
          onSend={() => {}}
          canSend
        />,
      );
      // Flush the deferred requestAnimationFrame bottom-follow write.
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    // The container was scrolled to its full height (bottom-follow).
    expect(scrollTopSetter).toHaveBeenCalledWith(500);

    // biome-ignore lint/performance/noDelete: restore prototype for other tests
    delete (HTMLDivElement.prototype as unknown as { scrollHeight?: unknown }).scrollHeight;
    // biome-ignore lint/performance/noDelete: restore prototype for other tests
    delete (HTMLDivElement.prototype as unknown as { scrollTop?: unknown }).scrollTop;
  });
});
