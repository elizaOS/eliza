/**
 * Verifies that the Cloud first-five-minutes surface exposes one-agent trust
 * boundaries and complete, truthful interaction/recovery contracts for every
 * requested connector without making network calls.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectorFirstInteractionGuide,
  SharedAgentFirstFiveMinutes,
} from "./SharedAgentFirstFiveMinutes";

describe("SharedAgentFirstFiveMinutes", () => {
  afterEach(() => cleanup());

  it("starts from web chat and preserves one agent with separate credentials", () => {
    render(<SharedAgentFirstFiveMinutes />);

    const guide = screen.getByTestId("shared-agent-first-five-minutes");
    expect(guide.textContent).toContain("canonical Eliza agent and runtime");
    expect(guide.textContent).toContain("never creates a second agent");
    expect(guide.textContent).toContain("green credential probe is not");
    expect(
      screen.getByRole("link", { name: /Open web chat/ }).getAttribute("href"),
    ).toBe("/chat");
    expect(
      screen.getByRole("link", { name: /Telegram/ }).getAttribute("href"),
    ).toBe("#telegram-connection");
  });

  it("covers Telegram DM proof, hosted group limits, identity, dedupe, and retry", () => {
    render(<ConnectorFirstInteractionGuide connector="telegram" />);
    const guide = screen.getByTestId("telegram-first-interaction-guide");

    expect(guide.textContent).toContain("private bot chats");
    expect(guide.textContent).toContain("same Eliza account and agent");
    expect(guide.textContent).toContain("replay ledger");
    expect(guide.textContent).toContain(
      "groups and supergroups are not enabled",
    );
    expect(guide.textContent).toContain("refresh status");
  });

  it("separates Blooio and BlueBubbles while covering thread mapping and groups", () => {
    render(<ConnectorFirstInteractionGuide connector="blooio" />);
    const guide = screen.getByTestId("blooio-first-interaction-guide");

    expect(guide.textContent).toContain("Choose one transport");
    expect(guide.textContent).toContain("Full Disk Access");
    expect(guide.textContent).toContain("stable chat GUID");
    expect(guide.textContent).toContain(
      "Blooio group webhooks are intentionally rejected",
    );
    expect(guide.textContent).toContain(
      "Disconnect or remove the Messages participant",
    );
  });

  it("covers Twilio consent, verified caller identity, continuity, hangup, and conferences", () => {
    render(<ConnectorFirstInteractionGuide connector="twilio" />);
    const guide = screen.getByTestId("twilio-first-interaction-guide");

    expect(guide.textContent).toContain("consent or recording-disclosure");
    expect(guide.textContent).toContain("phone number already verified");
    expect(guide.textContent).toContain("continuity-aware opening");
    expect(guide.textContent).toContain("idempotency key");
    expect(guide.textContent).toContain(
      "Conference and group-call participation are not supported",
    );
    expect(guide.textContent).toContain("Hang up a stuck call");
  });
});
