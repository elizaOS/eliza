// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ConversationMessage } from "../../../api/client-types-chat";
import { MessageContent } from "../MessageContent";

afterEach(cleanup);

const assistant = (text: string): ConversationMessage => ({
  id: "assistant-1",
  role: "assistant",
  text,
  timestamp: 1,
});

const FORM_BLOCK = [
  "I need a few details.",
  "[FORM]",
  JSON.stringify({
    title: "Trip",
    fields: [{ name: "city", type: "text", label: "City" }],
  }),
  "[/FORM]",
].join("\n");

const CHOICE_BLOCK = [
  "Which one?",
  "[CHOICE:trip-mode]",
  "train=Take the train",
  "plane=Fly",
  "[/CHOICE]",
].join("\n");

it("keeps typed form input while the reply keeps streaming and then finishes", () => {
  const { rerender } = render(
    <MessageContent message={assistant(FORM_BLOCK)} streaming />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "City" }), {
    target: { value: "Lisbon" },
  });

  rerender(
    <MessageContent
      message={assistant(`${FORM_BLOCK}\nFill it in when`)}
      streaming
    />,
  );
  expect(screen.getByRole("textbox", { name: "City" })).toHaveProperty(
    "value",
    "Lisbon",
  );

  rerender(
    <MessageContent
      message={assistant(`${FORM_BLOCK}\nFill it in when you are ready.`)}
      streaming={false}
    />,
  );
  expect(screen.getByRole("textbox", { name: "City" })).toHaveProperty(
    "value",
    "Lisbon",
  );
});

it("keeps a choice locked to the picked option while the reply keeps streaming", () => {
  const { rerender } = render(
    <MessageContent message={assistant(CHOICE_BLOCK)} streaming />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Fly" }));

  rerender(
    <MessageContent
      message={assistant(`${CHOICE_BLOCK}\nGood choice, booking`)}
      streaming
    />,
  );
  rerender(
    <MessageContent
      message={assistant(`${CHOICE_BLOCK}\nGood choice, booking now.`)}
      streaming={false}
    />,
  );

  expect(screen.getByRole("status").textContent).toBe("Selected: Fly");
  expect(screen.queryByRole("button", { name: "Fly" })).toBeNull();
});

it("keeps a picked follow-up selected when the streamed reply finishes", () => {
  const followups = [
    "Done.",
    "[FOLLOWUPS]",
    "reply:status=Show status",
    "reply:logs=Show logs",
    "[/FOLLOWUPS]",
  ].join("\n");
  const { rerender } = render(
    <MessageContent message={assistant(followups)} streaming />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Show logs" }));

  rerender(
    <MessageContent message={assistant(followups)} streaming={false} />,
  );

  expect(screen.getByRole("status").textContent).toBe("Selected: Show logs");
});
