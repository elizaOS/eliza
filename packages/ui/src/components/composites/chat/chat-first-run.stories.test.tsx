/**
 * Renders the first-run stories with their real chat components and verifies
 * static-message and next-step interaction behavior. Browser story play owns
 * computed surface and geometry proof; jsdom does not impersonate layout.
 */
// @vitest-environment jsdom

import { composeStories } from "@storybook/react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installJsdomUiPolyfills } from "../../../../test/portable-stories";
import * as bubbleStories from "./chat-bubble.stories";
import * as messageStories from "./chat-message.stories";

const { FirstRun } = composeStories(bubbleStories);
const { FirstRunStatic, FirstRunWithAction } = composeStories(messageStories);

beforeAll(installJsdomUiPolyfills);
afterEach(cleanup);

describe("first-run chat stories", () => {
  it("renders the specialized bubble beside its canonical panel reference", () => {
    render(<FirstRun />);
    expect(screen.getByTestId("first-run-bubble").textContent).toContain(
      "Hi, I'm Eliza.",
    );
    expect(screen.getByTestId("first-run-reference").textContent).toContain(
      "Canonical panel reference",
    );
  });

  it("keeps the greeting static without a message action rail", () => {
    render(<FirstRunStatic />);
    expect(screen.getByLabelText("Eliza message").tabIndex).toBe(-1);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("thread-line-actions")).toBeNull();
  });

  it("focuses and activates the next step without making the greeting interactive", () => {
    render(<FirstRunWithAction />);
    const next = screen.getByRole("button", { name: "Get started" });
    act(() => next.focus());
    expect(document.activeElement).toBe(next);
    fireEvent.click(next);
    expect(screen.getByRole("button", { name: "Ready" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByLabelText("Eliza message").getAttribute("role"),
    ).toBeNull();
    expect(screen.queryByTestId("thread-line-actions")).toBeNull();
  });
});
