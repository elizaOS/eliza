// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_INTENTS,
  LIFEOPS_VOICE_COMMAND_PROMPT,
} from "./LifeOpsAssistantSection.js";
import {
  LifeOpsOverviewAssistantDock,
  LifeOpsOverviewSignalsPanel,
} from "./LifeOpsOverviewSection.js";

vi.mock(
  "react",
  async () =>
    await import(
      "../../../../node_modules/.bun/react@19.2.5/node_modules/react/index.js"
    ),
);

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: vi.fn(), agentProps: {} }),
}));

const openLifeOpsChat = vi.fn();
const navigate = vi.fn();

afterEach(() => {
  cleanup();
  openLifeOpsChat.mockClear();
  navigate.mockClear();
});

describe("LifeOpsOverviewAssistantDock", () => {
  it("renders compact chat-first commands without panel copy", () => {
    const { container } = render(
      <LifeOpsOverviewAssistantDock
        onNavigate={navigate}
        openLifeOpsChat={openLifeOpsChat}
      />,
    );

    expect(container.querySelectorAll("p")).toHaveLength(0);
    expect(screen.getByTestId("lifeops-overview-assistant-dock")).toBeTruthy();
    expect(screen.getAllByTestId("lifeops-overview-assistant-command")).toHaveLength(
      4,
    );
    for (const label of [
      "Ask LifeOps",
      "Voice command",
      "Triage",
      "Brief",
      "Open Assistant",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("launches overview assistant commands into chat and opens the assistant surface", () => {
    render(
      <LifeOpsOverviewAssistantDock
        onNavigate={navigate}
        openLifeOpsChat={openLifeOpsChat}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Ask LifeOps" }));
    expect(openLifeOpsChat).toHaveBeenLastCalledWith(
      ASSISTANT_INTENTS.find((intent) => intent.id === "command-brief")
        ?.prompt,
      {},
      { select: true },
    );

    fireEvent.click(screen.getByRole("button", { name: "Voice command" }));
    expect(openLifeOpsChat).toHaveBeenLastCalledWith(
      LIFEOPS_VOICE_COMMAND_PROMPT,
      {},
      { select: false },
    );

    fireEvent.click(screen.getByRole("button", { name: "Triage" }));
    expect(openLifeOpsChat).toHaveBeenLastCalledWith(
      ASSISTANT_INTENTS.find((intent) => intent.id === "inbox-decisions")
        ?.prompt,
      {},
      { select: true },
    );

    fireEvent.click(screen.getByRole("button", { name: "Brief" }));
    expect(openLifeOpsChat).toHaveBeenLastCalledWith(
      ASSISTANT_INTENTS.find((intent) => intent.id === "command-brief")
        ?.prompt,
      {},
      { select: true },
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Assistant" }));
    expect(navigate).toHaveBeenCalledWith("assistant");
  });
});

describe("LifeOpsOverviewSignalsPanel", () => {
  it("renders compact assistant signal buttons without panel copy", () => {
    const { container } = render(
      <LifeOpsOverviewSignalsPanel
        social={{ value: "45m" }}
        onNavigate={navigate}
      />,
    );

    expect(container.querySelectorAll("p")).toHaveLength(0);
    expect(screen.getByTestId("lifeops-overview-signals")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Ask about social" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Ask about signals" }),
    ).toBeTruthy();
  });

  it("routes every overview signal into the assistant", () => {
    render(
      <LifeOpsOverviewSignalsPanel
        social={{ value: "12m" }}
        onNavigate={navigate}
      />,
    );

    for (const label of [
      "Ask about social",
      "Ask about signals",
    ]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(navigate).toHaveBeenLastCalledWith("assistant");
    }

    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("renders nothing when no signals are available", () => {
    const { container } = render(
      <LifeOpsOverviewSignalsPanel onNavigate={navigate} />,
    );

    expect(container.firstChild).toBeNull();
  });
});
