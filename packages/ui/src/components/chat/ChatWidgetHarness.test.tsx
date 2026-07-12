// @vitest-environment jsdom
//
// The backend-free chat harness mounts the REAL ChatOverlay with a
// scripted conversation. These tests render it in jsdom (API client stubbed —
// no network) and assert the onboarding opening, that composer sends advance
// the script entirely in local state, and that the onboarding pin releases.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { NativeTranscriptFrame } from "../../chat/native-transcript/spec";
import type { NativeTranscriptRect } from "../../glass/native-transcript-bridge";

// Captures every call the harness makes over the NativeTranscript bridge and
// exposes the registered transcriptAction handler so tests can inject native
// widget taps. The mock reports "available"; the harness's own demo-flag gate
// (localStorage "eliza:native-transcript-demo") decides whether it is used, so
// the existing DOM-only tests run against the same mock untouched.
const nativeTranscript = vi.hoisted(() => ({
  frames: [] as NativeTranscriptFrame[],
  rects: [] as NativeTranscriptRect[],
  actionHandler: null as ((action: { message: string }) => void) | null,
  hides: 0,
  removals: 0,
  reset(): void {
    this.frames = [];
    this.rects = [];
    this.actionHandler = null;
    this.hides = 0;
    this.removals = 0;
  },
}));

vi.mock("../../glass/native-transcript-bridge", () => ({
  isNativeTranscriptAvailable: async () => true,
  nativeTranscriptBridge: () => ({
    isAvailable: async () => ({ available: true }),
    setTranscript: async ({ frame }: { frame: NativeTranscriptFrame }) => {
      nativeTranscript.frames.push(frame);
    },
    show: async ({ rect }: { rect: NativeTranscriptRect }) => {
      nativeTranscript.rects.push(rect);
    },
    hide: async () => {
      nativeTranscript.hides += 1;
    },
    addListener: async (
      _event: "transcriptAction",
      handler: (action: { message: string }) => void,
    ) => {
      nativeTranscript.actionHandler = handler;
      return {
        remove: async () => {
          nativeTranscript.removals += 1;
          nativeTranscript.actionHandler = null;
        },
      };
    },
  }),
  resetNativeTranscriptBridgeForTests: () => {},
}));

vi.mock("../../api/client", () => ({
  client: {
    fetch: vi.fn().mockRejectedValue(new Error("no api in test")),
    getCodingAgentTaskThread: vi
      .fn()
      .mockRejectedValue(new Error("no api in test")),
    onWsEvent: vi.fn(() => () => undefined),
    searchConversationMessages: vi.fn(),
    createTranscript: vi
      .fn()
      .mockResolvedValue({ transcript: { id: "t1", title: "Transcript" } }),
  },
}));

vi.mock("../../utils/clipboard", () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../chat/report-composer-activity", () => ({
  reportComposerActivity: vi.fn(),
}));

import { ChatWidgetHarness } from "./ChatWidgetHarness";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

