// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VoiceProfilesClient } from "../../api/client-voice-profiles";
import { VoicePrefixSteps } from "./VoicePrefixSteps";

afterEach(() => {
  cleanup();
});

function makeClient(overrides?: Partial<VoiceProfilesClient>) {
  const base = new VoiceProfilesClient({ fetch: async () => ({ profiles: [] }) });
  return Object.assign(base, overrides);
}

const baseProps = {
  tier: "GOOD" as const,
  onAdvance: vi.fn(),
  onBack: vi.fn(),
};

describe("VoicePrefixSteps", () => {
  it("renders the welcome step with the mic permission CTA", () => {
    const onAdvance = vi.fn();
    render(
      <VoicePrefixSteps
        {...baseProps}
        step="welcome"
        onAdvance={onAdvance}
        profilesClient={makeClient()}
      />,
    );
    expect(screen.getByTestId("voice-prefix-welcome")).toBeTruthy();
    expect(
      screen.getByTestId("voice-prefix-welcome-request-mic"),
    ).toBeTruthy();
  });

  it("renders the tier banner for the chosen tier", () => {
    render(
      <VoicePrefixSteps
        {...baseProps}
        step="tier"
        tier="MAX"
        profilesClient={makeClient()}
      />,
    );
    expect(screen.getByTestId("voice-tier-banner").getAttribute("data-tier")).toBe(
      "MAX",
    );
  });

  it("step 4 plays the scripted greeting", () => {
    const onAgentSpeak = vi.fn();
    render(
      <VoicePrefixSteps
        {...baseProps}
        step="agent-speaks"
        onAgentSpeak={onAgentSpeak}
        profilesClient={makeClient()}
      />,
    );
    fireEvent.click(screen.getByTestId("voice-prefix-agent-speaks-play"));
    expect(onAgentSpeak).toHaveBeenCalledTimes(1);
    expect(onAgentSpeak.mock.calls[0]?.[0]).toContain("Eliza");
  });

  it("step 5 walks through the capture prompts", async () => {
    const client = makeClient({
      startOwnerCapture: async () => ({
        sessionId: "s1",
        prompts: [
          { id: "p1", text: "Say hi", targetSeconds: 5 },
          { id: "p2", text: "Tell me a sentence", targetSeconds: 6 },
        ],
        expectedSeconds: 11,
      }),
    });
    render(
      <VoicePrefixSteps
        {...baseProps}
        step="user-speaks"
        profilesClient={client}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("voice-prefix-user-speaks-prompt").textContent).toContain(
        "Say hi",
      );
    });
    // Skip the first prompt → advances to the second.
    fireEvent.click(screen.getByTestId("voice-prefix-user-speaks-skip-prompt"));
    await waitFor(() => {
      expect(screen.getByTestId("voice-prefix-user-speaks-prompt").textContent).toContain(
        "Tell me a sentence",
      );
    });
  });

  it("step 6 confirms OWNER and emits onOwnerSaved", async () => {
    const finalizeOwnerCapture = vi.fn(async (_id: string, payload: { displayName: string }) => ({
      profileId: "p-owner",
      entityId: "e-owner",
      isOwner: true,
      displayName: payload.displayName,
    }));
    const client = makeClient({
      finalizeOwnerCapture,
    });
    const onOwnerSaved = vi.fn();
    render(
      <VoicePrefixSteps
        {...baseProps}
        step="owner-confirm"
        profilesClient={client}
        onOwnerSaved={onOwnerSaved}
        initialOwnerDisplayName="Shaw"
      />,
    );

    expect(screen.getByTestId("voice-prefix-owner-confirm-crown")).toBeTruthy();
    fireEvent.click(screen.getByTestId("voice-prefix-owner-confirm-save"));

    await waitFor(() => {
      expect(finalizeOwnerCapture).toHaveBeenCalled();
      expect(onOwnerSaved).toHaveBeenCalled();
    });
    const args = onOwnerSaved.mock.calls[0]?.[0] as
      | { isOwner: boolean; displayName: string }
      | undefined;
    expect(args?.isOwner).toBe(true);
    expect(args?.displayName).toBe("Shaw");
  });

  it("family step is marked optional and shows the empty state", () => {
    render(
      <VoicePrefixSteps
        {...baseProps}
        step="family"
        profilesClient={makeClient()}
      />,
    );
    expect(screen.getByTestId("voice-prefix-family-list").textContent).toContain(
      "No additional people",
    );
    // Skip is rendered for optional steps.
    expect(screen.getByTestId("voice-prefix-skip")).toBeTruthy();
  });

  it("Continue button calls onAdvance with the next step in the graph", () => {
    const onAdvance = vi.fn();
    render(
      <VoicePrefixSteps
        {...baseProps}
        step="welcome"
        onAdvance={onAdvance}
        profilesClient={makeClient()}
      />,
    );
    fireEvent.click(screen.getByTestId("voice-prefix-continue"));
    expect(onAdvance).toHaveBeenCalledWith("tier");
  });

  it("Continue from tier on POOR jumps directly to agent-speaks", () => {
    const onAdvance = vi.fn();
    render(
      <VoicePrefixSteps
        {...baseProps}
        step="tier"
        tier="POOR"
        onAdvance={onAdvance}
        profilesClient={makeClient()}
      />,
    );
    fireEvent.click(screen.getByTestId("voice-prefix-continue"));
    expect(onAdvance).toHaveBeenCalledWith("agent-speaks");
  });
});
