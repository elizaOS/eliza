// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VoiceProfilesClient } from "../../api/client-voice-profiles";
import { VoicePrefixSteps } from "./VoicePrefixSteps";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeClient(overrides?: Partial<VoiceProfilesClient>) {
  const base = new VoiceProfilesClient({
    fetch: async <T,>(): Promise<T> => ({ profiles: [] }) as T,
  });
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
    const { container } = render(
      <VoicePrefixSteps
        {...baseProps}
        step="welcome"
        onAdvance={onAdvance}
        profilesClient={makeClient()}
      />,
    );
    expect(screen.getByTestId("voice-prefix-welcome")).toBeTruthy();
    // The onboarding surface uses the StartupShell blue (#0B35F1) on white
    // (#FFFFFF) palette, not the older `--onboarding-text-*` / accent token
    // system. Source-of-truth lives in VoicePrefixSteps.tsx and matches
    // StartupShell.tsx.
    expect(screen.getByTestId("voice-prefix-steps").className).toContain(
      "text-[#0B35F1]",
    );
    expect(container.querySelector("main")?.className).toContain(
      "bg-[#FFFFFF]",
    );
    expect(
      screen.getByTestId("voice-prefix-welcome-request-mic").className,
    ).toContain("bg-[#0B35F1]");
  });

  it("lets users skip voice setup from the welcome step without microphone access", () => {
    const onSkipPrefix = vi.fn();
    render(
      <VoicePrefixSteps
        {...baseProps}
        step="welcome"
        onSkipPrefix={onSkipPrefix}
        profilesClient={makeClient()}
      />,
    );

    expect(
      (screen.getByTestId("voice-prefix-continue") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("voice-prefix-skip-prefix"));
    expect(onSkipPrefix).toHaveBeenCalledTimes(1);
  });

  it("does not play the greeting when mic permission is granted", async () => {
    const onAgentSpeak = vi.fn();
    render(
      <VoicePrefixSteps
        {...baseProps}
        step="welcome"
        onAgentSpeak={onAgentSpeak}
        onRequestMicPermission={async () => true}
        profilesClient={makeClient()}
      />,
    );

    fireEvent.click(screen.getByTestId("voice-prefix-welcome-request-mic"));

    await waitFor(() => {
      expect(
        screen.getByTestId("voice-prefix-welcome-mic-granted"),
      ).toBeTruthy();
    });
    expect(onAgentSpeak).not.toHaveBeenCalled();
  });

  it("renders voice readiness and lets the user start the download", () => {
    const onModelDownloadStart = vi.fn();
    render(
      <VoicePrefixSteps
        {...baseProps}
        step="tier"
        tier="MAX"
        profilesClient={makeClient()}
        voiceBundleReadiness={{
          modelId: "eliza-1-0_8b",
          status: "available",
          message: "Eliza-1 starter voice bundle can run on this device.",
          canStartDownload: true,
        }}
        onModelDownloadStart={onModelDownloadStart}
      />,
    );
    expect(
      screen.getByTestId("voice-tier-banner").getAttribute("data-tier"),
    ).toBe("MAX");
    expect(screen.getByTestId("voice-prefix-bundle-readiness")).toBeTruthy();
    fireEvent.click(screen.getByTestId("voice-prefix-start-download"));
    expect(onModelDownloadStart).toHaveBeenCalledTimes(1);
  });

  it("final step plays the scripted greeting", async () => {
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
    await waitFor(() => {
      expect(onAgentSpeak).toHaveBeenCalledTimes(1);
    });
    expect(onAgentSpeak.mock.calls[0]?.[0]).toContain("Eliza");
    await waitFor(() => {
      expect(
        screen.getByTestId("voice-prefix-agent-speaks-play").textContent,
      ).toContain("Replay greeting");
    });
  });

  it("final step reports greeting playback failure", async () => {
    const onAgentSpeak = vi.fn(async () => {
      throw new Error("Native voice playback failed.");
    });
    render(
      <VoicePrefixSteps
        {...baseProps}
        step="agent-speaks"
        onAgentSpeak={onAgentSpeak}
        profilesClient={makeClient()}
      />,
    );
    fireEvent.click(screen.getByTestId("voice-prefix-agent-speaks-play"));
    await waitFor(() => {
      expect(
        screen.getByTestId("voice-prefix-agent-error").textContent,
      ).toContain("Native voice playback failed.");
    });
  });

  it("walks through the capture prompts", async () => {
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
      expect(
        screen.getByTestId("voice-prefix-user-speaks-prompt").textContent,
      ).toContain("Say hi");
    });
    // Skip the first prompt → advances to the second.
    fireEvent.click(screen.getByTestId("voice-prefix-user-speaks-skip-prompt"));
    await waitFor(() => {
      expect(
        screen.getByTestId("voice-prefix-user-speaks-prompt").textContent,
      ).toContain("Tell me a sentence");
    });
  });

  it("confirms OWNER and emits onOwnerSaved", async () => {
    const finalizeOwnerCapture = vi.fn(
      async (_id: string, payload: { displayName: string }) => ({
        profileId: "p-owner",
        entityId: "e-owner",
        isOwner: true,
        displayName: payload.displayName,
      }),
    );
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
    expect(
      screen.getByTestId("voice-prefix-family-empty").textContent,
    ).toContain("No additional people");
    // Skip is rendered for optional steps.
    expect(screen.getByTestId("voice-prefix-skip")).toBeTruthy();
  });

  it("Continue button calls onAdvance with the next step in the graph", () => {
    const onAdvance = vi.fn();
    render(
      <VoicePrefixSteps
        {...baseProps}
        step="tier"
        onAdvance={onAdvance}
        profilesClient={makeClient()}
      />,
    );
    fireEvent.click(screen.getByTestId("voice-prefix-continue"));
    expect(onAdvance).toHaveBeenCalled();
  });

  it("Continue from tier on POOR advances to user capture", () => {
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
    expect(onAdvance).toHaveBeenCalledWith("user-speaks");
  });
});
