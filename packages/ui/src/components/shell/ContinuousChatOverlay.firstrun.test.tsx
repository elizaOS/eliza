// @vitest-environment jsdom

// First-run onboarding gating for the floating chat overlay (`firstRunOpen`):
// the sheet opens pinned at FULL, every collapse path (Escape, outside tap,
// grabber pull-down/close) is a no-op, the composer (text/attach/voice/send) is
// locked while the transcript's CHOICE widgets stay interactive, and the sheet
// auto-collapses exactly once on the completion (falling) edge.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The resting overlay's suggestion strip fetches model suggestions via the
// shared client; stub it so the strip stays on its static fallback in tests.
vi.mock("../../api/client", () => ({
  client: {
    fetch: vi.fn().mockRejectedValue(new Error("no api in test")),
    createTranscript: vi
      .fn()
      .mockResolvedValue({ transcript: { id: "t1", title: "Transcript" } }),
  },
}));

vi.mock("../../utils/clipboard", () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
}));

import { CHAT_PREFILL_EVENT, TUTORIAL_CHAT_CONTROL_EVENT } from "../../events";
import { __setAppValueForTests } from "../../state/app-store";
import type { AppContextValue } from "../../state/internal";
import { resetShellSurfaceForTests } from "../../state/shell-surface-store";
import { setViewChatBinding } from "../../state/view-chat-binding";
import { ContinuousChatOverlay } from "./ContinuousChatOverlay";
import type { ShellController } from "./useShellController";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  resetShellSurfaceForTests();
  setViewChatBinding(null);
  __setAppValueForTests(null);
});

function makeController(
  overrides: Partial<ShellController> = {},
): ShellController {
  return {
    phase: "summoned",
    messages: [
      {
        id: "greeting",
        role: "assistant",
        content: "Hi — I'm Eliza. Let's get you set up.",
        createdAt: 1,
      },
    ],
    canSend: true,
    responding: false,
    turnStatus: null,
    recording: false,
    transcript: "",
    transcriptionMode: false,
    modelStatus: { kind: "ready" },
    send: vi.fn(),
    stop: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    toggleRecording: vi.fn(),
    handsFree: false,
    toggleHandsFree: vi.fn(),
    toggleTranscriptionMode: vi.fn(),
    stopTranscriptionAndMic: vi.fn(),
    setDictationSink: vi.fn(),
    setTranscriptSessionSink: vi.fn(),
    setComposerHasDraft: vi.fn(),
    clearConversation: vi.fn(),
    ...overrides,
  } as unknown as ShellController;
}

const RUNTIME_CHOICE_MESSAGE = [
  "Hi — I'm Eliza. First, where should your agent run?",
  "",
  "[CHOICE:first-run id=runtime]",
  "__first_run__:runtime:cloud=Eliza Cloud (managed)",
  "__first_run__:runtime:local=On this device",
  "[/CHOICE]",
].join("\n");

/** Seed the app-store with a spied `sendActionMessage` (all else inert). */
function seedAppStoreWithActionSpy(): ReturnType<typeof vi.fn> {
  const sendActionMessage = vi.fn().mockResolvedValue(undefined);
  const noop = () => {};
  const value = new Proxy({} as AppContextValue, {
    get(_target, prop) {
      if (prop === "sendActionMessage") return sendActionMessage;
      if (prop === "t") return (k: string) => k;
      if (prop === "uiLanguage") return "en";
      return noop;
    },
  });
  __setAppValueForTests(value);
  return sendActionMessage;
}

