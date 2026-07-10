// @vitest-environment jsdom
//
// Core behavior of the floating chat overlay: the mic ↔ send composer swap,
// draft persistence, thread rendering, back-intent/prefill events, and the
// press-and-hold copy gesture. Renders the real overlay in jsdom with the API
// client + clipboard mocked (no network).

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  ChatComposerCtx,
  clearChatDraft,
  readChatDraft,
  useChatComposerDraftPersistence,
  writeChatDraft,
} from "../../state/ChatComposerContext.hooks";

// The resting overlay's suggestion strip fetches model suggestions via the
// shared client; stub it so the strip stays on its static fallback in tests.
vi.mock("../../api/client", () => ({
  client: {
    fetch: vi.fn().mockRejectedValue(new Error("no api in test")),
    // Transcription archival is best-effort and fire-and-forget; resolve so the
    // attachment path (the user-facing behavior) is what the test asserts.
    createTranscript: vi
      .fn()
      .mockResolvedValue({ transcript: { id: "t1", title: "Transcript" } }),
    // The header search control drives the real client method; per-test the
    // resolved value is the real `GET /api/conversations/messages/search`
    // response shape so the query→results→jump path is exercised end to end.
    searchConversationMessages: vi.fn(),
  },
}));

// The press-and-hold copy path writes to the clipboard; stub it so the gesture
// is assertable (and never throws "Clipboard API unavailable" in jsdom).
vi.mock("../../utils/clipboard", () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../chat/report-composer-activity", () => ({
  reportComposerActivity: vi.fn(),
}));

import * as React from "react";
import { client } from "../../api/client";
import type {
  Conversation,
  ConversationMessage,
  ConversationMessageSearchResult,
  ImageAttachment,
} from "../../api/client-types-chat";
import { reportComposerActivity } from "../../chat/report-composer-activity";
import { CHAT_PREFILL_EVENT, ELIZA_BACK_INTENT_EVENT } from "../../events";
import {
  LAYOUT_SHIFT_INTENT_ATTR,
  LAYOUT_SHIFT_INTENT_TRANSIENT,
} from "../../hooks/useLayoutShiftMonitor";
import { __resetAssistantLaunchPayloadClaimsForTests } from "../../platform/assistant-launch-payload";
import { __setAppValueForTests } from "../../state/app-store";
import {
  getShellSurface,
  resetShellSurfaceForTests,
} from "../../state/shell-surface-store";
import {
  applyStreamingTextModification,
  type StreamingTextSetter,
} from "../../state/useStreamingText";
import { setViewChatBinding } from "../../state/view-chat-binding";
import { copyTextToClipboard } from "../../utils/clipboard";
import { ContinuousChatOverlay } from "./ContinuousChatOverlay";
import type { ShellMessage } from "./shell-state";
import {
  buildConversationNav,
  type ShellController,
} from "./useShellController";

beforeAll(() => {
  // jsdom has no scrollIntoView; the overlay calls it when the thread grows.
  Element.prototype.scrollIntoView = vi.fn();
});

// Unmount between tests so renders don't accumulate in the shared document.
afterEach(() => {
  cleanup();
  resetShellSurfaceForTests();
  setViewChatBinding(null);
  vi.mocked(reportComposerActivity).mockClear();
  vi.mocked(client.searchConversationMessages).mockReset();
  vi.mocked(Element.prototype.scrollIntoView).mockClear();
  document.getElementById("chat-message-m-hit")?.remove();
  // Search-jump tests seed the AppContext store with spies; clear it so the
  // inert test-fallback proxy backs every other test again.
  __setAppValueForTests(null);
});

function makeController(
  overrides: Partial<ShellController> = {},
): ShellController {
  return {
    phase: "summoned",
    messages: [
      { id: "a", role: "assistant", content: "hi there", createdAt: 1 },
      // whitespace-only → should be filtered out of the rendered thread
      { id: "b", role: "user", content: "   ", createdAt: 2 },
    ],
    canSend: true,
    responding: false,
    turnStatus: null,
    recording: false,
    transcript: "",
    transcriptionMode: false,
    // Required ShellController surface the overlay reads unconditionally — the
    // real controller always supplies these, so the mock must too.
    modelStatus: { kind: "ready" },
    send: vi.fn(),
    stop: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    toggleRecording: vi.fn(),
    handsFree: false,
    toggleHandsFree: vi.fn(),
    toggleTranscriptionMode: vi.fn(),
    // A mic tap while transcribing routes through this master voice control.
    stopTranscriptionAndMic: vi.fn(),
    setDictationSink: vi.fn(),
    setTranscriptSessionSink: vi.fn(),
    setComposerHasDraft: vi.fn(),
    clearConversation: vi.fn(),
    ...overrides,
  } as unknown as ShellController;
}

/**
 * The app composition seam around the overlay, reproduced minimally: the
 * shared ChatComposerContext slot (real state), the app-level
 * useChatComposerDraftPersistence instance AppContext runs, and a
 * selectConversation that performs useChatCallbacks.handleSelectConversation's
 * flush/restore handoff — the path the overlay's conversation swipe routes
 * through in the real app. `selectRef` hands the select function to the test.
 */
function AppComposerHarness({
  initialActiveId,
  selectRef,
}: {
  initialActiveId: string;
  selectRef: { current: ((id: string) => void) | null };
}) {
  const [activeId, setActiveId] = React.useState(initialActiveId);
  const [chatInput, setChatInput] = React.useState("");
  const [chatPendingImages, setChatPendingImages] = React.useState<
    ImageAttachment[]
  >([]);
  const chatInputRef = React.useRef(chatInput);
  chatInputRef.current = chatInput;
  useChatComposerDraftPersistence({
    activeConversationId: activeId,
    chatInput,
    setChatInput,
  });
  selectRef.current = (id: string) => {
    // Mirrors useChatCallbacks.handleSelectConversation: flush the leaving
    // conversation's in-progress text under ITS OWN key, then repaint the
    // target's saved draft (or clear when it has none).
    writeChatDraft(activeId, chatInputRef.current);
    setChatInput(readChatDraft(id) ?? "");
    setActiveId(id);
  };
  const composerValue = React.useMemo(
    () => ({
      chatInput,
      chatSending: false,
      chatPendingImages,
      chatReplyTarget: null,
      setChatInput,
      setChatPendingImages,
      setChatReplyTarget: () => {},
    }),
    [chatInput, chatPendingImages],
  );
  const controller = React.useMemo(
    () =>
      makeController({
        conversationNav: {
          hasPrev: false,
          hasNext: false,
          goPrev: () => {},
          goNext: () => {},
          activeId,
          index: 0,
        },
      } as unknown as Partial<ShellController>),
    [activeId],
  );
  return (
    <ChatComposerCtx.Provider value={composerValue}>
      <span data-testid="harness-chat-input" hidden>
        {chatInput}
      </span>
      <ContinuousChatOverlay controller={controller} />
    </ChatComposerCtx.Provider>
  );
}

