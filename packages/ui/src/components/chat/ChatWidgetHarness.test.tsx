// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  client: {
    getCodingAgentTaskThread: vi.fn().mockResolvedValue(null),
    onWsEvent: vi.fn(() => () => undefined),
  },
}));

import { ChatWidgetHarness } from "./ChatWidgetHarness";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverStub);

describe("ChatWidgetHarness", () => {
  afterEach(cleanup);

  it("renders the backend-free widget transcript", () => {
    render(<ChatWidgetHarness />);

    expect(screen.getByTestId("chat-widget-harness")).toBeTruthy();
    expect(screen.getByText("Choice")).toBeTruthy();
    expect(screen.getByText("Structured form")).toBeTruthy();
    expect(screen.getByText("Workflow")).toBeTruthy();
    expect(screen.getByText("Checklist")).toBeTruthy();
    expect(screen.getByText("Code block")).toBeTruthy();
  });

  it("keeps composer interactions entirely in local state", async () => {
    const user = userEvent.setup();
    render(<ChatWidgetHarness />);

    const composer = screen.getByRole("textbox", { name: "Gallery message" });
    await user.type(composer, "Test the keyboard");
    await user.click(
      screen.getByRole("button", { name: "Send local message" }),
    );

    expect(screen.getByText("Test the keyboard")).toBeTruthy();
    expect(screen.getByText(/Mock response added/)).toBeTruthy();
    expect((composer as HTMLTextAreaElement).value).toBe("");
  });
});
