// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PromptInput,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
} from "./prompt-input";

function ProviderPrompt({ onSubmit }: { onSubmit: (message: PromptInputMessage) => void }) {
  return (
    <PromptInputProvider>
      <PromptInput onSubmit={onSubmit}>
        <PromptInputTextarea aria-label="Message" />
        <PromptInputSubmit>Send</PromptInputSubmit>
      </PromptInput>
    </PromptInputProvider>
  );
}

function AttachmentCount() {
  const attachments = usePromptInputAttachments();
  return <span data-testid="attachment-count">{attachments.files.length}</span>;
}

describe("PromptInput provider bridge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits the latest provider text without rerendering the form shell on typing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const onSubmit = vi.fn();
    render(<ProviderPrompt onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "hello from provider text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      text: "hello from provider text",
      files: [],
    });
    expect(
      info.mock.calls.some(([message]) =>
        String(message).includes('"PromptInput" rendered 2 times'),
      ),
    ).toBe(false);
  });

  it("handles file drops on the local form when global drop is disabled", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:prompt-input-test"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <PromptInput data-testid="prompt-form" onSubmit={vi.fn()}>
        <AttachmentCount />
      </PromptInput>,
    );

    fireEvent.drop(screen.getByTestId("prompt-form"), {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["hello"], "hello.txt", { type: "text/plain" })],
      },
    });

    await waitFor(() => expect(screen.getByTestId("attachment-count")).toHaveTextContent("1"));
  });
});