describe("ContinuousChatOverlay first-run gating", () => {
  it("pins the sheet OPEN during onboarding so the seeded choices are visible (not hidden behind a collapsed grabber)", () => {
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} firstRunOpen />);

    // firstRunOpen must force the sheet open structurally — the mount/effect
    // openness was raceable and could settle collapsed, leaving the frozen
    // composer's "tap an option above" hint pointing at nothing.
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(screen.getByTestId("chat-thread")).toBeTruthy();
  });

  it("locks the composer during onboarding: disabled textarea with a choice placeholder, attach + mic inert", () => {
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} firstRunOpen />);

    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe(
      "Tap a highlighted option above to continue",
    );

    const attach = screen.getByTestId("chat-composer-attach");
    expect(attach.getAttribute("aria-disabled")).toBe("true");

    const mic = screen.getByTestId("chat-composer-mic");
    expect(mic.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(mic);
    fireEvent.pointerDown(mic, { pointerId: 1 });
    expect(controller.startRecording).not.toHaveBeenCalled();
    expect(controller.toggleRecording).not.toHaveBeenCalled();
    expect(controller.toggleHandsFree).not.toHaveBeenCalled();
  });

  it("keeps the send control disabled during onboarding even when a prefill lands a draft", () => {
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} firstRunOpen />);

    // CHAT_PREFILL_EVENT is a real non-keyboard draft entry point; it must not
    // become a send path around the disabled textarea.
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CHAT_PREFILL_EVENT, {
          detail: { text: "free text mid-onboarding" },
        }),
      );
    });

    const send = screen.getByTestId("chat-composer-action");
    expect(send.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(send);
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("opens pinned at FULL and ignores Escape while onboarding is active", () => {
    render(
      <ContinuousChatOverlay controller={makeController()} firstRunOpen />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(sheet.getAttribute("data-detent")).toBe("full");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(sheet.getAttribute("data-detent")).toBe("full");
  });

  it("ignores an outside tap while onboarding is active", () => {
    render(
      <ContinuousChatOverlay controller={makeController()} firstRunOpen />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-variant")).toBe("open");

    fireEvent.pointerDown(document.body, {
      pointerId: 7,
      clientX: 4,
      clientY: 4,
    });
    fireEvent.pointerUp(document.body, {
      pointerId: 7,
      clientX: 4,
      clientY: 4,
    });
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(sheet.getAttribute("data-detent")).toBe("full");
  });

  it("ignores grabber pull-down and keyboard close while onboarding is active", () => {
    render(
      <ContinuousChatOverlay controller={makeController()} firstRunOpen />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    expect(sheet.getAttribute("data-variant")).toBe("open");

    // Keyboard close paths on the grabber (Enter toggles, ArrowDown/Escape close).
    fireEvent.keyDown(grabber, { key: "Escape" });
    fireEvent.keyDown(grabber, { key: "ArrowDown" });
    fireEvent.keyDown(grabber, { key: "Enter" });
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(sheet.getAttribute("data-detent")).toBe("full");

    // A deliberate downward drag on the grabber (pull-down collapse gesture).
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 2 });
    fireEvent.pointerMove(grabber, { clientY: 420, pointerId: 2 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 2 });
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(sheet.getAttribute("data-detent")).toBe("full");
  });

  it("ignores tutorial chat-control events (rest/reset/prefill) while onboarding is active", () => {
    render(
      <ContinuousChatOverlay controller={makeController()} firstRunOpen />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-detent")).toBe("full");

    // The one collapse seam outside the gated funnel: a stray tour-control
    // event must not collapse or un-pill the onboarding sheet.
    for (const action of ["rest", "reset", "pill", "prefill"]) {
      act(() => {
        window.dispatchEvent(
          new CustomEvent(TUTORIAL_CHAT_CONTROL_EVENT, {
            detail: { action, text: "x" },
          }),
        );
      });
    }
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(sheet.getAttribute("data-detent")).toBe("full");
    // The composer stays locked (prefill did not open a send path).
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
  });

  it("keeps the transcript CHOICE widgets interactive while the composer is locked", () => {
    const sendActionMessage = seedAppStoreWithActionSpy();
    const controller = makeController({
      messages: [
        {
          id: "first-run:greeting",
          role: "assistant",
          content: RUNTIME_CHOICE_MESSAGE,
          createdAt: 1,
        },
      ],
    } as unknown as Partial<ShellController>);
    render(<ContinuousChatOverlay controller={controller} firstRunOpen />);

    const localChoice = screen.getByTestId(
      "choice-__first_run__:runtime:local",
    );
    expect(localChoice.hasAttribute("disabled")).toBe(false);
    fireEvent.click(localChoice);
    expect(sendActionMessage).toHaveBeenCalledWith(
      "__first_run__:runtime:local",
    );
  });

  it("auto-collapses exactly once on the completion edge, unlocks the composer, and re-arms Escape", () => {
    const controller = makeController();
    const { rerender } = render(
      <ContinuousChatOverlay controller={controller} firstRunOpen />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    const overlay = screen.getByTestId("continuous-chat-overlay");
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(overlay.getAttribute("data-open")).toBe("true");

    // Onboarding completes: firstRunOpen falls true → false.
    rerender(
      <ContinuousChatOverlay controller={controller} firstRunOpen={false} />,
    );
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(overlay.hasAttribute("data-open")).toBe(false);

    // The composer unlocks.
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe("Ask Eliza");

    // Re-open (type-to-open); a later re-render with onboarding still complete
    // must NOT collapse again — the collapse is a one-shot falling edge.
    fireEvent.focus(input);
    expect(sheet.getAttribute("data-variant")).toBe("open");
    rerender(
      <ContinuousChatOverlay controller={controller} firstRunOpen={false} />,
    );
    expect(sheet.getAttribute("data-variant")).toBe("open");

    // The collapse gate is released: Escape closes the sheet again.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("never auto-collapses a session where onboarding was not active", () => {
    const controller = makeController();
    const { rerender } = render(
      <ContinuousChatOverlay controller={controller} firstRunOpen={false} />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    rerender(
      <ContinuousChatOverlay controller={controller} firstRunOpen={false} />,
    );
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });
});
