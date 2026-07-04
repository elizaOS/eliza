// @vitest-environment jsdom
/**
 * Renders ChatEmptyStateWithRecommendations in jsdom and asserts that tapping a
 * recommendation prefills the composer (via CHAT_PREFILL_EVENT) and that the
 * primary setup action fires. React Testing Library, no live model.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_PREFILL_EVENT,
  type ChatPrefillEventDetail,
} from "../../../events";
import { ChatEmptyStateWithRecommendations } from "./ChatEmptyStateWithRecommendations";

afterEach(cleanup);

describe("ChatEmptyStateWithRecommendations", () => {
  it("prefills the chat composer when a recommendation is tapped", () => {
    const events: ChatPrefillEventDetail[] = [];
    const listener = (e: Event) =>
      events.push((e as CustomEvent<ChatPrefillEventDetail>).detail);
    window.addEventListener(CHAT_PREFILL_EVENT, listener);

    render(
      <ChatEmptyStateWithRecommendations
        recommendations={[
          "Upload a document",
          { label: "Summarize", prompt: "Summarize my docs" },
        ]}
      />,
    );

    fireEvent.click(screen.getByText("Upload a document"));
    fireEvent.click(screen.getByText("Summarize"));
    window.removeEventListener(CHAT_PREFILL_EVENT, listener);

    expect(events).toEqual([
      { text: "Upload a document", select: true },
      { text: "Summarize my docs", select: true },
    ]);
  });

  it("fires the primary setup action and skips chips when none are given", () => {
    const onClick = vi.fn();
    render(
      <ChatEmptyStateWithRecommendations
        title="No keys yet"
        primaryAction={{ label: "Add keys", onClick }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add keys" }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByText("No keys yet")).toBeDefined();
  });
});
