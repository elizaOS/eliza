// @vitest-environment jsdom
//
// Render coverage for the non-bytes interaction states surfaced in chat (the
// objects the product calls out: thinking/reasoning, suggestion chips, choice
// pickers, inline forms). Mirrors the story inputs in MessageContent.stories so
// the story-gate screenshots have a fast unit guard that they render at all.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api/client-types-chat";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../../api/client", () => ({ client: {} }));

import { MessageContent } from "./MessageContent";

function assistant(over: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: "m1",
    role: "assistant",
    text: "",
    timestamp: 1_700_000_000_000,
    ...over,
  } as ConversationMessage;
}

function withApp(node: React.ReactElement) {
  const appValue = {
    t: (key: string, vars?: Record<string, unknown>) =>
      String(vars?.defaultValue ?? key),
    sendActionMessage: vi.fn(),
  } as never;
  __setAppValueForTests(appValue);
  return render(
    <AppContext.Provider value={appValue}>{node}</AppContext.Provider>,
  );
}

describe("MessageContent non-bytes interaction rendering", () => {
  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
  });

  it("renders the visible reply alongside a reasoning/thinking block", () => {
    const { container } = withApp(
      <MessageContent
        message={assistant({
          reasoning: "Cross-referencing the calendar before answering.",
          text: "You're free after 3pm.",
        })}
      />,
    );
    expect(screen.getByText(/free after 3pm/i)).toBeTruthy();
    expect(container.textContent ?? "").toContain("free after 3pm");
  });

  it("renders suggestion chips from a [FOLLOWUPS] block", () => {
    const { container } = withApp(
      <MessageContent
        message={assistant({
          text: "Done.\n[FOLLOWUPS]\nrerun=Run again\nexport=Export\n[/FOLLOWUPS]",
        })}
      />,
    );
    expect(container.textContent ?? "").toContain("Run again");
  });

  it("renders a choice picker from a [CHOICE] block", () => {
    const { container } = withApp(
      <MessageContent
        message={assistant({
          text: "Approve this booking?\n[CHOICE:approval id=c1]\nyes=Approve\nno=Reject\n[/CHOICE]",
        })}
      />,
    );
    expect(container.textContent ?? "").toContain("Approve");
  });

  it("renders an inline form from a [FORM] block", () => {
    const form = JSON.stringify({
      title: "Trip details",
      fields: [{ name: "destination", type: "text", label: "Destination" }],
    });
    const { container } = withApp(
      <MessageContent
        message={assistant({
          text: `Fill this out:\n[FORM]\n${form}\n[/FORM]`,
        })}
      />,
    );
    expect(container.textContent ?? "").toContain("Destination");
  });

  it("renders the out-of-credits gate for an insufficient_credits failure and its CTA opens Settings", () => {
    const setTab = vi.fn();
    const appValue = {
      t: (key: string, vars?: Record<string, unknown>) =>
        String(vars?.defaultValue ?? key),
      sendActionMessage: vi.fn(),
      setTab,
    } as never;
    __setAppValueForTests(appValue);
    render(
      <AppContext.Provider value={appValue}>
        <MessageContent
          message={assistant({
            failureKind: "insufficient_credits",
            text: "You're out of credits. Add more to keep chatting.",
          })}
        />
      </AppContext.Provider>,
    );

    // Designed gate, not a plain text bubble.
    expect(screen.getByText("Out of credits")).toBeTruthy();
    const cta = screen.getByRole("button", { name: "Add credits" });
    expect(cta).toBeTruthy();
    // The actionable server copy is surfaced verbatim.
    expect(
      screen.getByText(/out of credits\. Add more to keep chatting/i),
    ).toBeTruthy();

    fireEvent.click(cta);
    expect(setTab).toHaveBeenCalledWith("settings");
  });
});
