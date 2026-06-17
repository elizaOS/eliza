// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

/**
 * Coverage for `src/components/AndroidVoicePill.tsx` and the native
 * `src/native/voice-capture.ts` shim it drives.
 *
 * Two device-free surfaces:
 *
 *   1. `<AndroidVoicePill>` — wires the shared `<VoicePill>` from `@elizaos/ui`
 *      to `useApp()` state. This suite asserts AndroidVoicePill's own logic
 *      (the seam it owns), not VoicePill's rendering, so `@elizaos/ui`'s
 *      voice-pill subpath is mocked with a faithful fake that exposes the
 *      contract AndroidVoicePill relies on: `messages` (projected), `onSubmit`
 *      (composer), `recording` (mic state), `onRecordingChange` (mic toggle).
 *      Asserts it mounts, projects `conversationMessages` (tail-capped,
 *      empty-skipped — `projectPillMessages`), forwards submits to
 *      `sendChatText` with the active conversation id, and maps the mic toggle
 *      to the native background-capture shim — including the graceful
 *      "native start denied" path where `recording` falls back to the value
 *      the shim resolves (AndroidVoicePill.tsx lines 84-95). `useApp` and the
 *      native shim are mocked.
 *
 *   2. `native/voice-capture.ts` — exercised with the REAL implementation and a
 *      mocked `@capacitor/core`. Confirms it degrades gracefully off Android:
 *      `startBackgroundVoiceCapture` resolves `false` (no throw, no plugin
 *      registration) and `stop`/`setMode` resolve as no-ops when
 *      `Capacitor.getPlatform()` is not "android" (voice-capture.ts lines
 *      26-32, 40-69).
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface VoicePillMessageLike {
  id: string;
  role: "agent" | "user";
  text: string;
}

interface VoicePillPropsLike {
  messages?: VoicePillMessageLike[];
  recording?: boolean;
  onRecordingChange?: (recording: boolean) => void;
  onSubmit?: (text: string) => void;
}

// --- useApp (app context) mock ---------------------------------------------
const appMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@elizaos/ui/state", () => ({ useApp: () => appMock.value }));

// --- VoicePill mock: faithful to the props AndroidVoicePill drives ---------
const { lastVoicePillProps } = vi.hoisted(() => ({
  lastVoicePillProps: { value: null as VoicePillPropsLike | null },
}));
vi.mock("@elizaos/ui/components/voice-pill", () => {
  const React = require("react") as typeof import("react");
  function VoicePill(props: VoicePillPropsLike) {
    lastVoicePillProps.value = props;
    return React.createElement(
      "div",
      { "data-testid": "voice-pill" },
      (props.messages ?? []).map((message) =>
        React.createElement(
          "div",
          { key: message.id, "data-testid": `pill-msg-${message.id}` },
          message.text,
        ),
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "pill-mic",
          "aria-pressed": String(Boolean(props.recording)),
          onClick: () => props.onRecordingChange?.(!props.recording),
        },
        "mic",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "pill-submit",
          onClick: () => props.onSubmit?.("ship it"),
        },
        "send",
      ),
    );
  }
  return { VoicePill };
});

// --- native voice-capture shim mock (component test only) ------------------
const { startCaptureMock, stopCaptureMock } = vi.hoisted(() => ({
  startCaptureMock: vi.fn(async () => true),
  stopCaptureMock: vi.fn(async () => undefined),
}));
vi.mock("../src/native/voice-capture", () => ({
  startBackgroundVoiceCapture: startCaptureMock,
  stopBackgroundVoiceCapture: stopCaptureMock,
}));

import { AndroidVoicePill } from "../src/components/AndroidVoicePill";

interface ConversationMessageLike {
  id: string;
  role: string;
  text?: string;
}

function makeApp(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    conversationMessages: [] as ConversationMessageLike[],
    activeConversationId: null,
    sendChatText: vi.fn(),
    ...overrides,
  };
}

describe("AndroidVoicePill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startCaptureMock.mockResolvedValue(true);
    stopCaptureMock.mockResolvedValue(undefined);
    lastVoicePillProps.value = null;
    appMock.value = makeApp();
  });

  afterEach(() => {
    cleanup();
  });

  it("mounts and renders the voice pill", () => {
    render(<AndroidVoicePill />);
    expect(screen.getByTestId("voice-pill")).toBeTruthy();
    expect(screen.getByTestId("pill-mic").getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("projects non-empty conversation messages into the pill, skipping blanks", () => {
    appMock.value = makeApp({
      conversationMessages: [
        { id: "1", role: "user", text: "hello there" },
        { id: "2", role: "assistant", text: "   " },
        { id: "3", role: "assistant", text: "hi back" },
      ],
    });
    render(<AndroidVoicePill />);

    const projected = lastVoicePillProps.value?.messages ?? [];
    expect(projected.map((m) => m.text)).toEqual(["hello there", "hi back"]);
    // role maps user → "user", everything else → "agent".
    expect(projected.map((m) => m.role)).toEqual(["user", "agent"]);
    expect(screen.getByTestId("pill-msg-1").textContent).toBe("hello there");
    expect(screen.queryByTestId("pill-msg-2")).toBeNull();
  });

  it("caps the projected messages at the pill tail length", () => {
    appMock.value = makeApp({
      conversationMessages: Array.from({ length: 30 }, (_, index) => ({
        id: String(index),
        role: index % 2 === 0 ? "user" : "assistant",
        text: `m${index}`,
      })),
    });
    render(<AndroidVoicePill />);

    const projected = lastVoicePillProps.value?.messages ?? [];
    expect(projected.length).toBe(20);
    // Tail-capped: keeps the most recent 20 (m10..m29).
    expect(projected[0]?.text).toBe("m10");
    expect(projected.at(-1)?.text).toBe("m29");
  });

  it("forwards composer submissions to sendChatText with the active conversation id", () => {
    const sendChatText = vi.fn();
    appMock.value = makeApp({ sendChatText, activeConversationId: "conv-42" });
    render(<AndroidVoicePill />);

    fireEvent.click(screen.getByTestId("pill-submit"));

    expect(sendChatText).toHaveBeenCalledTimes(1);
    expect(sendChatText).toHaveBeenCalledWith("ship it", {
      conversationId: "conv-42",
    });
  });

  it("starts native always-on capture and reflects the granted recording state", async () => {
    startCaptureMock.mockResolvedValue(true);
    render(<AndroidVoicePill />);

    fireEvent.click(screen.getByTestId("pill-mic"));

    expect(startCaptureMock).toHaveBeenCalledWith("always-on");
    await waitFor(() =>
      expect(screen.getByTestId("pill-mic").getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
  });

  it("falls back to not-recording when native capture is denied", async () => {
    // Shim resolves false (RECORD_AUDIO denied / not Android); the component
    // resets `recording` to the resolved value.
    startCaptureMock.mockResolvedValue(false);
    render(<AndroidVoicePill />);

    fireEvent.click(screen.getByTestId("pill-mic"));

    expect(startCaptureMock).toHaveBeenCalledWith("always-on");
    await waitFor(() =>
      expect(screen.getByTestId("pill-mic").getAttribute("aria-pressed")).toBe(
        "false",
      ),
    );
  });

  it("stops native capture when the mic is toggled off", async () => {
    startCaptureMock.mockResolvedValue(true);
    render(<AndroidVoicePill />);

    const mic = () => screen.getByTestId("pill-mic");
    fireEvent.click(mic());
    await waitFor(() =>
      expect(mic().getAttribute("aria-pressed")).toBe("true"),
    );

    fireEvent.click(mic());

    expect(stopCaptureMock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(mic().getAttribute("aria-pressed")).toBe("false"),
    );
  });
});

// Native shim degradation (the REAL voice-capture against a mocked Capacitor)
// lives in test/native-voice-capture.test.ts — it can't share this file
// because the suite above mocks the whole shim module.