describe("ChatWidgetHarness", () => {
  afterEach(cleanup);

  it("opens with the in-chat onboarding choice widget inside the real overlay", () => {
    render(<ChatWidgetHarness />);

    expect(screen.getByTestId("chat-widget-harness")).toBeTruthy();
    // The production first-run greeting + the REAL sign-into-cloud choice
    // widget, rendered through the production widget parser.
    expect(screen.getByText("Hi, I'm Eliza.")).toBeTruthy();
    expect(screen.getByText("Sign in to Eliza Cloud")).toBeTruthy();
    expect(screen.getByText("Stay local for now")).toBeTruthy();
  });

  it("advances the scripted onboarding from a widget tap, all local", async () => {
    render(<ChatWidgetHarness />);

    // Onboarding pins the sheet and locks the composer — advancement comes
    // from the transcript widgets, exactly like the production first run.
    fireEvent.click(screen.getByText("Sign in to Eliza Cloud"));

    // The tap echoes as a user turn, then the scripted assistant reply (the
    // onboarding profile form) lands after the local delay.
    await waitFor(
      () => expect(screen.getByText(/Tell me a little/i)).toBeTruthy(),
      { timeout: 3000 },
    );
    expect(screen.getByText("Set up your assistant")).toBeTruthy();
  });

  it("walks the whole script rendering only REAL production widgets — no raw markers", async () => {
    render(<ChatWidgetHarness />);

    const advance = async (matcher: () => unknown) => {
      await waitFor(matcher, { timeout: 3000 });
    };
    const tap = (el: Element) => fireEvent.click(el);

    // Scene 0 → sign-in tap → profile form (real form-request widget); the
    // first-run pin releases with this reply.
    tap(screen.getByText("Sign in to Eliza Cloud"));
    await advance(() => screen.getByText("Set up your assistant"));

    // Scene 1 → permission card (real MessagePermissionCard). The real form
    // widget enforces its required field, so fill it before submitting.
    fireEvent.change(screen.getByLabelText(/what should i call you/i), {
      target: { value: "Shaw" },
    });
    tap(screen.getByText("Save profile"));
    await advance(() => screen.getByText(/quick permission/i));

    // Scene 2 → secret request (real SensitiveRequestBlock). The permission
    // card's fallback button routes through the real sendActionMessage
    // (`__permission_card__:use_fallback …`), which advances the script.
    tap(screen.getByTestId("permission-card-fallback"));
    await advance(() => screen.getByText(/connect a model provider key/i));

    // The secret scene releases the onboarding pin (its real submit needs the
    // API), so the composer is unlocked from here. The block still renders the
    // REAL secure input field.
    expect(screen.getAllByText(/API key/i).length).toBeGreaterThan(0);

    // Scene 3 → follow-ups widget (real followups chips) via composer send.
    const composer = screen.getByLabelText("message");
    fireEvent.change(composer, { target: { value: "skip for now" } });
    tap(screen.getByLabelText("send"));
    await advance(() => screen.getByText("Show me"));

    // Scene 4 → workflow widget.
    tap(screen.getByText("Show me"));
    await advance(() => screen.getByTestId("workflow-steps"));
    expect(screen.getByText("Ship mobile polish")).toBeTruthy();

    // Scene 5 → live activity: REAL ToolCallEventLog rows (success + running)
    // and the REAL collapsed ThinkingBlock.
    fireEvent.change(composer, { target: { value: "next" } });
    tap(screen.getByLabelText("send"));
    await advance(() => screen.getAllByTestId("tool-call-event-log"));
    expect(screen.getAllByTestId("tool-call-event-log")).toHaveLength(2);
    expect(screen.getByText("CALENDAR_FIND_EVENTS")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByRole("button", { name: /thinking/i })).toBeTruthy();

    // Scene 6 → checklist widget.
    fireEvent.change(composer, { target: { value: "next" } });
    tap(screen.getByLabelText("send"));
    await advance(() => screen.getByText("UX review"));

    // Scene 7 → real task widget + background picker.
    fireEvent.change(composer, { target: { value: "next" } });
    tap(screen.getByLabelText("send"));
    await advance(() => screen.getByTestId("task-widget"));
    expect(screen.getByText("Refine native chat glass")).toBeTruthy();

    // Scene 8 → code block.
    fireEvent.change(composer, { target: { value: "next" } });
    tap(screen.getByLabelText("send"));
    await advance(() => screen.getAllByTestId("code-block"));

    // Scene 9 → generated UI through the REAL GenUI renderer (a live Heading
    // element), not a raw JSON code block.
    fireEvent.change(composer, { target: { value: "next" } });
    tap(screen.getByLabelText("send"));
    await advance(() => screen.getByText("Interactive generated UI"));

    // Scene 10 → failure turn with the REAL retry affordance.
    fireEvent.change(composer, { target: { value: "next" } });
    tap(screen.getByLabelText("send"));
    await advance(() => screen.getByText(/temporarily busy/i));

    // Anti-larp: no raw widget markers may leak anywhere as literal text.
    const bodyText = document.body.textContent ?? "";
    for (const marker of [
      "[CHOICE",
      "[/CHOICE]",
      "[FORM]",
      "[FOLLOWUPS",
      "[WORKFLOW]",
      "[CHECKLIST]",
      "[TASK:",
      "[BACKGROUND]",
      "permission_request",
    ]) {
      expect(bodyText.includes(marker), `raw marker leaked: ${marker}`).toBe(
        false,
      );
    }
  }, 30000);
});

