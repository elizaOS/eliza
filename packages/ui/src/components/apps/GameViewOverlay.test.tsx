// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameViewOverlay } from "./GameViewOverlay";

// The overlay reads everything it needs off the app store via a single
// `useAppSelectorShallow` call. We drive that store directly so each test can
// pin the exact viewer URL / auth payload / attachment state under test. The
// unit under test (the postMessage auth handshake effect) is NOT mocked.
const VIEWER_ORIGIN = "https://viewer.example.com";

type MutableAppState = {
  appRuns: Array<{ runId: string; viewer: unknown; viewerAttachment: string }>;
  activeGameRunId: string;
  activeGameDisplayName: string;
  activeGamePostMessageAuth: boolean;
  activeGamePostMessagePayload: unknown;
  activeGameViewerUrl: string;
  activeGameSandbox: string;
  setState: (key: string, value: unknown) => void;
  t: (key: string) => string;
};

const AUTH_PAYLOAD = {
  type: "GAME_AUTH",
  sessionToken: "s3cr3t-session",
  agentId: "agent-1",
} as const;

let appState: MutableAppState;

function baseState(overrides: Partial<MutableAppState> = {}): MutableAppState {
  return {
    appRuns: [
      {
        runId: "run-1",
        viewer: {
          url: `${VIEWER_ORIGIN}/game`,
          postMessageAuth: true,
        },
        viewerAttachment: "attached",
      },
    ],
    activeGameRunId: "run-1",
    activeGameDisplayName: "Test Game",
    activeGamePostMessageAuth: true,
    activeGamePostMessagePayload: { ...AUTH_PAYLOAD },
    activeGameViewerUrl: `${VIEWER_ORIGIN}/game`,
    activeGameSandbox: "allow-scripts",
    setState: vi.fn(),
    t: (key: string) => key,
    ...overrides,
  };
}

vi.mock("../../state", () => ({
  useApp: () => appState,
  useAppSelector: <T,>(selector: (s: MutableAppState) => T): T =>
    selector(appState),
  useAppSelectorShallow: <T,>(selector: (s: MutableAppState) => T): T =>
    selector(appState),
}));

function getIframeWindow(): Window {
  const iframe = screen.getByTestId(
    "game-view-overlay-iframe",
  ) as HTMLIFrameElement;
  const win = iframe.contentWindow;
  if (!win) throw new Error("iframe contentWindow missing in jsdom");
  return win;
}

function readyMessage(
  source: MessageEventSource | null,
  origin: string,
  type = "GAME_READY",
): MessageEvent {
  return new MessageEvent("message", {
    data: { type },
    origin,
    source,
  });
}

beforeEach(() => {
  appState = baseState();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GameViewOverlay postMessage auth handshake", () => {
  it("posts the auth payload to the concrete viewer origin after a valid ready message", () => {
    render(<GameViewOverlay />);
    const iframeWindow = getIframeWindow();
    const postSpy = vi.spyOn(iframeWindow, "postMessage");

    window.dispatchEvent(readyMessage(iframeWindow, VIEWER_ORIGIN));

    expect(postSpy).toHaveBeenCalledTimes(1);
    // Exact payload AND exact targetOrigin — never a wildcard.
    expect(postSpy).toHaveBeenCalledWith(
      { type: "GAME_AUTH", sessionToken: "s3cr3t-session", agentId: "agent-1" },
      VIEWER_ORIGIN,
    );
  });

  it("rejects a ready message from a spoofed origin (no auth leak)", () => {
    render(<GameViewOverlay />);
    const iframeWindow = getIframeWindow();
    const postSpy = vi.spyOn(iframeWindow, "postMessage");

    // Correct source window, but an attacker-controlled origin.
    window.dispatchEvent(
      readyMessage(iframeWindow, "https://evil.example.com"),
    );

    expect(postSpy).not.toHaveBeenCalled();
  });

  it("rejects a ready message from a spoofed source window", () => {
    render(<GameViewOverlay />);
    const iframeWindow = getIframeWindow();
    const postSpy = vi.spyOn(iframeWindow, "postMessage");

    // Correct origin, but the event claims to come from the top window
    // rather than the trusted iframe contentWindow.
    window.dispatchEvent(readyMessage(window, VIEWER_ORIGIN));

    expect(postSpy).not.toHaveBeenCalled();
  });

  it("ignores messages whose type is not the expected *_READY event", () => {
    render(<GameViewOverlay />);
    const iframeWindow = getIframeWindow();
    const postSpy = vi.spyOn(iframeWindow, "postMessage");

    window.dispatchEvent(
      readyMessage(iframeWindow, VIEWER_ORIGIN, "SOMETHING_ELSE"),
    );

    expect(postSpy).not.toHaveBeenCalled();
  });

  it("fails closed: never sends auth when the viewer URL has no concrete http(s) origin", () => {
    appState = baseState({
      activeGameViewerUrl: "about:blank",
      appRuns: [
        {
          runId: "run-1",
          viewer: { url: "about:blank", postMessageAuth: true },
          viewerAttachment: "attached",
        },
      ],
    });
    render(<GameViewOverlay />);
    const iframeWindow = getIframeWindow();
    const postSpy = vi.spyOn(iframeWindow, "postMessage");

    // Even a structurally valid ready message must be ignored: with no
    // resolvable target origin the handshake listener is never installed.
    window.dispatchEvent(readyMessage(iframeWindow, "null"));
    window.dispatchEvent(readyMessage(iframeWindow, VIEWER_ORIGIN));

    expect(postSpy).not.toHaveBeenCalled();
  });

  it("sends auth exactly once across repeated ready messages (one-shot guard)", () => {
    render(<GameViewOverlay />);
    const iframeWindow = getIframeWindow();
    const postSpy = vi.spyOn(iframeWindow, "postMessage");

    // Rapid-fire duplicate ready events (iframe reload storm / double emit).
    window.dispatchEvent(readyMessage(iframeWindow, VIEWER_ORIGIN));
    window.dispatchEvent(readyMessage(iframeWindow, VIEWER_ORIGIN));
    window.dispatchEvent(readyMessage(iframeWindow, VIEWER_ORIGIN));

    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it("does not render (or send auth) while the run viewer is detached", () => {
    appState = baseState({
      appRuns: [
        {
          runId: "run-1",
          viewer: { url: `${VIEWER_ORIGIN}/game`, postMessageAuth: true },
          viewerAttachment: "detached",
        },
      ],
    });
    render(<GameViewOverlay />);

    expect(screen.queryByTestId("game-view-overlay-iframe")).toBeNull();
  });
});
