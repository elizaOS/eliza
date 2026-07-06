// @vitest-environment jsdom
//
// ChatSurface presentation + send wiring: renders the greeting on an empty
// thread, bubbles for prior messages, and gates the send button on non-empty
// input (firing onSend with the trimmed text). Real component in jsdom.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const inlineWidgetMock = vi.hoisted(() => ({
  sendActionMessage: vi.fn(),
}));

vi.mock("../../chat/InlineWidgetText", async () => {
  const React = await import("react");
  return {
    InlineWidgetText({ content }: { content: string }) {
      const match = content.match(/(__first_run__:runtime:cloud)=([^\n]+)/);
      if (!match) return content;
      return React.createElement(
        "button",
        {
          type: "button",
          onClick: () => void inlineWidgetMock.sendActionMessage(match[1]),
        },
        match[2],
      );
    },
  };
});

import { ChatSurface } from "../ChatSurface";
import type { ShellMessage } from "../shell-state";

afterEach(() => {
  cleanup();
  inlineWidgetMock.sendActionMessage.mockReset();
});

describe("ChatSurface", () => {
  it("renders the greeting when there are no messages", () => {
    render(
      <ChatSurface
        messages={[]}
        onSend={() => {}}
        canSend={true}
        greeting="Good morning! What would you like to do?"
      />,
    );
    expect(
      screen.getByText("Good morning! What would you like to do?"),
    ).toBeTruthy();
  });

  it("renders bubbles for prior messages", () => {
    const messages: ShellMessage[] = [
      {
        id: "1",
        role: "user",
        content: "Remind me to call Alex at 3pm",
        createdAt: 0,
      },
      {
        id: "2",
        role: "assistant",
        content: "Done — reminder set for 3:00 PM.",
        createdAt: 0,
      },
    ];
    render(
      <ChatSurface messages={messages} onSend={() => {}} canSend={true} />,
    );
    expect(screen.getByText("Remind me to call Alex at 3pm")).toBeTruthy();
    expect(screen.getByText(/Done — reminder set/)).toBeTruthy();
  });

  it("renders first-run sign-in choices as clickable buttons", () => {
    const messages: ShellMessage[] = [
      {
        id: "first-run:greeting",
        role: "assistant",
        content: [
          "Hi — I'm Eliza. Sign in to Eliza Cloud and I'll get you set up.",
          "",
          "[CHOICE:first-run id=runtime]",
          "__first_run__:runtime:cloud=Sign in to Eliza Cloud",
          "[/CHOICE]",
        ].join("\n"),
        createdAt: 0,
      },
    ];

    render(
      <ChatSurface messages={messages} onSend={() => {}} canSend={true} />,
    );

    const signIn = screen.getByRole("button", {
      name: "Sign in to Eliza Cloud",
    });
    expect(signIn.tagName).toBe("BUTTON");
    expect(screen.queryByText("[CHOICE:first-run id=runtime]")).toBeNull();

    fireEvent.click(signIn);
    expect(inlineWidgetMock.sendActionMessage).toHaveBeenCalledWith(
      "__first_run__:runtime:cloud",
    );
  });

  it("disables send when input is empty", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={true} />);
    expect(
      (
        screen.getByRole("button", {
          name: "Send message",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("enables send when input has text and calls onSend", () => {
    const onSend = vi.fn();
    render(<ChatSurface messages={[]} onSend={onSend} canSend={true} />);
    const input = screen.getByPlaceholderText(/ask eliza/i);
    fireEvent.change(input, { target: { value: "Hi" } });
    const send = screen.getByRole("button", {
      name: /send/i,
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith("Hi");
  });

  it("clears the input after a successful send", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={true} />);
    const input = screen.getByPlaceholderText(/ask eliza/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(input.value).toBe("");
  });

  it("disables the input + send when canSend=false", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={false} />);
    expect(
      (screen.getByPlaceholderText(/ask eliza/i) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /send/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("renders composer controls with the overlay icon-button touch target", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={true} />);
    const voiceToggle = screen.getByRole("button", {
      name: /voice input/i,
    }) as HTMLButtonElement;
    const send = screen.getByRole("button", {
      name: "Send message",
    }) as HTMLButtonElement;

    expect(voiceToggle.disabled).toBe(true);
    expect(voiceToggle.className).toContain("h-11");
    expect(voiceToggle.className).toContain("w-11");
    expect(send.className).toContain("h-11");
    expect(send.className).toContain("w-11");
    expect(voiceToggle.querySelector("svg")).not.toBeNull();
    expect(voiceToggle.querySelector("path[fill]")).toBeNull();
  });

  it("enables the voice toggle and toggles voice capture when wired", () => {
    const onToggleRecording = vi.fn();
    render(
      <ChatSurface
        messages={[]}
        onSend={() => {}}
        canSend={true}
        onToggleRecording={onToggleRecording}
      />,
    );
    const voiceToggle = screen.getByRole("button", {
      name: /start voice input/i,
    }) as HTMLButtonElement;
    expect(voiceToggle.disabled).toBe(false);
    expect(voiceToggle.querySelector("svg")).not.toBeNull();
    const input = screen.getByLabelText("Message Eliza");
    // The mic is a trailing control: it follows the text input in the composer.
    expect(
      input.compareDocumentPosition(voiceToggle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(voiceToggle);
    expect(onToggleRecording).toHaveBeenCalledTimes(1);
  });

  it("submits on Enter (without Shift)", () => {
    const onSend = vi.fn();
    render(<ChatSurface messages={[]} onSend={onSend} canSend={true} />);
    const input = screen.getByPlaceholderText(/ask eliza/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "From keyboard" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("From keyboard");
    expect(input.value).toBe("");
  });

  it("does not submit on Shift+Enter", () => {
    const onSend = vi.fn();
    render(<ChatSurface messages={[]} onSend={onSend} canSend={true} />);
    const input = screen.getByPlaceholderText(/ask eliza/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Draft" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("Draft");
  });

  it("renders a typing indicator for an empty assistant placeholder", () => {
    const messages: ShellMessage[] = [
      { id: "u", role: "user", content: "Hi", createdAt: 0 },
      { id: "a", role: "assistant", content: "", createdAt: 1 },
    ];
    render(
      <ChatSurface messages={messages} onSend={() => {}} canSend={true} />,
    );
    const typing = screen.getByLabelText(/eliza is typing/i);
    expect(typing).toBeTruthy();
  });

  it("hides the VISION button when no onVision handler is provided", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={true} />);
    expect(screen.queryByRole("button", { name: /my screen/i })).toBeNull();
  });

  it("renders an enabled VISION button that fires onVision when wired", () => {
    const onVision = vi.fn();
    render(
      <ChatSurface
        messages={[]}
        onSend={() => {}}
        canSend={true}
        onVision={onVision}
      />,
    );
    const vision = screen.getByRole("button", {
      name: /my screen/i,
    }) as HTMLButtonElement;
    expect(vision.disabled).toBe(false);
    expect(vision.querySelector("svg")).not.toBeNull();
    fireEvent.click(vision);
    expect(onVision).toHaveBeenCalledTimes(1);
  });

  it("disables the VISION button while a capture is in flight", () => {
    render(
      <ChatSurface
        messages={[]}
        onSend={() => {}}
        canSend={true}
        onVision={() => {}}
        visionActive={true}
      />,
    );
    expect(
      (screen.getByRole("button", { name: /my screen/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("disables the VISION button when canSend=false", () => {
    render(
      <ChatSurface
        messages={[]}
        onSend={() => {}}
        canSend={false}
        onVision={() => {}}
      />,
    );
    expect(
      (screen.getByRole("button", { name: /my screen/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("hides the jump-to-latest control while resting at the bottom", () => {
    const messages: ShellMessage[] = [
      { id: "u", role: "user", content: "Hi", createdAt: 0 },
      { id: "a", role: "assistant", content: "Hello", createdAt: 1 },
    ];
    render(
      <ChatSurface messages={messages} onSend={() => {}} canSend={true} />,
    );
    // jsdom reports zero geometry → the reader counts as at-bottom → no control.
    expect(screen.queryByTestId("chat-surface-jump-to-latest")).toBeNull();
  });

  it("reveals a jump-to-latest control when scrolled up and snaps to the bottom on click", () => {
    const messages: ShellMessage[] = [
      { id: "u", role: "user", content: "Hi", createdAt: 0 },
      { id: "a", role: "assistant", content: "Hello", createdAt: 1 },
    ];
    render(
      <ChatSurface messages={messages} onSend={() => {}} canSend={true} />,
    );
    const scroller = screen
      .getByTestId("shell-chat-surface")
      .querySelector(".overflow-y-auto") as HTMLDivElement;
    // Stub a tall, scrolled-up scroller so `atBottom` reads false.
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
    scroller.scrollTo = ((opts: ScrollToOptions) => {
      top = opts.top ?? top;
    }) as HTMLElement["scrollTo"];
    fireEvent.scroll(scroller);
    const jump = screen.getByTestId("chat-surface-jump-to-latest");
    expect(jump).toBeTruthy();
    fireEvent.click(jump);
    expect(scroller.scrollTop).toBe(2000);
  });

  it("marks the conversation list as a polite aria-live region for streaming announcements", () => {
    const messages: ShellMessage[] = [
      { id: "u", role: "user", content: "Hi", createdAt: 0 },
      { id: "a", role: "assistant", content: "Hello", createdAt: 1 },
    ];
    render(
      <ChatSurface messages={messages} onSend={() => {}} canSend={true} />,
    );
    const list = screen.getByRole("list");
    expect(list.getAttribute("aria-live")).toBe("polite");
    expect(list.getAttribute("aria-atomic")).toBe("false");
  });
});