describe("ChatWidgetHarness native-transcript demo", () => {
  afterEach(() => {
    cleanup();
    localStorage.removeItem("eliza:native-transcript-demo");
    nativeTranscript.reset();
  });

  it("never touches the bridge when the demo flag is unset", async () => {
    render(<ChatWidgetHarness />);
    // Flush the async availability path the gate would take if it were on.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(nativeTranscript.frames).toHaveLength(0);
    expect(nativeTranscript.rects).toHaveLength(0);
    expect(nativeTranscript.actionHandler).toBeNull();
  });

  it("mirrors v1 frames whose message count tracks a scripted advance", async () => {
    localStorage.setItem("eliza:native-transcript-demo", "1");
    render(<ChatWidgetHarness />);

    await waitFor(() =>
      expect(nativeTranscript.frames.length).toBeGreaterThan(0),
    );
    const first = nativeTranscript.frames.at(-1);
    expect(first?.schema).toBe("eliza.native-transcript/v1");
    // The onboarding opening: greeting + sign-in choice.
    expect(first?.messages).toHaveLength(2);

    // The native list mounts over the TOP half of the screen; the DOM overlay
    // stays interactive below (side-by-side comparison mode).
    expect(nativeTranscript.rects.length).toBeGreaterThan(0);
    expect(nativeTranscript.rects[0]).toEqual({
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: Math.round(window.innerHeight / 2),
    });

    // A DOM widget tap (protocol action — no user echo) advances the script;
    // the mirrored frame gains exactly the scripted assistant reply.
    fireEvent.click(screen.getByText("Sign in to Eliza Cloud"));
    await waitFor(
      () => expect(screen.getByText(/Tell me a little/i)).toBeTruthy(),
      { timeout: 3000 },
    );
    await waitFor(() =>
      expect(nativeTranscript.frames.at(-1)?.messages).toHaveLength(3),
    );
    expect(
      nativeTranscript.frames
        .at(-1)
        ?.messages.at(-1)
        ?.segments.some((s) => s.kind === "widget" && s.widgetKind === "form"),
    ).toBe(true);
  });

  it("routes an injected transcriptAction through the same scripted advance as a DOM tap", async () => {
    localStorage.setItem("eliza:native-transcript-demo", "1");
    render(<ChatWidgetHarness />);
    await waitFor(() => expect(nativeTranscript.actionHandler).toBeTruthy());

    act(() => {
      nativeTranscript.actionHandler?.({ message: "show me widgets" });
    });

    // The next scene text appears exactly as it would after a DOM tap…
    await waitFor(
      () => expect(screen.getByText(/Tell me a little/i)).toBeTruthy(),
      { timeout: 3000 },
    );
    expect(screen.getByText("Set up your assistant")).toBeTruthy();

    // …and the mirrored frame carries the echoed user turn plus the reply.
    await waitFor(() =>
      expect(nativeTranscript.frames.at(-1)?.messages).toHaveLength(4),
    );
    const latest = nativeTranscript.frames.at(-1);
    const userTurn = latest?.messages.find((m) => m.role === "user");
    expect(userTurn?.segments).toEqual([
      { kind: "text", text: "show me widgets" },
    ]);
  });

  it("hides the native list and removes the listener on unmount", async () => {
    localStorage.setItem("eliza:native-transcript-demo", "1");
    const { unmount } = render(<ChatWidgetHarness />);
    await waitFor(() =>
      expect(nativeTranscript.rects.length).toBeGreaterThan(0),
    );

    unmount();

    await waitFor(() => {
      expect(nativeTranscript.hides).toBe(1);
      expect(nativeTranscript.removals).toBe(1);
    });
    expect(nativeTranscript.actionHandler).toBeNull();
  });
});
