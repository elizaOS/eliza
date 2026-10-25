// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ConversationMessage } from "../../../api/client-types-chat";
import { MessageContent } from "../MessageContent";

afterEach(cleanup);

const photo = {
  id: "att-1",
  url: "https://media.example.test/photo.png",
  contentType: "image" as const,
  mimeType: "image/png",
  title: "photo.png",
};

function message(
  overrides: Partial<ConversationMessage>,
): ConversationMessage {
  return {
    id: "msg-1",
    role: "user",
    text: "",
    timestamp: 1_760_000_000_000,
    attachments: [photo],
    ...overrides,
  };
}

function renderedImageSources(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("img")).map(
    (img) => img.getAttribute("src") ?? "",
  );
}

it("shows the attached photo under a plain-text user caption", () => {
  const { container } = render(
    <MessageContent message={message({ text: "what is this?" })} />,
  );
  expect(screen.getByText("what is this?")).toBeTruthy();
  expect(renderedImageSources(container)).toEqual([
    "https://media.example.test/photo.png",
  ]);
});

it("shows a generated image under a plain-text assistant reply", () => {
  const { container } = render(
    <MessageContent
      message={message({ role: "assistant", text: "Here is your image." })}
    />,
  );
  expect(screen.getByText("Here is your image.")).toBeTruthy();
  expect(renderedImageSources(container)).toEqual([
    "https://media.example.test/photo.png",
  ]);
});

it("shows an image-only user send", () => {
  const { container } = render(<MessageContent message={message({})} />);
  expect(renderedImageSources(container)).toEqual([
    "https://media.example.test/photo.png",
  ]);
});
