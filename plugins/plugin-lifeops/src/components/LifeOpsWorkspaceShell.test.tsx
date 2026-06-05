// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_INTENTS,
  LIFEOPS_VOICE_COMMAND_PROMPT,
} from "./LifeOpsAssistantSection.helpers.js";
import { LifeOpsWorkspaceShell } from "./LifeOpsWorkspaceShell.js";

vi.mock(
  "react",
  async () =>
    await import(
      "../../../../node_modules/.bun/react@19.2.5/node_modules/react/index.js"
    ),
);

const openLifeOpsChat = vi.fn();

vi.mock("./LifeOpsChatAdapter.helpers.js", () => ({
  useLifeOpsChatLauncher: () => ({ openLifeOpsChat }),
}));

afterEach(() => {
  cleanup();
  openLifeOpsChat.mockClear();
});

describe("LifeOpsWorkspaceShell", () => {
  it("renders a single pane with a top section-tab bar and assistant controls", () => {
    render(
      <LifeOpsWorkspaceShell
        compactLayout={true}
        section="overview"
        navigate={() => undefined}
      >
        <main>Overview</main>
      </LifeOpsWorkspaceShell>,
    );

    expect(screen.getByTestId("lifeops-nav-tabs")).toBeTruthy();
    expect(screen.getByTestId("lifeops-mobile-assistant-dock")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open LifeOps chat" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open LifeOps voice command" }),
    ).toBeTruthy();
  });

  it("launches mobile chat and voice commands through the LifeOps chat launcher", () => {
    render(
      <LifeOpsWorkspaceShell
        compactLayout={true}
        section="overview"
        navigate={() => undefined}
      >
        <main>Overview</main>
      </LifeOpsWorkspaceShell>,
    );

    fireEvent.click(screen.getByTestId("lifeops-mobile-chat-command"));
    expect(openLifeOpsChat).toHaveBeenLastCalledWith(
      ASSISTANT_INTENTS[0]?.prompt,
      {},
      { select: true },
    );

    fireEvent.click(screen.getByTestId("lifeops-mobile-voice-command"));
    expect(openLifeOpsChat).toHaveBeenLastCalledWith(
      LIFEOPS_VOICE_COMMAND_PROMPT,
      {},
      { select: false },
    );
  });
});