describe("ContinuousChatOverlay", () => {
  it("shows the mic and no send button when the draft is empty", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    expect(screen.getByLabelText("talk")).toBeTruthy();
    expect(screen.queryByLabelText("send")).toBeNull();
  });

  it("swaps mic → send once the user types (ChatGPT-style)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "hello" },
    });
    expect(screen.getByLabelText("send")).toBeTruthy();
    expect(screen.queryByLabelText("talk")).toBeNull();
  });

  it("reports typing start and pause from the real composer draft", () => {
    vi.useFakeTimers();
    try {
      render(<ContinuousChatOverlay controller={makeController()} />);
      fireEvent.change(screen.getByLabelText("message"), {
        target: { value: "hello" },
      });

      expect(reportComposerActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          activity: "typing_started",
          surface: "continuous_chat_overlay",
          draftLength: 5,
        }),
      );
      expect(reportComposerActivity).not.toHaveBeenCalledWith(
        expect.objectContaining({ activity: "typing_paused" }),
      );

      act(() => {
        vi.advanceTimersByTime(1_999);
      });
      expect(reportComposerActivity).not.toHaveBeenCalledWith(
        expect.objectContaining({ activity: "typing_paused" }),
      );

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(reportComposerActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          activity: "typing_paused",
          surface: "continuous_chat_overlay",
          draftLength: 5,
          idleForMs: 2_000,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports draft_abandoned only when the user clears typed text", () => {
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} />);
    const input = screen.getByLabelText("message");

    fireEvent.change(input, { target: { value: "discard me" } });
    fireEvent.change(input, { target: { value: "" } });

    expect(reportComposerActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        activity: "draft_abandoned",
        surface: "continuous_chat_overlay",
        draftLength: 0,
        reason: "cleared",
      }),
    );

    vi.mocked(reportComposerActivity).mockClear();
    fireEvent.change(input, { target: { value: "send me" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(controller.send).toHaveBeenCalledWith("send me");
    expect(reportComposerActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({ activity: "draft_abandoned" }),
    );
  });

  it("shows a disabled, no-op send control when the agent can't accept input (canSend false)", () => {
    const controller = makeController({ canSend: false });
    render(<ContinuousChatOverlay controller={controller} />);
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "hello" },
    });
    // The control still swaps to send, but is labelled + guarded as unavailable
    // (aria-disabled keeps it focusable/announceable; the click is a no-op).
    const send = screen.getByLabelText("send (agent stopped)");
    expect(send.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(send);
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("swaps send → mic again once the draft is cleared", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message");
    fireEvent.change(input, { target: { value: "hello" } });
    expect(screen.getByLabelText("send")).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByLabelText("talk")).toBeTruthy();
    expect(screen.queryByLabelText("send")).toBeNull();
  });

  it("submits the draft on Enter, calls send(), and clears the input", () => {
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} />);
    const input = screen.getByLabelText("message") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ping" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(vi.mocked(controller.send).mock.calls[0]?.[0]).toBe("ping");
    expect(input.value).toBe("");
  });

  it("does NOT send on the Enter that commits an IME composition (CJK), only a real Enter", () => {
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} />);
    const input = screen.getByLabelText("message") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "にほんご" } });

    // Enter while an IME candidate is being committed: `isComposing` is set
    // (legacy engines report keyCode 229). This Enter accepts the candidate and
    // MUST NOT submit the half-composed line.
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(controller.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(controller.send).not.toHaveBeenCalled();
    // The draft survives — the premature send never cleared it.
    expect(input.value).toBe("にほんご");

    // A normal Enter (composition finished) sends as usual.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(vi.mocked(controller.send).mock.calls[0]?.[0]).toBe("にほんご");
  });

  it("prefills and focuses the composer from the shared chat prefill event", async () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message") as HTMLInputElement;

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(CHAT_PREFILL_EVENT, {
          detail: { text: "Show my agent workspace status.", select: true },
        }),
      );
    });

    expect(input.value).toBe("Show my agent workspace status.");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it("cancels pending prefill focus work on unmount", () => {
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 42);
    const cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    try {
      const { unmount } = render(
        <ContinuousChatOverlay controller={makeController()} />,
      );
      requestFrame.mockClear();
      cancelFrame.mockClear();

      act(() => {
        window.dispatchEvent(
          new CustomEvent(CHAT_PREFILL_EVENT, {
            detail: {
              text: "Show my agent workspace status.",
              select: true,
            },
          }),
        );
      });

      expect(requestFrame).toHaveBeenCalled();
      const prefillFrameId =
        requestFrame.mock.results[requestFrame.mock.results.length - 1]?.value;
      unmount();
      expect(cancelFrame).toHaveBeenCalledWith(prefillFrameId);
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("opens the sheet when the composer input is focused (type-to-open)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("flips the overlay to data-open when the composer textarea is focused (the ui-smoke contract)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const overlay = screen.getByTestId("continuous-chat-overlay");
    expect(overlay.getAttribute("data-open")).toBeNull();
    fireEvent.focus(screen.getByTestId("chat-composer-textarea"));
    expect(overlay.getAttribute("data-open")).toBe("true");
  });

  it("opens the sheet when the thread lands AFTER the composer was focused (focus wins the boot race, #11112)", () => {
    // Boot: the overlay renders (and can be focused) before the restored
    // conversation's messages arrive. The focus→expand used to be a one-shot
    // no-op with nothing revealable, so data-open never flipped.
    const { rerender } = render(
      <ContinuousChatOverlay controller={makeController({ messages: [] })} />,
    );
    const overlay = screen.getByTestId("continuous-chat-overlay");
    const composer = screen.getByTestId("chat-composer-textarea");
    act(() => {
      composer.focus();
    });
    // Nothing to reveal yet — focusing the bare input must not open an empty sheet.
    expect(overlay.getAttribute("data-open")).toBeNull();

    // The restored conversation's messages land while the composer is still
    // focused: the parked focus-open intent completes the open.
    rerender(<ContinuousChatOverlay controller={makeController()} />);
    expect(overlay.getAttribute("data-open")).toBe("true");
  });

  it("drops the parked focus-open intent if the composer blurred before the thread arrived", () => {
    const { rerender } = render(
      <ContinuousChatOverlay controller={makeController({ messages: [] })} />,
    );
    const overlay = screen.getByTestId("continuous-chat-overlay");
    const composer = screen.getByTestId("chat-composer-textarea");
    act(() => {
      composer.focus();
      composer.blur();
    });

    // The thread arriving later must NOT pop the sheet open — the user left.
    rerender(<ContinuousChatOverlay controller={makeController()} />);
    expect(overlay.getAttribute("data-open")).toBeNull();
  });

  it("does not move the overlay bottom padding just because the composer is focused", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const overlay = screen.getByTestId("continuous-chat-overlay");
    const initialPadding = overlay.style.paddingBottom;

    fireEvent.focus(screen.getByLabelText("message"));

    expect(screen.getByTestId("chat-sheet").getAttribute("data-variant")).toBe(
      "open",
    );
    expect(overlay.style.paddingBottom).toBe(initialPadding);
  });

  it("seats the resting composer above the home indicator: full gesture inset plus a small gap", () => {
    // Lock-screen anchoring: with the overlay reclaimed to the true physical
    // bottom (device r8, screen.height reclaim), the resting composer clears the
    // whole home-indicator/Android gesture inset plus a SMALL visual gap
    // (~34px + 8px on iOS). The gap was trimmed 0.625rem → 0.5rem (device r8:
    // "bottom has excess padding") so the composer sits one finger above the
    // indicator, not floating in a dead band, no longer the old 40% inset
    // compensation that was tuned around the collapsed-ICB float.
    render(<ContinuousChatOverlay controller={makeController()} />);
    const overlay = screen.getByTestId("continuous-chat-overlay");
    expect(overlay.style.paddingBottom).toBe(
      "calc(var(--eliza-mobile-nav-offset, 0px) + max(var(--safe-area-bottom, 0px), var(--android-gesture-inset-bottom, 0px)) + 0.5rem)",
    );
  });

  it("publishes side clearance for the compact short-landscape composer", () => {
    const originalInnerWidth = Object.getOwnPropertyDescriptor(
      window,
      "innerWidth",
    );
    const originalInnerHeight = Object.getOwnPropertyDescriptor(
      window,
      "innerHeight",
    );
    const originalResizeObserver = globalThis.ResizeObserver;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    class TestResizeObserver {
      observe = vi.fn();
      disconnect = vi.fn();
    }

    try {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 800,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 390,
      });
      vi.stubGlobal("ResizeObserver", TestResizeObserver);
      rectSpy.mockReturnValue({
        width: 208,
        height: 72,
        x: 0,
        y: 0,
        top: 0,
        right: 208,
        bottom: 72,
        left: 0,
        toJSON: () => ({}),
      } as DOMRect);
      document.documentElement.style.removeProperty(
        "--eliza-continuous-chat-side-clearance",
      );

      render(
        <ContinuousChatOverlay
          controller={makeController()}
          agentName="Playwright Smoke"
        />,
      );

      expect(screen.getByLabelText("message").getAttribute("placeholder")).toBe(
        "Ask",
      );

      expect(
        document.documentElement.style.getPropertyValue(
          "--eliza-continuous-chat-side-clearance",
        ),
      ).toBe("232px");

      fireEvent.focus(screen.getByLabelText("message"));

      expect(screen.getByLabelText("message").getAttribute("placeholder")).toBe(
        "Ask Playwright Smoke",
      );

      expect(
        document.documentElement.style.getPropertyValue(
          "--eliza-continuous-chat-side-clearance",
        ),
      ).toBe("0px");
    } finally {
      rectSpy.mockRestore();
      if (originalInnerWidth) {
        Object.defineProperty(window, "innerWidth", originalInnerWidth);
      }
      if (originalInnerHeight) {
        Object.defineProperty(window, "innerHeight", originalInnerHeight);
      }
      vi.stubGlobal("ResizeObserver", originalResizeObserver);
      document.documentElement.style.removeProperty(
        "--eliza-continuous-chat-side-clearance",
      );
    }
  });

  it("renders NO cosmetic bottom-floor strip under the composer (wallpaper owns the zone)", () => {
    // The old continuous-chat-bottom-floor painted a --launch-bg gradient over
    // the strip below the composer; with the app shell painting that zone
    // (wallpaper on shared-background routes), the repaint band WAS the
    // residual visible gap on the standalone home view. It must stay gone.
    render(<ContinuousChatOverlay controller={makeController()} />);
    expect(screen.queryByTestId("continuous-chat-bottom-floor")).toBeNull();
  });

  it("blurs the focused composer when the active view leaves chat (drops the iOS accessory bar)", () => {
    const { rerender } = render(
      <ContinuousChatOverlay
        controller={makeController({
          currentTab: "chat",
        } as Partial<ShellController>)}
      />,
    );
    const composer = screen.getByLabelText("message");
    act(() => {
      composer.focus();
    });
    expect(document.activeElement).toBe(composer);

    // Navigate to a non-chat view. The overlay floats over every view, so
    // without an explicit blur the textarea keeps DOM focus on Settings and iOS
    // strands the keyboard input-accessory bar (the ‹ › chevrons + "Done").
    rerender(
      <ContinuousChatOverlay
        controller={makeController({
          currentTab: "settings",
        } as Partial<ShellController>)}
      />,
    );
    expect(document.activeElement).not.toBe(composer);
  });

  it("keeps composer focus when the active view stays on chat (no spurious blur)", () => {
    const { rerender } = render(
      <ContinuousChatOverlay
        controller={makeController({
          currentTab: "chat",
        } as Partial<ShellController>)}
      />,
    );
    const composer = screen.getByLabelText("message");
    act(() => {
      composer.focus();
    });
    // A re-render that does not change the active view must not steal focus.
    rerender(
      <ContinuousChatOverlay
        controller={makeController({
          currentTab: "chat",
        } as Partial<ShellController>)}
      />,
    );
    expect(document.activeElement).toBe(composer);
  });

  it("does not route soft-keyboard visualViewport resize through the drag-settle handler", () => {
    const originalVisualViewport = window.visualViewport;
    const fakeVisualViewport = {
      height: 700,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: fakeVisualViewport as unknown as VisualViewport,
    });
    const windowAdd = vi.spyOn(window, "addEventListener");
    try {
      render(<ContinuousChatOverlay controller={makeController()} />);

      const windowResizeHandler = windowAdd.mock.calls.find(
        ([type]) => type === "resize",
      )?.[1];
      const visualResizeHandler =
        fakeVisualViewport.addEventListener.mock.calls.find(
          ([type]) => type === "resize",
        )?.[1];
      const visualScrollHandler =
        fakeVisualViewport.addEventListener.mock.calls.find(
          ([type]) => type === "scroll",
        )?.[1];

      expect(typeof windowResizeHandler).toBe("function");
      expect(typeof visualResizeHandler).toBe("function");
      expect(typeof visualScrollHandler).toBe("function");
      expect(visualResizeHandler).toBe(visualScrollHandler);
      expect(visualResizeHandler).not.toBe(windowResizeHandler);
    } finally {
      windowAdd.mockRestore();
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: originalVisualViewport,
      });
    }
  });

  it("opens the sheet on a pull-up drag of the grabber", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    // A deliberate upward drag past the distance threshold opens it.
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("spans a WIDE swipe-up grab zone across the composer top edge", () => {
    // Lock-screen affordance: the grabber's hit zone must reach across the
    // composer's width (inset-x-6, not a narrow centred px-16 stub) so a
    // swipe-up begun anywhere near the bottom opens the chat — while still
    // floating above the input row so it never eats taps meant for the
    // textarea.
    render(<ContinuousChatOverlay controller={makeController()} />);
    const grabber = screen.getByTestId("chat-sheet-grabber");
    expect(grabber.className).toContain("inset-x-6");
    expect(grabber.className).not.toContain("px-16");
    // The zone stops at the handle's own bottom (before:bottom-0) so it can't
    // overlap the interactive composer controls beneath it.
    expect(grabber.className).toContain("before:bottom-0");
  });

  // #14331: the overlay mic must pulse whenever a live capture is hot, so its
  // motion agrees with the accent color (previously it only recolored, never
  // pulsed, while every sibling surface pulsed). Reduced-motion falls back to the
  // static accent. The pill/grabber pulse already shipped; pin it here.
  describe("mic + pill pulse while capture is hot (#14331)", () => {
    it("does not pulse the mic while idle (neutral resting, no motion)", () => {
      render(<ContinuousChatOverlay controller={makeController()} />);
      const mic = screen.getByTestId("chat-composer-mic");
      expect(mic.className).not.toContain("animate-pulse");
      expect(mic.className).not.toContain("text-accent");
    });

    it.each([
      ["recording", { recording: true }],
      ["hands-free", { handsFree: true }],
      ["transcribing", { transcriptionMode: true }],
    ] as const)("pulses the accent mic while %s", (_label, override) => {
      render(<ContinuousChatOverlay controller={makeController(override)} />);
      const mic = screen.getByTestId("chat-composer-mic");
      expect(mic.className).toContain("animate-pulse");
      expect(mic.className).toContain("motion-reduce:animate-none");
      expect(mic.className).toContain("text-accent");
    });

    it("drops the pulse the moment the capture predicate clears", () => {
      const { rerender } = render(
        <ContinuousChatOverlay
          controller={makeController({ recording: true })}
        />,
      );
      expect(screen.getByTestId("chat-composer-mic").className).toContain(
        "animate-pulse",
      );
      rerender(
        <ContinuousChatOverlay
          controller={makeController({ recording: false })}
        />,
      );
      expect(screen.getByTestId("chat-composer-mic").className).not.toContain(
        "animate-pulse",
      );
    });

    it("pulses the collapsed pill bar only while listening (regression guard)", () => {
      const { rerender } = render(
        <ContinuousChatOverlay controller={makeController()} />,
      );
      const sheet = screen.getByTestId("chat-sheet");
      const spanOf = () =>
        screen.getByTestId("chat-pill").querySelector("span");
      const barOf = () => spanOf()?.className ?? "";
      expect(barOf()).not.toContain("animate-pulse");
      // Resting bar color is an explicit light warm-white inline style (not the
      // `bg-muted-strong` token, which resolved dark/black on the grabber that
      // renders outside the panel theme) — kept identical to the grabber bar.
      expect(spanOf()?.style.backgroundColor).toBe("rgba(255, 247, 240, 0.86)");
      rerender(
        <ContinuousChatOverlay
          controller={makeController({ phase: "listening", recording: true })}
        />,
      );
      const grabber = screen.getByTestId("chat-sheet-grabber");
      fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
      fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
      fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
      expect(sheet.getAttribute("data-detent")).toBe("pill");
      expect(barOf()).toContain("animate-pulse");
      expect(barOf()).toContain("bg-accent");
      expect(barOf()).toContain("motion-reduce:animate-none");
    });
  });

  it("toggles the sheet open and closed on repeated grabber taps", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(sheet.getAttribute("data-detent")).toBe("collapsed");

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
  });

  it("opens a loading conversation on the first grabber tap", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [],
          conversationLoading: true,
        })}
      />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(sheet.getAttribute("data-detent")).toBe("collapsed");

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");
    expect(screen.getByTestId("chat-thread-loading")).toBeTruthy();

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
  });

  it("routes a horizontal swipe on the collapsed grabber to the launcher rail instead of opening chat", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(getShellSurface().page).toBe("home");
    expect(sheet.getAttribute("data-variant")).toBe("closed");

    fireEvent.pointerDown(grabber, {
      clientX: 260,
      clientY: 420,
      pointerId: 1,
    });
    fireEvent.pointerMove(grabber, {
      clientX: 120,
      clientY: 414,
      pointerId: 1,
    });
    fireEvent.pointerUp(grabber, {
      clientX: 120,
      clientY: 414,
      pointerId: 1,
    });

    expect(getShellSurface().page).toBe("launcher");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("dismisses the OPEN sheet to the pill on a horizontal swipe (left), never navigating", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    // Open the sheet first (tap → half detent).
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");

    // Drag the open chat sideways → dismiss to the pill (the put-the-chat-away
    // landing) — NOT the home↔launcher rail nav the collapsed swipe means.
    fireEvent.pointerDown(grabber, {
      clientX: 260,
      clientY: 200,
      pointerId: 2,
    });
    fireEvent.pointerMove(grabber, {
      clientX: 120,
      clientY: 206,
      pointerId: 2,
    });
    fireEvent.pointerUp(grabber, {
      clientX: 120,
      clientY: 206,
      pointerId: 2,
    });

    expect(sheet.getAttribute("data-detent")).toBe("pill");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(getShellSurface().page).toBe("home");
  });

  it("dismisses the OPEN sheet to the pill on a horizontal swipe (right) too", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");

    fireEvent.pointerDown(grabber, {
      clientX: 120,
      clientY: 200,
      pointerId: 2,
    });
    fireEvent.pointerMove(grabber, {
      clientX: 280,
      clientY: 206,
      pointerId: 2,
    });
    fireEvent.pointerUp(grabber, {
      clientX: 280,
      clientY: 206,
      pointerId: 2,
    });

    expect(sheet.getAttribute("data-detent")).toBe("pill");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(getShellSurface().page).toBe("home");
  });

  it("routes a grabber flick whose moves were coalesced into the release to the launcher (#9943)", () => {
    // REAL touch on a janked Android WebView delivers pointerdown → pointerup
    // with the whole travel between them (every pointermove coalesced away).
    // The swipe must still commit from the release deltas.
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(getShellSurface().page).toBe("home");

    fireEvent.pointerDown(grabber, {
      clientX: 260,
      clientY: 420,
      pointerId: 1,
    });
    fireEvent.pointerUp(grabber, {
      clientX: 110,
      clientY: 414,
      pointerId: 1,
    });

    expect(getShellSurface().page).toBe("launcher");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("routes a grabber flick that ends in pointercancel after crossing the threshold to the launcher (#9943)", () => {
    // Android's touch pipeline can revoke the pointer AFTER the finger already
    // completed the swipe (renderer-unresponsive ack timeout) — the observed
    // track must commit instead of being discarded.
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(getShellSurface().page).toBe("home");

    fireEvent.pointerDown(grabber, {
      clientX: 260,
      clientY: 420,
      pointerId: 1,
    });
    fireEvent.pointerMove(grabber, {
      clientX: 110,
      clientY: 414,
      pointerId: 1,
    });
    fireEvent.pointerCancel(grabber, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });

    expect(getShellSurface().page).toBe("launcher");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  // Regression guard for #9142: the grabber bar was hardcoded `opacity-0`
  // unconditionally, so on desktop/web (no OS home indicator) the handle was
  // grabbable but the bar never painted. It must be visible off-iOS.
  it("paints a visible grabber bar off-iOS (sheet grabber + pill)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    // The test runtime resolves the Capacitor platform to "web", so isIOS is
    // false and both bars must render visibly (opacity-100, not opacity-0).
    const grabberBar = screen
      .getByTestId("chat-sheet-grabber")
      .querySelector("span[aria-hidden='true']");
    expect(grabberBar).toBeTruthy();
    expect(grabberBar?.className).toContain("opacity-100");
    expect(grabberBar?.className).not.toContain("opacity-0");

    const pillBar = screen
      .getByTestId("chat-pill")
      .querySelector("span[aria-hidden='true']");
    expect(pillBar).toBeTruthy();
    expect(pillBar?.className).toContain("opacity-100");
    expect(pillBar?.className).not.toContain("opacity-0");
  });

  it("steps COLLAPSED→HALF→FULL on successive pull-ups and back down again", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    const pull = (fromY: number, toY: number) => {
      fireEvent.pointerDown(grabber, { clientY: fromY, pointerId: 1 });
      fireEvent.pointerMove(grabber, { clientY: toY, pointerId: 1 });
      fireEvent.pointerUp(grabber, { clientY: toY, pointerId: 1 });
    };
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    pull(420, 280); // up → HALF (one step, not straight to full)
    expect(sheet.getAttribute("data-detent")).toBe("half");
    pull(420, 280); // up → FULL
    expect(sheet.getAttribute("data-detent")).toBe("full");
    pull(280, 420); // down → HALF
    expect(sheet.getAttribute("data-detent")).toBe("half");
    pull(280, 420); // down → COLLAPSED
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
  });

  it("lands full when a collapsed drag is released above the half threshold", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    fireEvent.pointerDown(grabber, { clientY: 700, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 80, pointerId: 1 });

    expect(sheet.getAttribute("data-detent")).toBe("full");
  });

  it("opens on a fast flick even below the distance threshold (velocity)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    // 15px travel (< 56px distance threshold) but synchronous → high velocity.
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 405, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 405, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");
  });

  it("springs back to the input when a slow downward drift stays above the pill threshold", () => {
    const now = vi.spyOn(performance, "now");
    // Changed-file coverage runs this test without the package setup that
    // bridges DOM event timestamps to the mocked monotonic clock.
    const eventTimeStamp = vi
      .spyOn(Event.prototype, "timeStamp", "get")
      .mockImplementation(() => performance.now() || Number.MIN_VALUE);
    try {
      render(<ContinuousChatOverlay controller={makeController()} />);
      const sheet = screen.getByTestId("chat-sheet");
      const grabber = screen.getByTestId("chat-sheet-grabber");

      expect(sheet.getAttribute("data-detent")).toBe("collapsed");
      now.mockReturnValue(0);
      fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
      fireEvent.pointerMove(grabber, { clientY: 450, pointerId: 1 });
      now.mockReturnValue(800);
      fireEvent.pointerUp(grabber, { clientY: 450, pointerId: 1 });

      expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    } finally {
      eventTimeStamp.mockRestore();
      now.mockRestore();
    }
  });

  it("collapses to the pill when a slow downward drag crosses the pill threshold", () => {
    const now = vi.spyOn(performance, "now");
    try {
      render(<ContinuousChatOverlay controller={makeController()} />);
      const sheet = screen.getByTestId("chat-sheet");
      const grabber = screen.getByTestId("chat-sheet-grabber");

      expect(sheet.getAttribute("data-detent")).toBe("collapsed");
      now.mockReturnValue(0);
      fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
      fireEvent.pointerMove(grabber, { clientY: 500, pointerId: 1 });
      now.mockReturnValue(800);
      fireEvent.pointerUp(grabber, { clientY: 500, pointerId: 1 });

      expect(sheet.getAttribute("data-detent")).toBe("pill");
    } finally {
      now.mockRestore();
    }
  });

  it("opens to HALF when sending (conversation above the keyboard, not a full-screen takeover)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const input = screen.getByLabelText("message");
    fireEvent.change(input, { target: { value: "ping" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sheet.getAttribute("data-detent")).toBe("half");
  });

  it("exposes the mic control with a stable test id at rest", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    expect(screen.getByTestId("chat-composer-mic")).toBeTruthy();
  });

  it("renders composer controls icon-only — no capsule/border/fill, accent when active (#10711)", () => {
    // Resting: the +, transcribe, and voice controls carry only the icon — no
    // round capsule, no border, no translucent white fill. The visible box is
    // 40px with a 20px mark (the "icons slightly too big" fix); the invisible
    // before-overlay pads the pointer target back out to 44×44 (WCAG 2.5.5).
    const { unmount } = render(
      <ContinuousChatOverlay controller={makeController()} />,
    );
    for (const id of [
      "chat-composer-plus",
      "chat-composer-transcribe",
      "chat-composer-mic",
    ]) {
      const cls = screen.getByTestId(id).className;
      expect(cls).not.toMatch(/rounded-full/);
      expect(cls).not.toMatch(/\bborder\b/);
      expect(cls).not.toMatch(/bg-white/);
      expect(cls).toContain("bg-transparent");
      expect(cls).toContain("h-10");
      expect(cls).toContain("w-10");
      expect(cls).not.toContain("h-11");
      // The tighter 20px glyph (down from 22px)…
      expect(cls).toContain("[&_svg]:size-5");
      // …with the hit target padded back to ≥44px by the invisible overlay.
      expect(cls).toContain("before:-inset-0.5");
    }
    unmount();

    // Active (recording): distinguishable via accent icon color + pulse — never
    // by reintroducing a background/border fill on the resting-style control.
    render(
      <ContinuousChatOverlay
        controller={makeController({ recording: true })}
      />,
    );
    const mic = screen.getByTestId("chat-composer-mic");
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    expect(mic.className).toContain("text-accent");
    expect(mic.className).toContain("animate-pulse");
    expect(mic.className).toContain("motion-reduce:animate-none");
    expect(mic.className).not.toMatch(/bg-white/);
    expect(mic.className).not.toMatch(/\bborder\b/);
  });

  it("never renders a resting suggestion strip (removed — the agent is proactive)", () => {
    render(
      <ContinuousChatOverlay controller={makeController({ messages: [] })} />,
    );
    expect(screen.queryByTestId("chat-suggestions")).toBeNull();
    expect(screen.queryByTestId("chat-suggestion-0")).toBeNull();
  });

  it("filters whitespace-only messages from the expanded thread", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    fireEvent.focus(screen.getByLabelText("message"));
    const log = document.getElementById("continuous-thread");
    expect(log?.textContent).toContain("hi there");
    // one real message → exactly one transcript bubble
    expect(log?.querySelectorAll('[data-testid="thread-line"]').length).toBe(1);
  });

  it("hides the topic chips bar + dividers on a single-topic thread", () => {
    // The lock-screen leak: a fresh thread whose only Stage-1 topic is
    // `greeting` was rendering a grey `greeting` chip top-left and a
    // "— GREETING —" divider above the only message. One topic group must
    // open clean — no chips rail, no divider.
    render(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [
            {
              id: "a",
              role: "assistant",
              content: "hey, how can I help?",
              createdAt: 1,
              topics: ["greeting"],
            },
            {
              id: "b",
              role: "user",
              content: "just saying hi",
              createdAt: 2,
              topics: ["greeting"],
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    expect(screen.queryByTestId("topic-chips-bar")).toBeNull();
    expect(screen.queryByTestId("topic-group-header")).toBeNull();
    expect(screen.queryByTestId("topic-group-pill")).toBeNull();
    // The message still renders — gating only removes the topic chrome.
    const log = document.getElementById("continuous-thread");
    expect(log?.textContent).toContain("how can I help");
  });

  it("shows the chips bar + dividers once the thread spans two topics", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [
            {
              id: "a",
              role: "user",
              content: "deploy failing",
              createdAt: 1,
              topics: ["deployment"],
            },
            {
              id: "b",
              role: "user",
              content: "and my card was charged twice",
              createdAt: 2,
              topics: ["billing"],
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    expect(screen.getByTestId("topic-chips-bar")).toBeTruthy();
    // Two distinct topics → two group dividers, labels humanized.
    expect(screen.getAllByTestId("topic-group-header").length).toBe(2);
    expect(screen.getByTestId("topic-chips-bar").textContent).toContain(
      "Deployment",
    );
    expect(screen.getByTestId("topic-chips-bar").textContent).toContain(
      "Billing",
    );
  });

  it("aligns the assistant bubble left and the user bubble right", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [
            { id: "a", role: "assistant", content: "hi there", createdAt: 1 },
            { id: "b", role: "user", content: "hello back", createdAt: 2 },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    const log = document.getElementById("continuous-thread");
    const lines = log?.querySelectorAll('[data-testid="thread-line"]');
    expect(lines?.length).toBe(2);
    const assistant = log?.querySelector('[data-role="assistant"]');
    const user = log?.querySelector('[data-role="user"]');
    expect(assistant?.className).toContain("justify-start");
    expect(user?.className).toContain("justify-end");
  });

  it("anchors the in-flight status row as an assistant-aligned transcript row", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({ phase: "responding", responding: true })}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    // The status indicator sits inside a left-aligned, full-width assistant row.
    const row = screen.getByTestId("turn-status-indicator").closest(".w-full");
    expect(row?.className).toContain("w-full");
    expect(row?.className).toContain("justify-start");
  });

  it("closes the sheet on Escape", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message");
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(input);
    expect(sheet.getAttribute("data-variant")).toBe("open");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("closes the sheet and marks the intent handled on an Android back-intent while open", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message");
    const sheet = screen.getByTestId("chat-sheet");
    // Open the sheet (type-to-open → half detent).
    fireEvent.focus(input);
    expect(sheet.getAttribute("data-variant")).toBe("open");

    // main.tsx dispatches this synchronously and reads back `detail.handled`.
    const detail = { handled: false };
    act(() => {
      window.dispatchEvent(
        new CustomEvent(ELIZA_BACK_INTENT_EVENT, { detail }),
      );
    });

    expect(detail.handled).toBe(true);
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("leaves the Android back-intent unhandled while the sheet is at rest (native falls through)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    // At rest: the sheet is closed (collapsed input bar), not opened.
    expect(sheet.getAttribute("data-variant")).toBe("closed");

    const detail = { handled: false };
    act(() => {
      window.dispatchEvent(
        new CustomEvent(ELIZA_BACK_INTENT_EVENT, { detail }),
      );
    });

    // Nothing consumed it, so main.tsx would fall through to history.back() /
    // minimizeApp(); the sheet stays closed.
    expect(detail.handled).toBe(false);
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("collapsing blurs the composer so the mobile keyboard drops", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    fireEvent.focus(input); // onFocus → expand → sheetOpen true (flushed by act)
    input.focus(); // also move real activeElement (jsdom fireEvent.focus doesn't)
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" }); // sheetOpen → collapse → blur
    expect(document.activeElement).not.toBe(input);
  });

  it("tapping outside the panel blurs the composer (drops the keyboard)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    // A pointerdown anywhere outside the chat panel dismisses the keyboard.
    fireEvent.pointerDown(document.body);
    expect(document.activeElement).not.toBe(input);
  });

  it("composes multi-line with an auto-growing textarea (Enter still sends)", () => {
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} />);
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(input.tagName).toBe("TEXTAREA");
    // Shift+Enter must NOT submit (it inserts a newline); plain Enter submits.
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(controller.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(vi.mocked(controller.send).mock.calls[0]?.[0]).toBe("line one");
  });

  it("closes the sheet on a pull-down drag of the grabber", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 360, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 360, pointerId: 1 });
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("fades the backdrop in with the chat and COLLAPSES on an outside tap", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const backdrop = screen.getByTestId("chat-sheet-backdrop");
    // Collapsed: inactive + click-through (the live view behind stays usable).
    expect(backdrop.getAttribute("data-active")).toBe("false");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(backdrop.getAttribute("data-active")).toBe("true");
    // Tapping the dimmed view behind collapses the chat back to the input while
    // the visual backdrop itself remains pointer-transparent for drags.
    fireEvent.pointerDown(backdrop, { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(backdrop, { clientX: 20, clientY: 20, pointerId: 1 });
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("cedes taps to a layer painted ABOVE the chat (stacked dialog) instead of collapsing", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    // Simulate a Radix dialog stacked above the chat glass (role="dialog" or
    // data-above-shell-overlay): its taps must NOT be swallowed into a chat
    // collapse — the overlay's own handlers win.
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    const rowButton = document.createElement("button");
    overlay.appendChild(rowButton);
    document.body.appendChild(overlay);
    try {
      fireEvent.pointerDown(rowButton, {
        clientX: 30,
        clientY: 30,
        pointerId: 5,
      });
      fireEvent.pointerUp(rowButton, {
        clientX: 30,
        clientY: 30,
        pointerId: 5,
      });
      expect(sheet.getAttribute("data-variant")).toBe("open");
    } finally {
      overlay.remove();
    }
  });

  it("cedes taps to the INLINE home notification center (below the glass) instead of collapsing (device r8)", () => {
    // #15080 moved the notification inbox inline on the home column, BELOW the
    // chat glass (not the old Z_NOTIFICATION_OVERLAY shade). Its rows are live
    // interactive surfaces: without an exemption the outside-tap collapse-
    // swallower ate the row's tap (preventDefault + suppressNextOutsideClick),
    // so tapping a notification did NOTHING ("interacting is cooked"). The
    // swallower exempts [data-notif-row] (the rows, and their option strip
    // which lives inside the row); a tap on a row must leave the chat OPEN and
    // not be swallowed.
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    // Mirror the notification center's real markers: a [data-notif-row] li with
    // its open button, under the [data-testid="home-notification-center"] host.
    const center = document.createElement("section");
    center.setAttribute("data-testid", "home-notification-center");
    const row = document.createElement("li");
    row.setAttribute("data-notif-row", "");
    const rowButton = document.createElement("button");
    let opened = false;
    rowButton.addEventListener("click", () => {
      opened = true;
    });
    row.appendChild(rowButton);
    center.appendChild(row);
    document.body.appendChild(center);
    try {
      fireEvent.pointerDown(rowButton, {
        clientX: 40,
        clientY: 40,
        pointerId: 7,
      });
      fireEvent.pointerUp(rowButton, {
        clientX: 40,
        clientY: 40,
        pointerId: 7,
      });
      // The chat stays open (tap NOT swallowed into a collapse)...
      expect(sheet.getAttribute("data-variant")).toBe("open");
      // ...and the row's own click is NOT suppressed by the swallower.
      fireEvent.click(rowButton, { clientX: 40, clientY: 40 });
      expect(opened).toBe(true);
    } finally {
      center.remove();
    }
  });

  it("still collapses on a tap of the notification center's bare field (not a row)", () => {
    // The exemption is scoped to [data-notif-row], not the whole flex-1
    // chromeless center section. A tap on the bare field AROUND the rows (which
    // looks like plain home background) must still collapse the chat — exempting
    // the whole section made most of the home band a dead zone (#15145 review).
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    // Focus alone keeps the sheet open but arms composerFocusedAtPress; blur so
    // the tap-outside path collapses rather than just clearing focus.
    fireEvent.blur(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    const center = document.createElement("section");
    center.setAttribute("data-testid", "home-notification-center");
    document.body.appendChild(center);
    try {
      fireEvent.pointerDown(center, { clientX: 40, clientY: 40, pointerId: 9 });
      fireEvent.pointerUp(center, { clientX: 40, clientY: 40, pointerId: 9 });
      expect(sheet.getAttribute("data-variant")).toBe("closed");
    } finally {
      center.remove();
    }
  });

  it("lets an open dialog own Escape — the chat only collapses once the dialog is gone", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    // An open Radix dialog (e.g. the command palette) above the chat: Escape
    // must close IT, not also collapse the chat underneath.
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    try {
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(sheet.getAttribute("data-variant")).toBe("open");
    } finally {
      dialog.remove();
    }
    // Dialog gone: Escape collapses the chat as before.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("lets the transcript viewer own Escape — the chat only collapses once the viewer is gone (#9148)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    // The maximized transcript viewer (portal to body) carries role="dialog"
    // but NO data-state="open", so it wouldn't match the old guard — Escape
    // would close it AND collapse the chat underneath. It must close alone.
    const viewer = document.createElement("div");
    viewer.setAttribute("role", "dialog");
    viewer.setAttribute("data-testid", "transcript-viewer");
    document.body.appendChild(viewer);
    try {
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(sheet.getAttribute("data-variant")).toBe("open");
    } finally {
      viewer.remove();
    }
    // Viewer gone: Escape collapses the chat as before.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("Escape closes an in-progress message edit without collapsing the whole sheet (#9148)", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [
            { id: "u", role: "user", content: "fix my typo", createdAt: 1 },
          ],
          send: vi.fn(),
        } as unknown as Partial<ShellController>)}
      />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    // Open the inline editor for the user turn.
    const bubble = screen
      .getByText("fix my typo")
      .closest('[data-testid="thread-line"]')
      ?.querySelector("div.select-text") as HTMLElement;
    fireEvent.click(bubble);
    fireEvent.click(screen.getByTestId("thread-line-edit"));
    const editInput = screen.getByTestId("thread-line-edit-input");

    // Escape closes THE EDITOR, and the sheet stays open (the edit-in-progress
    // must not be collapsed away with the whole chat).
    fireEvent.keyDown(editInput, { key: "Escape" });
    expect(screen.queryByTestId("thread-line-edit-input")).toBeNull();
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("renders the full thread as one scroll log when the sheet is open", () => {
    const controller = makeController({
      messages: [
        { id: "a", role: "assistant", content: "one", createdAt: 1 },
        { id: "b", role: "user", content: "two", createdAt: 2 },
        { id: "c", role: "assistant", content: "three", createdAt: 3 },
      ],
    } as unknown as Partial<ShellController>);
    render(<ContinuousChatOverlay controller={controller} />);
    fireEvent.focus(screen.getByLabelText("message"));

    // The full transcript is one vertical scroll region while open.
    const log = document.getElementById("continuous-thread");
    expect(log?.querySelectorAll('[data-testid="thread-line"]').length).toBe(3);
    expect(log?.className).toContain("overflow-y-auto");
    // Vertical-only invariant (#14328): the horizontal axis is pinned closed so
    // an over-wide child can never turn the transcript into a two-axis scroller.
    expect(log?.className).toContain("overflow-x-hidden");
    expect(log?.textContent).toContain("one");
  });

  it("does not mount hidden header or transcript layers while collapsed", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    expect(sheet.getAttribute("data-revealed")).toBe("false");
    expect(sheet.getAttribute("data-header-shown")).toBe("false");
    expect(document.getElementById("continuous-thread")).toBeNull();
    expect(screen.queryByTestId("chat-thread")).toBeNull();
    expect(screen.queryByTestId("chat-full-launcher")).toBeNull();

    const grabber = screen.getByTestId("chat-sheet-grabber");
    // The grab zone reaches a comfortable distance ABOVE the composer (so a
    // swipe-up begun just over it opens the chat) but stays bounded — it never
    // balloons up into the home widgets.
    expect(grabber.className).toContain("before:-top-6");
    expect(grabber.className).not.toContain("before:-top-16");
  });

  it("mounts an inert transcript preview during an upward drag before release", async () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(screen.queryByTestId("chat-thread")).toBeNull();

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 340, pointerId: 1 });

    const thread = await waitFor(() => screen.getByTestId("chat-thread"));
    const log = document.getElementById("continuous-thread");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(sheet.getAttribute("data-revealed")).toBe("true");
    expect(thread).toBeTruthy();
    expect(log?.getAttribute("aria-hidden")).toBe("true");
    expect(log?.getAttribute("tabindex")).toBe("-1");
  });

  it("shows the attach (+) control", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    expect(screen.getByTestId("chat-composer-plus")).toBeTruthy();
    expect(screen.getByLabelText("chat actions")).toBeTruthy();
  });

  it("attaches an image and enables an image-only send", async () => {
    const controller = makeController({ messages: [] });
    render(<ContinuousChatOverlay controller={controller} />);
    // Empty draft + no image → mic, no send.
    expect(screen.getByLabelText("talk")).toBeTruthy();
    expect(screen.queryByLabelText("send")).toBeNull();

    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["x"], "pic.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Once the read resolves, a thumbnail + send control appear.
    await screen.findByLabelText("send");
    expect(screen.getByLabelText(/remove pic\.png/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("send"));
    expect(controller.send).toHaveBeenCalledWith(
      "",
      expect.objectContaining({
        images: expect.arrayContaining([
          expect.objectContaining({ name: "pic.png", mimeType: "image/png" }),
        ]),
      }),
    );
  });

  it("a view-binding does NOT claim an image-bearing turn (images must not be lost)", async () => {
    // A focused cockpit session registers a text-only onSubmit binding. A turn
    // that also carries an image must fall through to the host agent (which can
    // send images), not be claimed by the binding — else the image vanishes.
    const onSubmit = vi.fn(() => true);
    setViewChatBinding({ onSubmit });
    const controller = makeController({ messages: [] });
    render(<ContinuousChatOverlay controller={controller} />);

    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["x"], "pic.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await screen.findByLabelText("send");
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "analyze this" },
    });

    fireEvent.click(screen.getByLabelText("send"));
    // binding must NOT have claimed it; host agent gets the text + image.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(controller.send).toHaveBeenCalledWith(
      "analyze this",
      expect.objectContaining({
        images: expect.arrayContaining([
          expect.objectContaining({ name: "pic.png" }),
        ]),
      }),
    );
  });

  it("toggles hands-free conversation when the mic is tapped", () => {
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} />);
    fireEvent.click(screen.getByLabelText("talk"));
    expect(controller.toggleHandsFree).toHaveBeenCalled();
  });

  it("shows a waking-up placeholder while booting (typing allowed)", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({ phase: "booting", canSend: false })}
      />,
    );
    const input = screen.getByLabelText("message");
    expect(input.getAttribute("placeholder")).toContain("waking up");
    // You can type while the agent boots; the message sends once it's ready.
    expect(input.hasAttribute("readonly")).toBe(false);
  });

  it("uses the pulsing composer glyph instead of rendering interim transcript text", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          phase: "listening",
          recording: true,
          transcript: "tell me about the coast",
        })}
      />,
    );
    expect(screen.queryByText(/tell me about the coast/)).toBeNull();
    // The "capture is hot" cue is the composer voice glyph's accent pulse —
    // NOT the drag handle: while the composer is visible the handle stays
    // quiet during a recording (a second pulsing bar right above the already-
    // pulsing glyph read as noise). Only the collapsed PILL pulses for a live
    // capture (see the morph regression suite).
    expect(screen.getByTestId("chat-composer-mic").className).toContain(
      "animate-pulse",
    );
    const grabberCue = screen
      .getByTestId("chat-sheet-grabber")
      .querySelector("span");
    expect(grabberCue?.className).not.toContain("animate-pulse");
  });

  it("keeps the ambient layer non-blocking for controls behind it", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);

    const root = screen.getByTestId("continuous-chat-overlay");
    expect(root.className).toContain("pointer-events-none");
    expect(root.className).not.toContain("pointer-events-auto");

    // The overlay still has a LIVE interactive region: the composer fieldset
    // re-enables pointer events (inline, gated on !pilled) so taps land on the
    // input while the rest of the surface passes through to the view behind it.
    const composer = screen.getByTestId("chat-sheet");
    expect(composer.style.pointerEvents).toBe("auto");
    expect(composer).not.toBe(root);
  });

  it("exposes the canonical chat composer test id on the overlay input only", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);

    expect(screen.getByTestId("chat-composer-textarea")).toBe(
      screen.getByLabelText("message"),
    );
    expect(screen.getAllByTestId("chat-composer-textarea")).toHaveLength(1);
  });

  it("keeps composer controls in one non-wrapping input row inside the constrained panel", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);

    const input = screen.getByTestId("chat-composer-textarea");
    const bar = input.parentElement;
    const panel = screen.getByTestId("chat-sheet");

    expect(screen.queryByTestId("chat-composer-clear-debug")).toBeNull();
    // Width is constrained on the panel's wrapper (which also holds the absolute
    // drag handle) via the morph-driven inline max-width — 48rem (768px) at rest,
    // widening to the viewport only as the maximize morph completes.
    expect(panel.parentElement?.style.maxWidth).toBe("768px");
    expect(bar?.className).toContain("flex");
    expect(bar?.className).not.toContain("flex-wrap");
    expect(input.className).toContain("flex-1");
    expect(input.className).not.toContain("basis-full");
  });

  it("renders no prompt-suggestion chips while the strip is flagged off", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [],
        } as unknown as Partial<ShellController>)}
      />,
    );
    expect(
      document.querySelectorAll('[data-testid^="chat-suggestion-"]'),
    ).toHaveLength(0);
  });

  it("scrolls to the latest line when a new message arrives while open", () => {
    const base = [{ id: "a", role: "assistant", content: "hi", createdAt: 1 }];
    const { rerender } = render(
      <ContinuousChatOverlay
        controller={makeController({
          messages: base,
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message")); // open the sheet
    // The shared thread-scroll engine glides to a NEW line with a smooth
    // el.scrollTo (jsdom has neither smooth scrolling nor Element.scrollTo,
    // so stub it to observe the call).
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo as unknown as Element["scrollTo"];
    try {
      rerender(
        <ContinuousChatOverlay
          controller={makeController({
            messages: [
              ...base,
              { id: "b", role: "user", content: "new line", createdAt: 2 },
            ],
          } as unknown as Partial<ShellController>)}
        />,
      );
      expect(scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "smooth" }),
      );
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it("marks chat transcript changes as transient layout motion", () => {
    vi.useFakeTimers();
    try {
      const base = [
        { id: "a", role: "assistant", content: "hi", createdAt: 1 },
      ];
      const { rerender } = render(
        <ContinuousChatOverlay
          controller={makeController({
            messages: base,
          } as unknown as Partial<ShellController>)}
        />,
      );
      const root = screen.getByTestId("continuous-chat-overlay");

      act(() => {
        vi.advanceTimersByTime(181);
      });
      expect(root.getAttribute(LAYOUT_SHIFT_INTENT_ATTR)).toBeNull();

      rerender(
        <ContinuousChatOverlay
          controller={makeController({
            messages: [
              ...base,
              { id: "b", role: "user", content: "new line", createdAt: 2 },
            ],
          } as unknown as Partial<ShellController>)}
        />,
      );

      expect(root.getAttribute(LAYOUT_SHIFT_INTENT_ATTR)).toBe(
        LAYOUT_SHIFT_INTENT_TRANSIENT,
      );
      act(() => {
        vi.advanceTimersByTime(181);
      });
      expect(root.getAttribute(LAYOUT_SHIFT_INTENT_ATTR)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT close on an outside pointer-down while the keyboard is DOWN", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    // fireEvent.focus drives the React open state but does NOT move
    // document.activeElement in jsdom — i.e. the composer isn't really focused
    // (no soft keyboard). An outside tap in that state must NOT close the chat;
    // closing is a pull-down, the scrim, or Escape.
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(document.activeElement).not.toBe(screen.getByLabelText("message"));
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("does NOT close when the underlying app scrolls", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
    fireEvent.scroll(document.body);
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("shows a stop control while a reply streams (and wires it)", () => {
    const stop = vi.fn();
    render(
      <ContinuousChatOverlay
        controller={makeController({
          phase: "responding",
          responding: true,
          stop,
        } as unknown as Partial<ShellController>)}
      />,
    );
    // No draft + responding → the trailing control is STOP, not mic or send.
    expect(screen.queryByTestId("chat-composer-mic")).toBeNull();
    expect(screen.queryByLabelText("send")).toBeNull();
    const stopBtn = screen.getByTestId("chat-composer-stop");
    expect(stopBtn).toBeTruthy();
    fireEvent.click(stopBtn);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reverts the trailing control to send the moment a draft exists mid-stream", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({ phase: "responding", responding: true })}
      />,
    );
    expect(screen.getByTestId("chat-composer-stop")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "queued" },
    });
    expect(screen.queryByTestId("chat-composer-stop")).toBeNull();
    expect(screen.getByLabelText(/send/)).toBeTruthy();
  });

  it("renders the no_provider failure as a recovery gate with a Settings jump, while a normal turn still renders its content", () => {
    const openSettings = vi.fn();
    render(
      <ContinuousChatOverlay
        controller={makeController({
          openSettings,
          messages: [
            {
              id: "ok",
              role: "assistant",
              content: "here is a normal answer",
              createdAt: 1,
            },
            {
              id: "np",
              role: "assistant",
              content: "No model provider is configured.",
              createdAt: 2,
              failureKind: "no_provider",
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));

    // The no_provider turn renders the STRUCTURED gate (heading + Settings CTA),
    // not an empty/near-empty bubble — this is the actionable recovery the user
    // needs on a first-message provider failure.
    expect(screen.getByText("Connect a provider to chat")).toBeTruthy();
    const gate = screen
      .getByTestId("chat-no-provider-settings")
      .closest('[data-failure="no_provider"]') as HTMLElement;
    expect(gate).toBeTruthy();
    // The server's fallback text rides inside the gate body (not dropped).
    expect(gate.textContent).toContain("No model provider is configured.");

    // The Settings CTA jumps to settings nav (setTab("settings") via the
    // controller's openSettings).
    fireEvent.click(screen.getByTestId("chat-no-provider-settings"));
    expect(openSettings).toHaveBeenCalledTimes(1);

    // A normal assistant turn in the same thread is UNAFFECTED — it still
    // renders its plain content as a thread bubble, not the gate.
    const normal = screen.getByText("here is a normal answer");
    expect(normal).toBeTruthy();
    expect(normal.closest('[data-failure="no_provider"]')).toBeNull();
  });

  it("press-and-hold copies an assistant message and flashes confirmation", () => {
    vi.useFakeTimers();
    try {
      vi.mocked(copyTextToClipboard).mockClear();
      render(
        <ContinuousChatOverlay
          controller={makeController({
            messages: [
              {
                id: "a",
                role: "assistant",
                content: "the answer is 42",
                createdAt: 1,
              },
            ],
          } as unknown as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));
      const bubble = screen
        .getByText("the answer is 42")
        .closest('[data-testid="thread-line"]')
        ?.querySelector("div.select-text") as HTMLElement;
      fireEvent.pointerDown(bubble, { clientX: 10, clientY: 10, pointerId: 1 });
      act(() => {
        vi.advanceTimersByTime(450); // past the hold threshold
      });
      expect(copyTextToClipboard).toHaveBeenCalledWith("the answer is 42");
      expect(screen.getByTestId("thread-line-copied")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps chat message text selectable for normal highlight/copy", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [
            {
              id: "u",
              role: "user",
              content: "copy my question",
              createdAt: 1,
            },
            {
              id: "a",
              role: "assistant",
              content: "copy my answer",
              createdAt: 2,
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));

    for (const text of ["copy my question", "copy my answer"]) {
      const textNode = screen.getByText(text);
      const bubble = screen
        .getByText(text)
        .closest('[data-testid="thread-line"]')
        ?.querySelector("div.select-text") as HTMLElement;
      expect(bubble.className).toContain("select-text");
      expect(bubble.className).not.toContain("select-none");
      expect(textNode.closest('[data-chat-selectable="true"]')).toBeTruthy();
    }
  });

  it("a quick tap (released before the hold threshold) does NOT copy", () => {
    vi.useFakeTimers();
    try {
      vi.mocked(copyTextToClipboard).mockClear();
      render(
        <ContinuousChatOverlay
          controller={makeController({
            messages: [
              { id: "a", role: "assistant", content: "tap me", createdAt: 1 },
            ],
          } as unknown as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));
      const bubble = screen
        .getByText("tap me")
        .closest('[data-testid="thread-line"]')
        ?.querySelector("div") as HTMLElement;
      fireEvent.pointerDown(bubble, { clientX: 10, clientY: 10, pointerId: 1 });
      vi.advanceTimersByTime(200);
      fireEvent.pointerUp(bubble, { clientX: 10, clientY: 10, pointerId: 1 });
      vi.advanceTimersByTime(400);
      expect(copyTextToClipboard).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pulls DOWN from the input to collapse into a recoverable pill", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    expect(screen.getByTestId("chat-composer-textarea")).toBeTruthy();
    // A downward drag past the threshold collapses the input away into the pill.
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("pill");
    expect(screen.getByTestId("chat-pill")).toBeTruthy();
    // In pill mode the composer is hidden away: kept mounted for the
    // pill→input morph but made inert (opacity 0 + `inert`) so it's unreachable
    // behind the pill capsule.
    expect(screen.getByTestId("chat-content").hasAttribute("inert")).toBe(true);
  });

  it("keeps the collapsed pill handle non-interactive while the input is formed", () => {
    // The pill handle is always mounted over the (faded) composer so it can
    // crossfade pill→input. Its hit zone (w-full/pt-10) sits over the textarea,
    // so while NOT pilled it must be pointer-events-none — otherwise it
    // intercepts the tap meant for the composer and the mobile keyboard never
    // opens.
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");

    const pill = screen.getByTestId("chat-pill");
    expect(pill.className).toContain("pointer-events-none");
    expect(pill.className).not.toContain("pointer-events-auto");
    // Kept out of the tab order / a11y tree while it's not the active handle.
    expect(pill.getAttribute("tabindex")).toBe("-1");
    expect(pill.getAttribute("aria-hidden")).toBe("true");
    // The pill's swipe-up grab zone spans the full width (not a narrow centred
    // px-16 stub) so a swipe-up from anywhere across the bottom opens.
    expect(pill.className).toContain("w-full");
  });

  it("makes the pill handle interactive (drag-to-open) once collapsed to the pill", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    // Collapse the input down into the pill.
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("pill");

    const pill = screen.getByTestId("chat-pill");
    // Now the handle owns the gesture: it re-enables pointer events so the user
    // can grab/drag it open (verified by the flick-up recovery test below).
    expect(pill.classList.contains("pointer-events-auto")).toBe(true);
    expect(pill.classList.contains("pointer-events-none")).toBe(false);
    expect(pill.getAttribute("aria-hidden")).toBeNull();
    // Restored to the tab order once it's the active handle — the symmetric half
    // of the collapsed assertion above (tabindex "-1" while NOT pilled). The
    // PillHandle sets tabIndex={pilled ? undefined : -1}, so the attribute is
    // absent (null) when pilled and keyboard users can Tab to + Enter the pill.
    expect(pill.getAttribute("tabindex")).toBeNull();
  });

  it("opens the chat to HALF on a SINGLE pill tap (not the bare input bar)", () => {
    // Regression: a tap on the pill used to land on the bare input bar (the
    // chat "blinked" without opening) and needed a SECOND tap to reach half.
    // With a conversation to show, ONE tap must open straight to half — exactly
    // like a flick-up.
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    const pill = screen.getByTestId("chat-pill");
    // A tap = pointer down + up with no travel. The pill has no onClick; the
    // pull-gesture binding is the single tap authority (onPointerUp → onTap).
    fireEvent.pointerDown(pill, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(pill, { clientY: 400, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");
    const textarea = screen.getByTestId("chat-composer-textarea");
    expect(textarea).toBeTruthy();
    // The pill tap must focus the composer (so iOS raises the keyboard on the
    // first tap) and clear the `inert` it carried while pilled — without that,
    // the composer silently refuses keyboard input until a second tap.
    expect(document.activeElement).toBe(textarea);
    expect(screen.getByTestId("chat-content").hasAttribute("inert")).toBe(
      false,
    );
  });

  it("opens a thread-less pill tap to the bare input bar (nothing to open into)", () => {
    // With no conversation yet there's no thread to reveal, so a pill tap forms
    // the input bar (and raises the keyboard) rather than an empty half sheet.
    render(
      <ContinuousChatOverlay controller={makeController({ messages: [] })} />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    const pill = screen.getByTestId("chat-pill");
    fireEvent.pointerDown(pill, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(pill, { clientY: 400, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    expect(document.activeElement).toBe(
      screen.getByTestId("chat-composer-textarea"),
    );
  });

  it("opens the pill on keyboard activation (Enter)", () => {
    // Keyboard users still open the pill via onKeyDown even though the native
    // onClick was removed in favour of the gesture binding.
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("pill");
    fireEvent.keyDown(screen.getByTestId("chat-pill"), { key: "Enter" });
    expect(sheet.getAttribute("data-detent")).toBe("half");
  });

  it("flicks UP from the pill to recover the input", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    const pill = screen.getByTestId("chat-pill");
    // A quick upward flick on the pill opens straight into the chat (the thread
    // has history), recovering the composer — a flick reaches the chat rather
    // than stopping at the bare input (that's the tap path; see the test above).
    fireEvent.pointerDown(pill, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(pill, { clientY: 360, pointerId: 1 });
    fireEvent.pointerUp(pill, { clientY: 360, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");
    expect(screen.getByTestId("chat-composer-textarea")).toBeTruthy();
  });

  it("shows the transcribe (mic-glyph) button beside the voice control at rest — ChatGPT arrangement", () => {
    // Resting composer: BOTH controls are always available — the mic glyph
    // starts a transcription/dictation session, the waveform glyph next to it
    // is the spoken conversation. (Previously transcribe only appeared once a
    // voice session was already live.)
    render(<ContinuousChatOverlay controller={makeController()} />);
    expect(screen.getByTestId("chat-composer-mic")).toBeTruthy();
    const transcribe = screen.getByTestId("chat-composer-transcribe");
    expect(transcribe).toBeTruthy();
    expect(transcribe.getAttribute("aria-label")).toBe("start transcription");
  });

  it("resting transcribe tap starts a transcription session", () => {
    const toggleTranscriptionMode = vi.fn();
    render(
      <ContinuousChatOverlay
        controller={makeController({
          toggleTranscriptionMode,
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.click(screen.getByTestId("chat-composer-transcribe"));
    expect(toggleTranscriptionMode).toHaveBeenCalledTimes(1);
  });

  it("hides BOTH trailing voice controls while a draft exists (send owns the slot)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "typing…" },
    });
    expect(screen.queryByTestId("chat-composer-mic")).toBeNull();
    expect(screen.queryByTestId("chat-composer-transcribe")).toBeNull();
    expect(screen.getByTestId("chat-composer-action")).toBeTruthy();
  });

  it("shows the transcribe button in voice mode, next to the mic (#10699)", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          handsFree: true,
          phase: "listening",
          recording: true,
        } as unknown as Partial<ShellController>)}
      />,
    );
    // Both controls present in voice mode; the mic stays the master control.
    expect(screen.getByTestId("chat-composer-mic")).toBeTruthy();
    expect(screen.getByTestId("chat-composer-transcribe")).toBeTruthy();
    expect(
      screen.getByTestId("chat-composer-transcribe").getAttribute("aria-label"),
    ).toBe("start transcription");
  });

  it("shows the transcribe button (as stop) while transcribing, alongside the status badge (#10699)", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          transcriptionMode: true,
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    expect(screen.getByTestId("chat-transcribing-badge")).toBeTruthy();
    const transcribe = screen.getByTestId("chat-composer-transcribe");
    expect(transcribe).toBeTruthy();
    expect(transcribe.getAttribute("aria-label")).toBe("stop transcription");
  });

  it("clicking the transcribe button toggles transcription mode (#10699)", () => {
    const toggleTranscriptionMode = vi.fn();
    render(
      <ContinuousChatOverlay
        controller={makeController({
          handsFree: true,
          recording: true,
          toggleTranscriptionMode,
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.click(screen.getByTestId("chat-composer-transcribe"));
    expect(toggleTranscriptionMode).toHaveBeenCalledTimes(1);
  });

  it("keeps the mic button ON while transcribing (additive, not a takeover)", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          transcriptionMode: true,
          toggleTranscriptionMode: vi.fn(),
        } as unknown as Partial<ShellController>)}
      />,
    );
    const mic = screen.getByTestId("chat-composer-mic");
    // The mic stays active (lit) the whole time transcription runs.
    expect(mic.getAttribute("aria-pressed")).toBe("true");
  });

  it("a mic tap while transcribing ends transcription, never starts a conversation", () => {
    const stopTranscriptionAndMic = vi.fn();
    const toggleHandsFree = vi.fn();
    render(
      <ContinuousChatOverlay
        controller={makeController({
          transcriptionMode: true,
          stopTranscriptionAndMic,
          toggleHandsFree,
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.click(screen.getByTestId("chat-composer-mic"));
    // The mic is the master voice control: a tap ends transcription AND the mic
    // (stopTranscriptionAndMic → finished transcript drops into the composer);
    // it must NOT open a hands-free conversation.
    expect(stopTranscriptionAndMic).toHaveBeenCalledTimes(1);
    expect(toggleHandsFree).not.toHaveBeenCalled();
  });

  it("a mic tap ends transcription even while a reply is in flight (#9880 inline reply)", () => {
    // A wake-word inline reply during transcription flips `responding` true
    // while `handsFree` is false (the transcript layer paused it). The mic —
    // labeled "stop transcription" — must still turn the session off; gating
    // the OFF path on `responding` left a lit, dead mic button until the reply
    // finished.
    const stopTranscriptionAndMic = vi.fn();
    const toggleHandsFree = vi.fn();
    render(
      <ContinuousChatOverlay
        controller={makeController({
          transcriptionMode: true,
          recording: true,
          responding: true,
          handsFree: false,
          stopTranscriptionAndMic,
          toggleHandsFree,
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.click(screen.getByTestId("chat-composer-mic"));
    expect(stopTranscriptionAndMic).toHaveBeenCalledTimes(1);
    expect(toggleHandsFree).not.toHaveBeenCalled();
  });

  it("the audio-unlock chip works while the sheet is open (not swallowed as an outside tap)", () => {
    // The unlock chip renders at the overlay root ABOVE the glass panel. The
    // document-level outside-tap detectors treated everything outside the panel
    // as "outside", so the chip's tap was swallowed (click suppressed) and the
    // sheet collapsed — enabling voice output was impossible while the chat was
    // open. The whole overlay now counts as inside.
    const unlockAudio = vi.fn();
    render(
      <ContinuousChatOverlay
        controller={makeController({
          needsAudioUnlock: true,
          unlockAudio,
        } as unknown as Partial<ShellController>)}
      />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    const chip = screen.getByTestId("overlay-voice-audio-unlock");
    // Real pointer sequence: the document-level detectors see pointerdown/up in
    // the capture phase before the click reaches the button.
    fireEvent.pointerDown(chip, { clientX: 200, clientY: 200, pointerId: 7 });
    fireEvent.pointerUp(chip, { clientX: 200, clientY: 200, pointerId: 7 });
    fireEvent.click(chip, { clientX: 200, clientY: 200 });

    expect(unlockAudio).toHaveBeenCalledTimes(1);
    // The sheet must stay open — the chip tap is not an outside collapse.
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("does not enter push-to-talk on a long press while transcribing", () => {
    vi.useFakeTimers();
    try {
      const stopTranscriptionAndMic = vi.fn();
      const startRecording = vi.fn();
      render(
        <ContinuousChatOverlay
          controller={makeController({
            transcriptionMode: true,
            stopTranscriptionAndMic,
            startRecording,
          } as unknown as Partial<ShellController>)}
        />,
      );

      const mic = screen.getByTestId("chat-composer-mic");
      fireEvent.pointerDown(mic, { button: 0, pointerId: 1 });
      act(() => {
        vi.advanceTimersByTime(250);
      });
      fireEvent.pointerUp(mic, { button: 0, pointerId: 1 });
      fireEvent.click(mic);

      expect(startRecording).not.toHaveBeenCalled();
      expect(stopTranscriptionAndMic).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("push-to-talk dictates into the composer on release; the label matches (never 'send')", () => {
    vi.useFakeTimers();
    try {
      const sinkRef: { fn: ((text: string) => void) | null } = { fn: null };
      const send = vi.fn();
      const startRecording = vi.fn();
      const stopRecording = vi.fn();
      const setDictationSink = vi.fn(
        (sink: ((text: string) => void) | null) => {
          sinkRef.fn = sink;
        },
      );
      render(
        <ContinuousChatOverlay
          controller={makeController({
            send,
            startRecording,
            stopRecording,
            setDictationSink,
          } as unknown as Partial<ShellController>)}
        />,
      );

      const mic = screen.getByTestId("chat-composer-mic");
      // Hold past the 200ms arm → dictation capture begins (intent "dictate").
      fireEvent.pointerDown(mic, { button: 0, pointerId: 1 });
      act(() => {
        vi.advanceTimersByTime(220);
      });
      expect(startRecording).toHaveBeenCalledWith("dictate");

      // The label must match the behavior: release inserts the dictation into
      // the composer, it does NOT send. (Regression: it read "release to send",
      // but the handler only fills the draft — see setDictationSink below.)
      const label = mic.getAttribute("aria-label") ?? "";
      expect(label).not.toContain("send");
      expect(label).toBe("release to insert");

      // Release ends the capture; the final transcript arrives via the
      // dictation sink and lands in the composer draft — nothing is sent.
      fireEvent.pointerUp(mic, { button: 0, pointerId: 1 });
      expect(stopRecording).toHaveBeenCalledTimes(1);
      act(() => {
        sinkRef.fn?.("hello from voice");
      });
      expect(send).not.toHaveBeenCalled();
      expect(
        (screen.getByLabelText("message") as HTMLTextAreaElement).value,
      ).toBe("hello from voice");
    } finally {
      vi.useRealTimers();
    }
  });

  it("inserts the finished transcript at the END of the draft and attaches the recording (ChatGPT-style dictation)", () => {
    let sink:
      | ((
          segments: Array<Record<string, unknown>>,
          startedAt: number,
          audioWav: Uint8Array | null,
        ) => void)
      | null = null;
    const controller = makeController({
      setTranscriptSessionSink: ((fn: unknown) => {
        sink = fn as typeof sink;
      }) as unknown as ShellController["setTranscriptSessionSink"],
    });
    render(<ContinuousChatOverlay controller={controller} />);
    expect(typeof sink).toBe("function");

    // Text typed BEFORE the session must survive — the transcript appends.
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "notes so far" } });

    vi.mocked(client.createTranscript).mockClear();
    act(() => {
      sink?.(
        [
          {
            id: "s1",
            startMs: 0,
            endMs: 1000,
            text: "hello world",
            words: [],
          },
        ],
        1_700_000_000_000,
        new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]),
      );
    });

    // The transcript lands as TEXT at the end of the draft — no markdown chip
    // to open, matching ChatGPT dictation …
    expect(input.value).toBe("notes so far hello world");
    expect(screen.queryByText(/^Transcript .*\.md$/)).toBeNull();
    // … and is NOT auto-sent — the user sends it when ready.
    expect(controller.send).not.toHaveBeenCalled();
    // The captured audio becomes a pending audio attachment — the sharable
    // artifact that rides the next send into the content-addressed media store
    // (attached synchronously here since the WAV bytes are already in hand;
    // an over-cap recording is dropped with an inline notice — see the sink).
    expect(screen.getByText(/^Recording .*\.wav$/)).toBeTruthy();
    // The session is still archived (record + audio) for the Transcripts view.
    expect(client.createTranscript).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.createTranscript).mock.calls[0][0]).toMatchObject({
      audioContentType: "audio/wav",
    });
  });

  it("a transcript with no captured audio still inserts text and attaches nothing", () => {
    let sink:
      | ((
          segments: Array<Record<string, unknown>>,
          startedAt: number,
          audioWav: Uint8Array | null,
        ) => void)
      | null = null;
    const controller = makeController({
      setTranscriptSessionSink: ((fn: unknown) => {
        sink = fn as typeof sink;
      }) as unknown as ShellController["setTranscriptSessionSink"],
    });
    render(<ContinuousChatOverlay controller={controller} />);
    act(() => {
      sink?.(
        [{ id: "s1", startMs: 0, endMs: 900, text: "just words", words: [] }],
        1_700_000_000_000,
        null,
      );
    });
    expect(
      (screen.getByLabelText("message") as HTMLTextAreaElement).value,
    ).toBe("just words");
    expect(screen.queryByText(/^Recording .*\.wav$/)).toBeNull();
    expect(controller.send).not.toHaveBeenCalled();
  });

  // ── SheetGrabber inert-while-pilled (the symmetric half of the PillHandle
  // pilled-gating above; #8772). The grabber and the pill capsule occupy the
  // same bottom region; exactly ONE may own the gesture / a11y tree at a time.
  // While the input is formed (not pilled) the GRABBER is live; once collapsed
  // to the pill, the grabber must go fully inert so it can't steal the pill's
  // taps or sit in the tab order behind it.
  it("keeps the sheet grabber live + in the a11y tree while NOT pilled", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");

    const grabber = screen.getByTestId("chat-sheet-grabber");
    // SheetGrabber: pointerEvents auto, tabIndex undefined (attr absent → in
    // tab order), aria-hidden undefined (attr absent → exposed) while !pilled.
    expect(grabber.style.pointerEvents).toBe("auto");
    expect(grabber.getAttribute("tabindex")).toBeNull();
    expect(grabber.getAttribute("aria-hidden")).toBeNull();
  });

  it("makes the sheet grabber fully inert (pointer/tab/a11y) once collapsed to the pill", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    // Collapse the input down into the pill.
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("pill");

    // The (still-mounted) grabber is now invisible behind the pill capsule, so
    // it must not intercept taps meant for the pill or pass them through to the
    // home screen, and must drop out of the tab order + a11y tree.
    // SheetGrabber: pointerEvents none, tabIndex -1, aria-hidden "true" pilled.
    expect(grabber.style.pointerEvents).toBe("none");
    expect(grabber.getAttribute("tabindex")).toBe("-1");
    expect(grabber.getAttribute("aria-hidden")).toBe("true");
  });

  // ── chat-full header carries NO nav buttons. Search / upload / camera /
  // transcribe moved to the composer "+" menu and Home lives in the launcher,
  // so the top bar no longer acts as a mini app nav (it only reserves the
  // safe-area inset + hosts the transcription badge).
  it("renders no nav buttons in the chat-full header", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          currentTab: "chat",
        } as Partial<ShellController>)}
      />,
    );
    openSheetToFull();

    expect(screen.queryByTestId("chat-full-launcher")).toBeNull();
    expect(screen.queryByTestId("chat-full-search")).toBeNull();
    expect(screen.queryByTestId("chat-full-home")).toBeNull();
    expect(screen.queryByTestId("chat-full-views")).toBeNull();
    expect(screen.queryByTestId("chat-full-settings")).toBeNull();
  });

  // Open the sheet to the FULL detent so the chat-full header is revealed and
  // interactive. Half keeps the header inert.
  function openSheetToFull(): void {
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("full");
  }

  // ── Rich turn-status indicator (#8813) ──────────────────────────────────
  describe("turn status indicator", () => {
    it("labels the thinking phase in the standalone status row", () => {
      render(
        <ContinuousChatOverlay
          controller={makeController({
            phase: "responding",
            responding: true,
            turnStatus: { kind: "thinking" },
          } as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));
      const indicator = screen.getByTestId("turn-status-indicator");
      expect(indicator.getAttribute("data-status-kind")).toBe("thinking");
      expect(indicator.getAttribute("role")).toBe("status");
      expect(indicator.getAttribute("aria-live")).toBe("polite");
      // The standalone status row carries a word for every phase (including
      // thinking) beside a spinner — the bare-dots variant is the in-bubble one.
      expect(screen.getByTestId("turn-status-label").textContent).toContain(
        "Thinking",
      );
      expect(screen.getByTestId("turn-status-spinner")).toBeTruthy();
    });

    it("humanizes the action name for a running_action phase", () => {
      render(
        <ContinuousChatOverlay
          controller={makeController({
            phase: "responding",
            responding: true,
            turnStatus: { kind: "running_action", actionName: "SEND_MESSAGE" },
          } as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));
      expect(screen.getByTestId("turn-status-label").textContent).toBe(
        "Running Send message",
      );
    });

    it("shows dots-only status inside the empty in-flight assistant bubble", () => {
      render(
        <ContinuousChatOverlay
          controller={makeController({
            phase: "responding",
            responding: true,
            // Last turn is an empty assistant bubble (the in-flight placeholder).
            messages: [
              { id: "u", role: "user", content: "do it", createdAt: 1 },
              { id: "a", role: "assistant", content: "", createdAt: 2 },
            ],
            turnStatus: { kind: "waking" },
          } as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));
      // Exactly one indicator (no double-up between the bubble + standalone row).
      const indicators = screen.getAllByTestId("turn-status-indicator");
      expect(indicators).toHaveLength(1);
      expect(indicators[0].getAttribute("data-status-kind")).toBe("waking");
      expect(screen.queryByTestId("turn-status-label")).toBeNull();
      expect(screen.getByTestId("typing-dots")).toBeTruthy();
    });

    it("hides reasoning disclosure while the latest assistant turn is streaming", () => {
      render(
        <ContinuousChatOverlay
          controller={makeController({
            phase: "responding",
            responding: true,
            messages: [
              { id: "u", role: "user", content: "explain it", createdAt: 1 },
              {
                id: "a",
                role: "assistant",
                content: "Draft answer",
                reasoning: "private chain of thought",
                createdAt: 2,
              },
            ],
            turnStatus: { kind: "running_action", actionName: "OPEN_VIEW" },
          } as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));

      expect(screen.getByText("Draft answer")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /thinking/i })).toBeNull();
      expect(screen.getByTestId("turn-status-label").textContent).toBe(
        "Running Open view",
      );
    });

    it("shows reasoning disclosure after the assistant turn settles", () => {
      render(
        <ContinuousChatOverlay
          controller={makeController({
            phase: "idle",
            responding: false,
            messages: [
              { id: "u", role: "user", content: "explain it", createdAt: 1 },
              {
                id: "a",
                role: "assistant",
                content: "Final answer",
                reasoning: "compact reasoning summary",
                createdAt: 2,
              },
            ],
          } as Partial<ShellController>)}
        />,
      );

      fireEvent.focus(screen.getByLabelText("message"));
      expect(screen.getByRole("button", { name: /thinking/i })).toBeTruthy();
    });

    it("holds the first label through a fast phase change (min-dwell, no flicker)", () => {
      vi.useFakeTimers();
      try {
        const { rerender } = render(
          <ContinuousChatOverlay
            controller={makeController({
              phase: "responding",
              responding: true,
              turnStatus: { kind: "thinking" },
            } as Partial<ShellController>)}
          />,
        );
        fireEvent.focus(screen.getByLabelText("message"));
        // The first phase already carries its word (thinking is labelled).
        expect(screen.getByTestId("turn-status-label").textContent).toContain(
          "Thinking",
        );
        // A near-instant change to running_action must NOT flip the label yet —
        // the first status is held for the min dwell so words don't strobe in.
        rerender(
          <ContinuousChatOverlay
            controller={makeController({
              phase: "responding",
              responding: true,
              turnStatus: {
                kind: "running_action",
                actionName: "SEND_MESSAGE",
              },
            } as Partial<ShellController>)}
          />,
        );
        expect(screen.getByTestId("turn-status-label").textContent).toContain(
          "Thinking",
        );
        // After the dwell window elapses the new phase is shown.
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(screen.getByTestId("turn-status-label").textContent).toContain(
          "Running Send message",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

/**
 * Single infinite thread (#13531): the chat-to-chat horizontal swipe was
 * REMOVED. This suite drives the REAL overlay with a REAL `conversationNav`
 * (built via the production `buildConversationNav` helper) and proves a
 * committed horizontal drag on the transcript NO LONGER selects an adjacent
 * conversation and NO swipe edge hint renders. (The collapsed-composer
 * home↔launcher swipe is a separate binding, covered elsewhere.)
 */
describe("ContinuousChatOverlay single-thread (no chat swipe, #13531)", () => {
  function conv(id: string): Conversation {
    return {
      id,
      title: id,
      roomId: `room-${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  // The list is most-recent-first: [newest "a", "b", oldest "c"]. Active "b" is
  // in the middle so both directions WOULD have been navigable pre-#13531.
  const CONVERSATIONS = [conv("a"), conv("b"), conv("c")];

  function makeSwipeController() {
    const onSelect = vi.fn<(id: string) => void>();
    const conversationNav = buildConversationNav(CONVERSATIONS, "b", onSelect);
    const controller = makeController({
      conversationNav,
    } as unknown as Partial<ShellController>);
    return { controller, onSelect };
  }

  function openSheet() {
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("full");
  }

  // Search moved off the header into the composer "+" actions menu; open it the
  // way a user now does — tap "+", then "Search chat…".
  function openSearchFromComposerMenu(): void {
    const plus = screen.getByTestId("chat-composer-plus");
    fireEvent.pointerDown(plus, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(plus, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByText("Search chat…"));
  }

  function thread(): HTMLElement {
    const el = document.getElementById("continuous-thread");
    if (!el) throw new Error("thread region not mounted");
    return el;
  }

  it("a committed LEFT drag does NOT switch to the next conversation", () => {
    const { controller, onSelect } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    openSheet();

    const el = thread();
    // The exact gesture that used to navigate LEFT (→ "c") pre-#13531.
    fireEvent.pointerDown(el, { clientX: 300, clientY: 300, pointerId: 2 });
    fireEvent.pointerMove(el, { clientX: 280, clientY: 302, pointerId: 2 });
    fireEvent.pointerUp(el, { clientX: 180, clientY: 302, pointerId: 2 });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a committed RIGHT drag does NOT switch to the previous conversation", () => {
    const { controller, onSelect } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    openSheet();

    const el = thread();
    // The exact gesture that used to navigate RIGHT (→ "a") pre-#13531.
    fireEvent.pointerDown(el, { clientX: 180, clientY: 300, pointerId: 2 });
    fireEvent.pointerMove(el, { clientX: 200, clientY: 302, pointerId: 2 });
    fireEvent.pointerUp(el, { clientX: 300, clientY: 302, pointerId: 2 });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("never renders a conversation-swipe edge hint mid-drag", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    openSheet();

    const el = thread();
    // Hold mid-drag (no pointerUp): pre-#13531 this lit the RIGHT edge hint.
    fireEvent.pointerDown(el, { clientX: 300, clientY: 300, pointerId: 3 });
    fireEvent.pointerMove(el, { clientX: 240, clientY: 302, pointerId: 3 });

    expect(screen.queryByTestId("conversation-swipe-hint-right")).toBeNull();
    expect(screen.queryByTestId("conversation-swipe-hint-left")).toBeNull();
  });

  it("exposes no maximize / minimize button (maximize is a pull now)", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    openSheet();

    // Maximize/minimize became a vertical pull in #13531 — still no button.
    expect(screen.queryByTestId("chat-full-maximize")).toBeNull();
  });

  it("exposes no left header controls (search + new-chat moved off the header)", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    openSheet();

    // The thread is one infinite conversation and the header carries no
    // buttons: search moved to the composer "+" menu, and there is deliberately
    // no new-chat/clear/refresh control anywhere.
    expect(screen.queryByTestId("chat-full-search")).toBeNull();
    expect(screen.queryByTestId("chat-full-clear")).toBeNull();
  });

  it("carries no voice control in the top bar — voice lives on the composer mic", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    openSheet();

    // The redundant top-bar mic was removed: voice has exactly one entry point,
    // the composer mic. A tap there enters/exits the hands-free conversation.
    expect(screen.queryByTestId("chat-full-voice")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-composer-mic"));
    expect(controller.toggleHandsFree).toHaveBeenCalledTimes(1);
  });

  it("opens the message-search panel from the composer + menu (#14279)", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    openSheet();

    // Panel is closed at rest.
    expect(screen.queryByTestId("chat-message-search")).toBeNull();
    // "+" → "Search chat…" reveals the search panel over the transcript.
    openSearchFromComposerMenu();
    expect(screen.getByTestId("chat-message-search")).toBeTruthy();
    expect(screen.getByTestId("message-search-panel")).toBeTruthy();
  });

  it("drives the header search → query → jump path against the real search API shape (#14330)", async () => {
    // Real jump plumbing: the overlay pulls handleSelectConversation from the
    // AppContext store, so seed it with a spy the jump must call. Mirror the
    // inert test-fallback proxy (noop for everything else the overlay reads via
    // other selectors) so only the jump collaborators are observable.
    const selectSpy = vi.fn<(id: string) => Promise<void>>(async () => {});
    const aroundSpy = vi.fn(async () => {
      const anchor = document.createElement("div");
      anchor.id = "chat-message-m-hit";
      document.body.appendChild(anchor);
      return true;
    });
    const noop = () => {};
    __setAppValueForTests(
      new Proxy({} as never, {
        get(_t, prop) {
          if (prop === "handleSelectConversation") return selectSpy;
          if (prop === "loadConversationMessagesAround") return aroundSpy;
          if (prop === "t") return (k: string) => k;
          if (prop === "uiLanguage") return "en";
          if (prop === "navigation") {
            return { scheduleAfterTabCommit: (fn: () => void) => fn() };
          }
          return noop;
        },
      }),
    );

    // The panel renders exactly what the server route returns; use its real
    // response shape (ranked hits with snippet/role/createdAt).
    const hit: ConversationMessageSearchResult = {
      messageId: "m-hit",
      conversationId: "conv-42",
      roomId: "room-1",
      role: "assistant",
      text: "the quarterly budget review is on friday",
      snippet: "the quarterly …budget… review is on friday",
      createdAt: 1_700_000_000_000,
      score: 12.5,
    };
    vi.mocked(client.searchConversationMessages).mockResolvedValue({
      results: [hit],
      count: 1,
    });

    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    openSheet();

    openSearchFromComposerMenu();
    const input = screen.getByTestId("message-search-input");
    fireEvent.change(input, { target: { value: "budget" } });

    // The debounced (250ms) search calls the real client method and lists the
    // ranked snippet result.
    const result = await waitFor(() =>
      screen.getByTestId("message-search-result"),
    );
    expect(client.searchConversationMessages).toHaveBeenCalledWith(
      "budget",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.textContent).toContain("budget");

    // Selecting the hit jumps to its conversation (the real jump plumbing) and
    // then loads the centered around-window because this fixture starts with no
    // DOM anchor for the hit.
    fireEvent.click(result);
    expect(selectSpy).toHaveBeenCalledWith("conv-42");
    await waitFor(() =>
      expect(aroundSpy).toHaveBeenCalledWith("conv-42", "m-hit"),
    );
    await waitFor(() =>
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
        block: "center",
        behavior: "smooth",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("chat-message-search")).toBeNull(),
    );
  });

  it("renders a distinguishable error state when the search API rejects (#14330)", async () => {
    // Three-state rule: a rejected search must surface an error render, never a
    // fabricated empty result.
    vi.mocked(client.searchConversationMessages).mockRejectedValue(
      new Error("search route 500"),
    );

    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    openSheet();

    openSearchFromComposerMenu();
    fireEvent.change(screen.getByTestId("message-search-input"), {
      target: { value: "budget" },
    });

    await waitFor(() =>
      expect(screen.getByTestId("message-search-error")).toBeTruthy(),
    );
    // The error state is NOT the empty state — a caught failure must not read as
    // "no matches".
    expect(screen.queryByTestId("message-search-empty")).toBeNull();
  });

  it("never invokes clearConversation from the header (no new-chat control)", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    openSheet();

    // The new-chat header control was removed: nothing in the header may
    // reset the thread.
    expect(screen.queryByTestId("chat-full-clear")).toBeNull();
    expect(controller.clearConversation).not.toHaveBeenCalled();
  });

  it("renders the infinite-scroll top sentinel above a populated flat thread (#14279)", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    openSheet();

    // The load-older prefetch sentinel mounts above the oldest turn so
    // useLoadOlderOnScroll can page older history in as the reader scrolls up.
    expect(screen.getByTestId("chat-transcript-top-sentinel")).toBeTruthy();
  });

  // Maximize is a PULL now, not a button (#13531). A big upward over-pull of the
  // grabber — far past the FULL detent — flips the sheet to edge-to-edge
  // full-bleed (data-maximized="true", data-chat-state="MAXIMIZED").
  function bigPullUp() {
    const grabber = screen.getByTestId("chat-sheet-grabber");
    // Start low, drag all the way to the very top: a deliberate slow over-pull
    // whose peak raw height clears the maximize threshold.
    fireEvent.pointerDown(grabber, { clientY: 760, pointerId: 7 });
    fireEvent.pointerMove(grabber, { clientY: 400, pointerId: 7 });
    fireEvent.pointerMove(grabber, { clientY: 40, pointerId: 7 });
    fireEvent.pointerMove(grabber, { clientY: 0, pointerId: 7 });
    fireEvent.pointerUp(grabber, { clientY: 0, pointerId: 7 });
  }

  it("a big upward over-pull of the grabber maximizes to full-bleed", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");
    expect(sheet.getAttribute("data-chat-state")).toBe("MAXIMIZED");
  });

  it("renders the top-20% pull-down restore zone ONLY while maximized", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    // Not present at rest / half.
    openSheet();
    expect(screen.queryByTestId("chat-maximize-restore-zone")).toBeNull();
    // Appears once maximized.
    bigPullUp();
    expect(screen.getByTestId("chat-maximize-restore-zone")).toBeTruthy();
  });

  it("a downward pull in the top-20% restore zone exits full-bleed back to the overlay (not a full collapse)", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");

    const zone = screen.getByTestId("chat-maximize-restore-zone");
    // A committed downward pull starting in the top-20% zone.
    fireEvent.pointerDown(zone, { clientY: 20, pointerId: 8 });
    fireEvent.pointerMove(zone, { clientY: 200, pointerId: 8 });
    fireEvent.pointerUp(zone, { clientY: 320, pointerId: 8 });

    // Back to the inset overlay: no longer maximized, but the sheet stays OPEN
    // (the thread didn't collapse to the input).
    expect(sheet.getAttribute("data-maximized")).toBeNull();
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("a FULL downward pull in the restore zone drops full-bleed and collapses the sheet all the way (the un-maximize→collapse bug)", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");

    // Drag the restore zone from the top all the way past the bottom: the strip
    // must stay grabbable through the un-maximize (it un-mounts on `fullBleed`,
    // so a naive gate would freeze the drag here) and drive the sheet to closed.
    const zone = screen.getByTestId("chat-maximize-restore-zone");
    fireEvent.pointerDown(zone, { clientY: 20, pointerId: 9 });
    fireEvent.pointerMove(zone, { clientY: 400, pointerId: 9 });
    fireEvent.pointerMove(zone, { clientY: 900, pointerId: 9 });
    fireEvent.pointerUp(zone, { clientY: 900, pointerId: 9 });

    expect(sheet.getAttribute("data-maximized")).toBeNull();
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("keyboard-activates the restore zone (ArrowDown exits full-bleed)", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");

    fireEvent.keyDown(screen.getByTestId("chat-maximize-restore-zone"), {
      key: "ArrowDown",
    });
    expect(sheet.getAttribute("data-maximized")).toBeNull();
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("Escape from maximized collapses the whole sheet (not just restore)", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(sheet.getAttribute("data-maximized")).toBeNull();
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  // ---- Full state-machine round-trips (long drags + gestures) --------------
  // Drive the sheet back and forth across every openness state with real
  // pointer drags on the grabber and the restore strip, asserting the machine
  // (data-chat-state / data-maximized / data-variant) never wedges in a state
  // it can't leave. These cover the reported "can't get back down from
  // maximized" bug from every entry angle.
  function grabberDrag(...ys: number[]): void {
    const g = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(g, { clientY: ys[0], pointerId: 33 });
    for (let i = 1; i < ys.length; i += 1) {
      fireEvent.pointerMove(g, { clientY: ys[i], pointerId: 33 });
    }
    fireEvent.pointerUp(g, { clientY: ys[ys.length - 1], pointerId: 33 });
  }
  function restoreZoneDrag(...ys: number[]): void {
    const z = screen.getByTestId("chat-maximize-restore-zone");
    fireEvent.pointerDown(z, { clientY: ys[0], pointerId: 34 });
    for (let i = 1; i < ys.length; i += 1) {
      fireEvent.pointerMove(z, { clientY: ys[i], pointerId: 34 });
    }
    fireEvent.pointerUp(z, { clientY: ys[ys.length - 1], pointerId: 34 });
  }

  it("round-trips INPUT → open → MAXIMIZED → open → re-MAXIMIZED → collapsed with no wedged state", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");

    // Rest is the composer-only INPUT state; no restore strip yet.
    expect(sheet.getAttribute("data-chat-state")).toBe("INPUT");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(screen.queryByTestId("chat-maximize-restore-zone")).toBeNull();

    // INPUT → open (pull the grabber up). The grabber owns this.
    openSheet();
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(screen.queryByTestId("chat-maximize-restore-zone")).toBeNull();

    // open → MAXIMIZED (over-pull past the 80% threshold).
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");
    expect(sheet.getAttribute("data-chat-state")).toBe("MAXIMIZED");
    expect(screen.getByTestId("chat-maximize-restore-zone")).toBeTruthy();

    // MAXIMIZED → open (a partial restore pull drops full-bleed, stays open).
    restoreZoneDrag(20, 200, 300);
    expect(sheet.getAttribute("data-maximized")).toBeNull();
    expect(sheet.getAttribute("data-variant")).toBe("open");
    // The grabber is back and the restore strip is gone once inset.
    expect(screen.getByTestId("chat-sheet-grabber")).toBeTruthy();
    expect(screen.queryByTestId("chat-maximize-restore-zone")).toBeNull();

    // open → MAXIMIZED again (prove the round-trip left no stuck flag).
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");
    expect(sheet.getAttribute("data-chat-state")).toBe("MAXIMIZED");

    // MAXIMIZED → collapsed (a full restore pull to the bottom closes it).
    restoreZoneDrag(20, 400, 900);
    expect(sheet.getAttribute("data-maximized")).toBeNull();
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("toggles MAXIMIZED ⇄ open cleanly across repeated cycles (no drift)", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    openSheet();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      bigPullUp();
      expect(sheet.getAttribute("data-maximized")).toBe("true");
      expect(sheet.getAttribute("data-chat-state")).toBe("MAXIMIZED");

      // Partial restore back to an inset open sheet.
      restoreZoneDrag(20, 200, 300);
      expect(sheet.getAttribute("data-maximized")).toBeNull();
      expect(sheet.getAttribute("data-variant")).toBe("open");
    }
  });

  it("steps INPUT → pill (CLOSED) on a grabber pull-down, then back to INPUT on tap", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-chat-state")).toBe("INPUT");

    // INPUT → pill: a downward pull folds the composer into the pill capsule.
    grabberDrag(600, 700, 800);
    expect(sheet.getAttribute("data-detent")).toBe("pill");
    expect(sheet.getAttribute("data-chat-state")).toBe("CLOSED");

    // pill → back: a tap on the pill leaves the CLOSED/pill state (it reveals the
    // composer, or the thread when there's history to show).
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 780, pointerId: 35 });
    fireEvent.pointerUp(grabber, { clientY: 780, pointerId: 35 });
    expect(sheet.getAttribute("data-detent")).not.toBe("pill");
    expect(sheet.getAttribute("data-chat-state")).not.toBe("CLOSED");
  });

  it("an upward hold in the restore zone keeps it MAXIMIZED (only a downward pull exits)", () => {
    const { controller } = makeSwipeController();
    render(<ContinuousChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");

    // A pull that only moves UP (or holds) inside the strip must not un-maximize.
    restoreZoneDrag(300, 200, 120);
    expect(sheet.getAttribute("data-maximized")).toBe("true");
    expect(sheet.getAttribute("data-chat-state")).toBe("MAXIMIZED");
  });
});

// The reported bug: clearing the chat dropped all messages, which unmounted the
// whole thread region, collapsing the open sheet to just the header + composer.
// The fix renders the thread whenever the sheet is OPEN (not only when there are
// messages), so an emptied/cleared conversation keeps its size and shows a
// loading state until its greeting lands.
describe("ContinuousChatOverlay — empty thread while the sheet is open", () => {
  function openSheetToHalf(): void {
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    expect(screen.getByTestId("chat-sheet").getAttribute("data-detent")).toBe(
      "half",
    );
  }

  it("keeps the thread mounted (no collapse) when the open conversation empties, and shows the loading spinner", () => {
    // Open with messages present (the gesture needs a thread to open into).
    const { rerender } = render(
      <ContinuousChatOverlay controller={makeController()} />,
    );
    openSheetToHalf();
    expect(document.getElementById("continuous-thread")).not.toBeNull();

    // Emptying the conversation (a clear in flight, awaiting the greeting) must
    // NOT unmount the thread — the sheet stays open at its size with a spinner.
    rerender(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [],
          conversationLoading: true,
        } as Partial<ShellController>)}
      />,
    );
    expect(document.getElementById("continuous-thread")).not.toBeNull();
    expect(screen.getByTestId("chat-sheet").getAttribute("data-detent")).toBe(
      "half",
    );
    expect(screen.getByTestId("chat-thread-loading")).toBeTruthy();
  });

  it("shows no spinner on an empty open thread that is not loading", () => {
    const { rerender } = render(
      <ContinuousChatOverlay controller={makeController()} />,
    );
    openSheetToHalf();

    rerender(
      <ContinuousChatOverlay
        controller={makeController({
          messages: [],
          conversationLoading: false,
        } as Partial<ShellController>)}
      />,
    );
    // Thread stays mounted, but with no in-flight load there is no spinner.
    expect(document.getElementById("continuous-thread")).not.toBeNull();
    expect(screen.queryByTestId("chat-thread-loading")).toBeNull();
  });
});

describe("ContinuousChatOverlay — streaming + thinking render (#10712)", () => {
  const reasoningMessages: ShellMessage[] = [
    { id: "u", role: "user", content: "why X over Y?", createdAt: 1 },
    {
      id: "a",
      role: "assistant",
      content: "because X is simpler",
      reasoning: "compared X and Y; X has fewer moving parts",
      createdAt: 2,
    },
  ];

  it("renders the collapsed Thinking disclosure for an assistant turn that carries reasoning", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          responding: false,
          messages: reasoningMessages,
        } as unknown as Partial<ShellController>)}
      />,
    );
    // Open the sheet so the thread (and its reasoning block) mounts.
    fireEvent.focus(screen.getByLabelText("message"));
    const thinking = screen.getByRole("button", { name: /thinking/i });
    expect(thinking).toBeTruthy();
    // Collapsed by default: the reasoning body is not shown until toggled.
    expect(thinking.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByText("compared X and Y; X has fewer moving parts"),
    ).toBeNull();
  });

  it("reveals the reasoning body when the Thinking disclosure is toggled", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          responding: false,
          messages: reasoningMessages,
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    fireEvent.click(screen.getByRole("button", { name: /thinking/i }));
    expect(
      screen.getByText("compared X and Y; X has fewer moving parts"),
    ).toBeTruthy();
  });

  it("suppresses reasoning on the last assistant turn while it is still streaming", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          // suppressReasoning = responding && isLastAssistant → the Thinking
          // block stays hidden until the stream completes.
          responding: true,
          messages: reasoningMessages,
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    expect(screen.queryByRole("button", { name: /thinking/i })).toBeNull();
  });

  it("paints reducer-streamed tokens incrementally and shows Thinking after completion", () => {
    let conversationMessages: ConversationMessage[] = [
      {
        id: "u-stream",
        role: "user",
        text: "stream the answer",
        timestamp: 1,
      },
      {
        id: "a-stream",
        role: "assistant",
        text: "",
        timestamp: 2,
      },
    ];
    const setConversationMessages: StreamingTextSetter = (next) => {
      conversationMessages =
        typeof next === "function" ? next(conversationMessages) : next;
    };
    const toShellMessages = (): ShellMessage[] =>
      conversationMessages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.text,
        createdAt: message.timestamp,
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      }));

    const { rerender } = render(
      <ContinuousChatOverlay
        controller={makeController({
          responding: true,
          turnStatus: { kind: "thinking" },
          messages: toShellMessages(),
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));

    applyStreamingTextModification(setConversationMessages, {
      messageId: "a-stream",
      mode: "replace",
      fullText: "Token one",
    });
    rerender(
      <ContinuousChatOverlay
        controller={makeController({
          responding: true,
          turnStatus: { kind: "streaming" },
          messages: toShellMessages(),
        } as unknown as Partial<ShellController>)}
      />,
    );
    expect(screen.getByText("Token one")).toBeTruthy();
    expect(screen.queryByText("Token one and two")).toBeNull();
    expect(screen.queryByRole("button", { name: /thinking/i })).toBeNull();

    applyStreamingTextModification(setConversationMessages, {
      messageId: "a-stream",
      mode: "replace",
      fullText: "Token one and two",
    });
    rerender(
      <ContinuousChatOverlay
        controller={makeController({
          responding: true,
          turnStatus: { kind: "streaming" },
          messages: toShellMessages(),
        } as unknown as Partial<ShellController>)}
      />,
    );
    expect(screen.getByText("Token one and two")).toBeTruthy();

    applyStreamingTextModification(setConversationMessages, {
      messageId: "a-stream",
      mode: "complete",
      fullText: "Token one and two",
      reasoning: "Waited for the done frame before showing reasoning.",
    });
    rerender(
      <ContinuousChatOverlay
        controller={makeController({
          responding: false,
          messages: toShellMessages(),
        } as unknown as Partial<ShellController>)}
      />,
    );

    const thinking = screen.getByRole("button", { name: /thinking/i });
    expect(thinking.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByText("Waited for the done frame before showing reasoning."),
    ).toBeNull();

    fireEvent.click(thinking);
    expect(
      screen.getByText("Waited for the done frame before showing reasoning."),
    ).toBeTruthy();
  });
});

// Per-message click-to-reveal action row (#10713): assistant → Copy + Play,
// user → Copy + Edit-and-resend, temp turns are not editable.
describe("ContinuousChatOverlay — per-message action row (#10713)", () => {
  function openThreadWith(overrides: Partial<ShellController>) {
    render(
      <ContinuousChatOverlay
        controller={makeController(overrides as Partial<ShellController>)}
      />,
    );
    // Focusing the composer opens the sheet so the transcript renders.
    fireEvent.focus(screen.getByLabelText("message"));
  }

  function bubbleFor(text: string): HTMLElement {
    return screen
      .getByText(text)
      .closest('[data-testid="thread-line"]')
      ?.querySelector("div.select-text") as HTMLElement;
  }

  it("reveals Copy + Play on an assistant message and no top-menu copy button", () => {
    const speak = vi.fn();
    openThreadWith({
      messages: [
        { id: "a", role: "assistant", content: "the answer", createdAt: 1 },
      ],
      speak,
      speaking: false,
    });
    // No row until the bubble is clicked.
    expect(screen.queryByTestId("thread-line-actions")).toBeNull();
    fireEvent.click(bubbleFor("the answer"));
    expect(screen.getByTestId("thread-line-actions")).toBeTruthy();
    expect(screen.getByTestId("thread-line-copy")).toBeTruthy();
    expect(screen.getByTestId("thread-line-speak")).toBeTruthy();
    // Assistant has no edit affordance.
    expect(screen.queryByTestId("thread-line-edit")).toBeNull();
    // The removed "copy conversation" top-menu button stays gone.
    expect(
      screen.queryByRole("button", { name: /copy conversation/i }),
    ).toBeNull();
  });

  it("Play speaks the assistant message via the controller", () => {
    const speak = vi.fn();
    openThreadWith({
      messages: [
        { id: "a", role: "assistant", content: "read me aloud", createdAt: 1 },
      ],
      speak,
      speaking: false,
    });
    fireEvent.click(bubbleFor("read me aloud"));
    fireEvent.click(screen.getByTestId("thread-line-speak"));
    expect(speak).toHaveBeenCalledWith("read me aloud");
  });

  it("Play toggles to Stop once THIS message is the one playing", () => {
    const speak = vi.fn();
    const stopSpeaking = vi.fn();
    openThreadWith({
      messages: [
        { id: "a", role: "assistant", content: "now playing", createdAt: 1 },
      ],
      speak,
      stopSpeaking,
      speaking: true,
    });
    fireEvent.click(bubbleFor("now playing"));
    const play = screen.getByTestId("thread-line-speak");
    // The agent is globally speaking, but nothing has been Played from THIS
    // bubble, so it still offers Play (not a spurious Stop — the old bug).
    expect(play.getAttribute("aria-label")).toBe("Play audio");
    // Tapping Play speaks this message and marks it as the one playing.
    fireEvent.click(play);
    expect(speak).toHaveBeenCalledWith("now playing");
    const stop = screen.getByTestId("thread-line-speak");
    expect(stop.getAttribute("aria-label")).toBe("Stop");
    // Tapping again stops playback instead of re-speaking.
    fireEvent.click(stop);
    expect(stopSpeaking).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("shows Stop only on the actually-playing bubble, not every assistant bubble while anything speaks (#9148)", () => {
    const speak = vi.fn();
    openThreadWith({
      messages: [
        { id: "a", role: "assistant", content: "first answer", createdAt: 1 },
        { id: "b", role: "assistant", content: "second answer", createdAt: 2 },
      ],
      speak,
      speaking: true,
    });
    // Reveal both action rows. With the global `speaking` flag set but nothing
    // Played yet, NEITHER bubble claims Stop (the old bug lit every bubble).
    fireEvent.click(bubbleFor("first answer"));
    fireEvent.click(bubbleFor("second answer"));
    expect(
      screen
        .getAllByTestId("thread-line-speak")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Play audio", "Play audio"]);
    // Play the FIRST message → only its bubble flips to Stop; the second stays
    // on Play even though the agent is still globally speaking.
    fireEvent.click(screen.getAllByTestId("thread-line-speak")[0]);
    expect(speak).toHaveBeenCalledWith("first answer");
    expect(
      screen
        .getAllByTestId("thread-line-speak")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Stop", "Play audio"]);
  });

  it("row Copy writes the message text to the clipboard", () => {
    vi.mocked(copyTextToClipboard).mockClear();
    openThreadWith({
      messages: [
        { id: "a", role: "assistant", content: "copy this text", createdAt: 1 },
      ],
      speak: vi.fn(),
    });
    fireEvent.click(bubbleFor("copy this text"));
    fireEvent.click(screen.getByTestId("thread-line-copy"));
    expect(copyTextToClipboard).toHaveBeenCalledWith("copy this text");
  });

  it("reveals Copy + Edit on a user message and resends the edited text", () => {
    const send = vi.fn();
    openThreadWith({
      messages: [{ id: "u", role: "user", content: "helo wrld", createdAt: 1 }],
      send,
    });
    fireEvent.click(bubbleFor("helo wrld"));
    expect(screen.getByTestId("thread-line-copy")).toBeTruthy();
    expect(screen.getByTestId("thread-line-edit")).toBeTruthy();
    // User turns have no play control.
    expect(screen.queryByTestId("thread-line-speak")).toBeNull();

    fireEvent.click(screen.getByTestId("thread-line-edit"));
    const input = screen.getByTestId(
      "thread-line-edit-input",
    ) as HTMLTextAreaElement;
    expect(input.value).toBe("helo wrld");
    fireEvent.change(input, { target: { value: "hello world" } });
    fireEvent.click(screen.getByTestId("thread-line-edit-save"));
    expect(send).toHaveBeenCalledWith("hello world");
  });

  it("does not offer Edit on an optimistic temp- user turn", () => {
    openThreadWith({
      messages: [
        { id: "temp-123", role: "user", content: "pending turn", createdAt: 1 },
      ],
      send: vi.fn(),
    });
    fireEvent.click(bubbleFor("pending turn"));
    expect(screen.getByTestId("thread-line-copy")).toBeTruthy();
    expect(screen.queryByTestId("thread-line-edit")).toBeNull();
  });

  it("dismisses the row on an outside tap", () => {
    openThreadWith({
      messages: [
        { id: "a", role: "assistant", content: "tap away", createdAt: 1 },
      ],
      speak: vi.fn(),
    });
    fireEvent.click(bubbleFor("tap away"));
    expect(screen.getByTestId("thread-line-actions")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("thread-line-actions")).toBeNull();
  });

  it("Escape cancels the inline editor without resending", () => {
    const send = vi.fn();
    openThreadWith({
      messages: [{ id: "u", role: "user", content: "keep me", createdAt: 1 }],
      send,
    });
    fireEvent.click(bubbleFor("keep me"));
    fireEvent.click(screen.getByTestId("thread-line-edit"));
    const input = screen.getByTestId("thread-line-edit-input");
    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("thread-line-edit-input")).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("ContinuousChatOverlay — OS assistant / deep-link launch (#9148)", () => {
  beforeEach(() => {
    __resetAssistantLaunchPayloadClaimsForTests();
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("prefills the composer from an assistant-launch chat deep link on the hash", () => {
    // Siri / Shortcuts / App Actions route into #chat?text=…&source=…; the
    // ambient overlay is the only chat surface on mobile/web/default desktop, so
    // it must claim the payload and PREFILL (never auto-send) the composer.
    window.history.replaceState(
      null,
      "",
      "/#chat?text=Remind%20me%20at%205&source=siri&assistant.launchId=launch-9148",
    );
    render(<ContinuousChatOverlay controller={makeController()} />);
    expect(
      (screen.getByLabelText("message") as HTMLTextAreaElement).value,
    ).toBe("Remind me at 5");
  });

  it("consumes a launch only once — a second mount with the same launch id does not re-prefill", () => {
    const hash =
      "/#chat?text=Water%20plants&source=macos-shortcuts&assistant.launchId=launch-once";
    window.history.replaceState(null, "", hash);
    const first = render(
      <ContinuousChatOverlay controller={makeController()} />,
    );
    expect(
      (screen.getByLabelText("message") as HTMLTextAreaElement).value,
    ).toBe("Water plants");
    first.unmount();

    // The same launch id arrives again (re-open / re-render); claiming dedupes
    // by launchId so it is NOT consumed a second time.
    window.history.replaceState(null, "", hash);
    render(<ContinuousChatOverlay controller={makeController()} />);
    expect(
      (screen.getByLabelText("message") as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("starts hands-free voice capture on a voice=1 launch (while prefilling text)", () => {
    const toggleHandsFree = vi.fn();
    window.history.replaceState(
      null,
      "",
      "/#chat?text=start%20talking&source=assistant-entry&voice=1&assistant.launchId=launch-voice",
    );
    render(
      <ContinuousChatOverlay
        controller={makeController({ toggleHandsFree })}
      />,
    );
    expect(
      (screen.getByLabelText("message") as HTMLTextAreaElement).value,
    ).toBe("start talking");
    expect(toggleHandsFree).toHaveBeenCalledTimes(1);
  });

  it("ignores an untrusted-source hash (no prefill, no voice)", () => {
    const toggleHandsFree = vi.fn();
    window.history.replaceState(
      null,
      "",
      "/#chat?text=malicious&source=unknown-shortcut&voice=1",
    );
    render(
      <ContinuousChatOverlay
        controller={makeController({ toggleHandsFree })}
      />,
    );
    expect(
      (screen.getByLabelText("message") as HTMLTextAreaElement).value,
    ).toBe("");
    expect(toggleHandsFree).not.toHaveBeenCalled();
  });

  it("shows Retry on a recoverable failed assistant turn and re-sends the preceding user turn", () => {
    const controller = makeController({
      messages: [
        {
          id: "u1",
          role: "user",
          content: "what's the weather?",
          createdAt: 1,
        },
        {
          id: "a1",
          role: "assistant",
          content: "",
          createdAt: 2,
          failureKind: "rate_limited",
        },
      ],
    } as unknown as Partial<ShellController>);
    render(<ContinuousChatOverlay controller={controller} />);
    fireEvent.focus(screen.getByLabelText("message"));
    const retry = screen.getByTestId("thread-line-retry");
    expect(retry).toBeTruthy();
    fireEvent.click(retry);
    expect(controller.send).toHaveBeenCalledWith("what's the weather?");
  });

  it("does NOT show Retry on an unrecoverable failure (no_provider / insufficient_credits)", () => {
    const controller = makeController({
      messages: [
        { id: "u1", role: "user", content: "hi", createdAt: 1 },
        {
          id: "a1",
          role: "assistant",
          content: "",
          createdAt: 2,
          failureKind: "insufficient_credits",
        },
      ],
    } as unknown as Partial<ShellController>);
    render(<ContinuousChatOverlay controller={controller} />);
    fireEvent.focus(screen.getByLabelText("message"));
    expect(screen.queryByTestId("thread-line-retry")).toBeNull();
  });

  it("restores the persisted composer draft for the active conversation (shared app composer slot)", () => {
    // The overlay reads the SHARED ChatComposerContext draft; the app-level
    // persistence hook (AppContext runs the same one this harness runs)
    // restores a saved draft into that slot on mount, which must repaint the
    // overlay's composer.
    clearChatDraft("conv-draft-x");
    writeChatDraft("conv-draft-x", "half-written thought");
    render(
      <AppComposerHarness
        initialActiveId="conv-draft-x"
        selectRef={{ current: null }}
      />,
    );
    expect(
      (screen.getByLabelText("message") as HTMLTextAreaElement).value,
    ).toBe("half-written thought");
    clearChatDraft("conv-draft-x");
  });

  it("typing in the overlay edits the shared app composer slot (one draft across surfaces)", () => {
    render(
      <AppComposerHarness
        initialActiveId="conv-a"
        selectRef={{ current: null }}
      />,
    );
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "shared draft" } });
    expect(screen.getByTestId("harness-chat-input").textContent).toBe(
      "shared draft",
    );
    clearChatDraft("conv-a");
  });

  // Draft handoff on conversation switch. The overlay no longer owns any
  // handoff logic: its draft is the shared ChatComposerContext slot, and the
  // app's select path (useChatCallbacks.handleSelectConversation — which the
  // controller's conversationNav swipe routes through) flushes the leaving
  // conversation's text under ITS OWN key and repaints the target's draft (or
  // clears it). The harness runs that exact seam around the real overlay.
  describe("draft handoff on conversation switch", () => {
    beforeEach(() => {
      clearChatDraft("conv-a");
      clearChatDraft("conv-b");
    });

    afterEach(() => {
      clearChatDraft("conv-a");
      clearChatDraft("conv-b");
    });

    it("switching A(typed) → B(no draft) clears the composer and saves the text under A's key — never B's", async () => {
      const selectRef: {
        current: ((id: string) => void) | null;
      } = { current: null };
      render(
        <AppComposerHarness initialActiveId="conv-a" selectRef={selectRef} />,
      );
      const input = screen.getByLabelText("message") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "half-typed for A" } });

      act(() => selectRef.current?.("conv-b"));

      // The draftless target CLEARS — A's text must not stay visible in B.
      expect(input.value).toBe("");
      // The handoff flushed the text under the LEAVING conversation's key
      // synchronously (the debounced persister's pending timer is cancelled
      // by the switch, so only the explicit flush can have written this).
      expect(readChatDraft("conv-a")).toBe("half-typed for A");
      expect(readChatDraft("conv-b")).toBeNull();

      // Outlast the 500ms persist debounce: the wrong-conversation write
      // (A's text under B's key) must NEVER land.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
      });
      expect(readChatDraft("conv-b")).toBeNull();
      expect(readChatDraft("conv-a")).toBe("half-typed for A");
    });

    it("switching A(typed) → B(saved draft) restores B's own draft and keeps A's under A's key", () => {
      writeChatDraft("conv-b", "B's parked reply");
      const selectRef: {
        current: ((id: string) => void) | null;
      } = { current: null };
      render(
        <AppComposerHarness initialActiveId="conv-a" selectRef={selectRef} />,
      );
      const input = screen.getByLabelText("message") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "half-typed for A" } });

      act(() => selectRef.current?.("conv-b"));

      expect(input.value).toBe("B's parked reply");
      expect(readChatDraft("conv-a")).toBe("half-typed for A");
      expect(readChatDraft("conv-b")).toBe("B's parked reply");
    });

    it("a successful send still clears both the composer and the active conversation's saved draft", () => {
      writeChatDraft("conv-a", "stale saved draft");
      const controller = makeController({
        conversationNav: {
          hasPrev: false,
          hasNext: false,
          goPrev: () => {},
          goNext: () => {},
          activeId: "conv-a",
          index: 0,
        },
      } as unknown as Partial<ShellController>);
      render(<ContinuousChatOverlay controller={controller} />);
      const input = screen.getByLabelText("message") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "ship it" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(vi.mocked(controller.send).mock.calls[0]?.[0]).toBe("ship it");
      expect(input.value).toBe("");
      // The submit path drops the persisted draft immediately (not just via
      // the debounced persist of the now-empty draft).
      expect(readChatDraft("conv-a")).toBeNull();
    });
  });
});

// The floating boot pill was removed outright: boot state has NO surface above
// the chat. A stalled boot speaks INSIDE the transcript via the boot-recovery
// conductor (use-boot-recovery-conductor.test.tsx covers that path); this pins
// the overlay's side of the contract — no pill ever, no matter how long the
// boot runs.
describe("ContinuousChatOverlay — no floating boot pill", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never renders a floating boot-status pill, even deep into a cold boot", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({ phase: "booting" })}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.queryByTestId("chat-boot-status")).toBeNull();
  });
});

// When no LLM/model provider is configured the agent's `canRespond` never flips,
// so `phase` stays "booting" forever. The controller flags `noProviderConfigured`
// and the overlay stops promising the agent is "waking up" — the in-transcript
// no_provider gate is the real error surface.
describe("ContinuousChatOverlay — no LLM provider configured", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("swaps the 'waking up…' composer placeholder for a Settings CTA hint", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          phase: "booting",
          noProviderConfigured: true,
        })}
      />,
    );
    const input = screen.getByLabelText("message");
    const placeholder = input.getAttribute("placeholder") ?? "";
    expect(placeholder).not.toContain("waking up");
    expect(placeholder).toContain("Settings");
    // Typing is still allowed (the send comes back with the gate again if needed).
    expect(input.hasAttribute("readonly")).toBe(false);
  });
});
