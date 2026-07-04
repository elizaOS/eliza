// @vitest-environment jsdom
//
// FtuWelcomeWidget: renders only on the home slot (greeting + suggestion chips),
// prefills the chat and marks the card acted when a chip is tapped, retires on
// dismiss, and ignores unrelated activity. jsdom render; prompt suggestions and
// the home-dismissal store are mocked (no backend).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetHomeDismissalsForTests } from "../../../widgets/home-dismissal-store";
import { FTU_WELCOME_HOME_WIDGET } from "./ftu-welcome";

vi.mock("../../shell/usePromptSuggestions", () => ({
  usePromptSuggestions: () => [
    "Plan my day",
    "Draft a reply",
    "What can you do?",
  ],
}));

const { Component: FtuWelcome } = FTU_WELCOME_HOME_WIDGET;
const KEY = "welcome/welcome.ftu";

function dismissedState() {
  return JSON.parse(localStorage.getItem("eliza:home-dismissed:v1") ?? "{}")[
    KEY
  ];
}

afterEach(() => {
  cleanup();
  __resetHomeDismissalsForTests();
  vi.restoreAllMocks();
});

describe("FtuWelcomeWidget", () => {
  it("renders nothing off the home slot", () => {
    const { container } = render(<FtuWelcome slot="chat-sidebar" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the greeting + suggestion chips on the home slot", () => {
    render(<FtuWelcome slot="home" />);
    // getByTestId / getByText throw when absent, so reaching here is the assertion.
    expect(screen.getByTestId("chat-widget-ftu-welcome")).toBeTruthy();
    expect(screen.getAllByTestId("ftu-welcome-chip")).toHaveLength(3);
    expect(screen.getByText("Plan my day")).toBeTruthy();
  });

  it("tapping a chip prefills the chat and marks the card acted", () => {
    const prefilled: string[] = [];
    const onPrefill = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.text) prefilled.push(detail.text);
    };
    window.addEventListener("eliza:chat:prefill", onPrefill);
    render(<FtuWelcome slot="home" />);
    fireEvent.click(screen.getByText("Draft a reply"));
    window.removeEventListener("eliza:chat:prefill", onPrefill);
    expect(prefilled).toContain("Draft a reply");
    expect(dismissedState()).toMatchObject({ acted: true });
  });

  it("the dismiss control retires the card", () => {
    render(<FtuWelcome slot="home" />);
    fireEvent.click(screen.getByTestId("ftu-welcome-dismiss"));
    expect(dismissedState()).toMatchObject({ dismissed: true });
  });

  it.each([
    "message_sent",
    "message_received",
  ])("retires once the first chat event arrives (%s)", (eventType) => {
    render(
      <FtuWelcome
        slot="home"
        events={[{ id: "1", eventType, timestamp: 1 } as never]}
      />,
    );
    expect(dismissedState()).toMatchObject({ acted: true });
  });

  it("does not retire for unrelated activity", () => {
    render(
      <FtuWelcome
        slot="home"
        events={[{ id: "1", eventType: "blocked", timestamp: 1 } as never]}
      />,
    );
    expect(dismissedState()).toMatchObject({ seen: 1 });
  });

  it("declares the show-once-then-retire sunset policy", () => {
    expect(FTU_WELCOME_HOME_WIDGET.sunset).toEqual({
      afterAction: true,
      dismissible: true,
    });
    expect(FTU_WELCOME_HOME_WIDGET.signalKinds).toEqual(["welcome"]);
  });
});
