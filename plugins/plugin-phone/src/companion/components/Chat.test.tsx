// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// agentUrl() reads import.meta.env; force the "no env fallback" case so the
// Chat status reflects only the paired-url prop unless overridden per test.
const agentUrlMock = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("../services", async () => {
  const actual =
    await vi.importActual<typeof import("../services")>("../services");
  return {
    ...actual,
    agentUrl: () => agentUrlMock.value,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

import { Chat } from "./Chat";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  agentUrlMock.value = null;
});

describe("Chat", () => {
  it("renders the paired + live state and fires the remote-session handler", () => {
    const onOpenPairing = vi.fn();
    const onOpenRemoteSession = vi.fn();
    render(
      <Chat
        pairedAgentUrl="wss://relay.example/input"
        remoteSessionAvailable
        onOpenPairing={onOpenPairing}
        onOpenRemoteSession={onOpenRemoteSession}
      />,
    );

    expect(screen.getByText("Paired")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("wss://relay.example/input")).toBeTruthy();
    // Paired -> the pairing button flips to "Re-pair".
    expect(screen.getByText("Re-pair")).toBeTruthy();

    const remoteButton = screen
      .getByText("Remote")
      .closest("button") as HTMLButtonElement;
    expect(remoteButton.disabled).toBe(false);
    fireEvent.click(remoteButton);
    expect(onOpenRemoteSession).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Re-pair").closest("button") as HTMLElement);
    expect(onOpenPairing).toHaveBeenCalledTimes(1);
  });

  it("renders the offline + idle state with a disabled Remote button", () => {
    const onOpenRemoteSession = vi.fn();
    render(
      <Chat
        pairedAgentUrl={null}
        remoteSessionAvailable={false}
        onOpenPairing={vi.fn()}
        onOpenRemoteSession={onOpenRemoteSession}
      />,
    );

    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(screen.getByText("No agent")).toBeTruthy();
    expect(screen.getByText("Pair")).toBeTruthy();

    const remoteButton = screen
      .getByText("Remote")
      .closest("button") as HTMLButtonElement;
    expect(remoteButton.disabled).toBe(true);
  });

  it("falls back to the configured env agent URL when not paired via prop", () => {
    agentUrlMock.value = "wss://configured.example/input";
    render(
      <Chat
        pairedAgentUrl={null}
        remoteSessionAvailable={false}
        onOpenPairing={vi.fn()}
        onOpenRemoteSession={vi.fn()}
      />,
    );
    // Env fallback resolves -> treated as paired for display purposes.
    expect(screen.getByText("Paired")).toBeTruthy();
    expect(screen.getByText("wss://configured.example/input")).toBeTruthy();
    expect(screen.getByText("Re-pair")).toBeTruthy();
  });
});
