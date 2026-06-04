// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_INTENTS,
  LIFEOPS_ASSISTANT_INTENTS,
  LIFEOPS_VOICE_COMMAND_PROMPT,
  LifeOpsAssistantIntentGrid,
  LifeOpsAssistantSection,
} from "./LifeOpsAssistantSection.js";

vi.mock(
  "react",
  async () =>
    await import(
      "../../../../node_modules/.bun/react@19.2.5/node_modules/react/index.js"
    ),
);

const openLifeOpsChat = vi.fn();

const EXECUTIVE_ASSISTANT_INTENT_IDS = [
  "approval-batch",
  "board-pack-prep",
  "chief-of-staff-handoff",
  "command-brief",
  "delegate",
  "delegation-map",
  "documents",
  "closeout",
  "event-planning",
  "expenses",
  "family-logistics",
  "finance-dispute",
  "gift-milestone",
  "hiring-loop",
  "home-ops",
  "interruption-firebreak",
  "intro-routing",
  "legal-deadline",
  "meeting-prep",
  "outage-recovery",
  "people",
  "privacy-redaction",
  "remote-agent-stuck",
  "renewals",
  "status-compression",
  "travel-disruption",
  "travel",
  "vendor-negotiation",
  "vip-escalation",
  "waiting-on",
  "weekly-operating-review",
] as const;

vi.mock("./LifeOpsChatAdapter.helpers.js", () => ({
  useLifeOpsChatLauncher: () => ({ openLifeOpsChat }),
}));

afterEach(() => {
  cleanup();
  openLifeOpsChat.mockClear();
});

describe("LifeOpsAssistantIntentGrid", () => {
  it("renders and launches every assistant command", () => {
    const launched: string[] = [];

    render(
      <LifeOpsAssistantIntentGrid
        onLaunch={(intent) => launched.push(intent.id)}
      />,
    );

    const buttons = screen.getAllByTestId("lifeops-assistant-intent");
    expect(buttons).toHaveLength(LIFEOPS_ASSISTANT_INTENTS.length);

    for (const intent of LIFEOPS_ASSISTANT_INTENTS) {
      fireEvent.click(screen.getByLabelText(intent.label));
    }

    expect(launched).toEqual(
      LIFEOPS_ASSISTANT_INTENTS.map((intent) => intent.id),
    );
    expect(
      new Set(LIFEOPS_ASSISTANT_INTENTS.map((intent) => intent.prompt)).size,
    ).toBe(LIFEOPS_ASSISTANT_INTENTS.length);
  });

  it("keeps plugin-health commands out of the LifeOps assistant deck", () => {
    render(<LifeOpsAssistantIntentGrid onLaunch={() => undefined} />);

    expect(LIFEOPS_ASSISTANT_INTENTS).toHaveLength(ASSISTANT_INTENTS.length);
    for (const intent of LIFEOPS_ASSISTANT_INTENTS) {
      expect(intent.id).not.toMatch(/^health:/);
      expect(intent.prompt.toLowerCase()).not.toContain("sleep recap");
      expect(intent.prompt.toLowerCase()).not.toContain("screen time");
    }
  });

  it("keeps the assistant deck aligned to executive assistant scenarios", () => {
    const intentIds = new Set(ASSISTANT_INTENTS.map((intent) => intent.id));

    for (const id of EXECUTIVE_ASSISTANT_INTENT_IDS) {
      expect(intentIds.has(id)).toBe(true);
    }
  });
});

describe("LifeOpsAssistantSection", () => {
  it("keeps the assistant landing surface icon-led and free of paragraph copy", () => {
    const { container } = render(<LifeOpsAssistantSection />);

    expect(container.querySelectorAll("p")).toHaveLength(0);
    expect(screen.getByTestId("lifeops-assistant-intents")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Quick / })).toHaveLength(5);
    expect(
      screen.getByRole("button", { name: "Open LifeOps voice command" }),
    ).toBeTruthy();
  });

  it("launches the command brief, voice command, and quick prompts into chat", () => {
    render(<LifeOpsAssistantSection />);

    fireEvent.click(screen.getByTestId("lifeops-assistant-command-brief"));
    expect(openLifeOpsChat).toHaveBeenLastCalledWith(
      ASSISTANT_INTENTS[0]?.prompt,
      {},
      { select: true },
    );

    fireEvent.click(screen.getByTestId("lifeops-assistant-voice-command"));
    expect(openLifeOpsChat).toHaveBeenLastCalledWith(
      LIFEOPS_VOICE_COMMAND_PROMPT,
      {},
      { select: false },
    );

    for (const intent of ASSISTANT_INTENTS.slice(0, 5)) {
      fireEvent.click(
        screen.getByRole("button", { name: `Quick ${intent.label}` }),
      );
      expect(openLifeOpsChat).toHaveBeenLastCalledWith(
        intent.prompt,
        {},
        { select: true },
      );
    }
  });

  it("launches every full-grid assistant intent from the actual assistant surface", () => {
    render(<LifeOpsAssistantSection />);

    for (const intent of LIFEOPS_ASSISTANT_INTENTS) {
      fireEvent.click(screen.getByRole("button", { name: intent.label }));
      expect(openLifeOpsChat).toHaveBeenLastCalledWith(
        intent.prompt,
        {},
        { select: true },
      );
    }

    expect(openLifeOpsChat).toHaveBeenCalledTimes(
      LIFEOPS_ASSISTANT_INTENTS.length,
    );
  });
});
