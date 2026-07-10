// @vitest-environment jsdom

// First-run onboarding gating for the floating chat overlay (`firstRunOpen`):
// the sheet opens pinned at FULL/MAXIMIZED with an OPAQUE backdrop, every
// collapse path (Escape, outside tap, drag/close) is a no-op, the drag handle is
// hidden, the composer is sign-in-first/locked, transcript CHOICE widgets stay
// interactive, and the sheet drops from full to the half detent (with the
// backdrop fading to the normal scrim) exactly once on the completion edge.

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

import { CHAT_PREFILL_EVENT } from "../../events";
import { FIRST_RUN_GREETING } from "../../first-run/first-run-greeting";
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
  "__first_run__:runtime:remote=Connect to a remote agent",
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

  it("locks the composer text during onboarding with a sign-in placeholder; attach + mic stay inert", () => {
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} firstRunOpen />);

    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("Sign in to start chatting");

    // The composer actions ("+") menu + mic have no agent to serve them yet —
    // still inert (pre-runtime). The "+" trigger is natively disabled.
    const plus = screen.getByTestId("chat-composer-plus");
    expect((plus as HTMLButtonElement).disabled).toBe(true);

    const mic = screen.getByTestId("chat-composer-mic");
    expect(mic.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(mic);
    fireEvent.pointerDown(mic, { pointerId: 1 });
    expect(controller.startRecording).not.toHaveBeenCalled();
    expect(controller.toggleRecording).not.toHaveBeenCalled();
    expect(controller.toggleHandsFree).not.toHaveBeenCalled();
  });

  it("ignores prefill/free-text entry during onboarding so setup stays sign-in-first", () => {
    const sendActionMessage = seedAppStoreWithActionSpy();
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} firstRunOpen />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(CHAT_PREFILL_EVENT, {
          detail: { text: "free text mid-onboarding" },
        }),
      );
    });

    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(input.value).toBe("");
    expect(screen.queryByTestId("chat-composer-action")).toBeNull();
    expect(controller.send).not.toHaveBeenCalled();
    expect(sendActionMessage).not.toHaveBeenCalled();
  });

  it("does not submit typed text with Enter while the onboarding composer is locked", () => {
    const sendActionMessage = seedAppStoreWithActionSpy();
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} firstRunOpen />);

    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "will this work yet?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(sendActionMessage).not.toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("paints an OPAQUE bg-bg backdrop while onboarding is open (no launcher/home shows through)", () => {
    render(
      <ContinuousChatOverlay controller={makeController()} firstRunOpen />,
    );
    const backdrop = screen.getByTestId("chat-first-run-backdrop");
    expect(backdrop.getAttribute("data-first-run-opaque")).toBe("true");
    expect(backdrop.className).toContain("bg-bg");
  });

  it("drops the opaque backdrop off its opaque state on the completion edge (revealing the launcher)", () => {
    const controller = makeController();
    const { rerender } = render(
      <ContinuousChatOverlay controller={controller} firstRunOpen />,
    );
    expect(
      screen
        .getByTestId("chat-first-run-backdrop")
        .getAttribute("data-first-run-opaque"),
    ).toBe("true");

    // Onboarding completes: the opaque layer fades to the normal scrim (or has
    // already unmounted under reduced-motion) — either way it is no longer the
    // full-opacity launcher-hiding layer.
    rerender(
      <ContinuousChatOverlay controller={controller} firstRunOpen={false} />,
    );
    const after = screen.queryByTestId("chat-first-run-backdrop");
    expect(after?.getAttribute("data-first-run-opaque") ?? "false").not.toBe(
      "true",
    );
  });

  it("opens edge-to-edge full-bleed (maximized) during onboarding without drag affordances", () => {
    render(
      <ContinuousChatOverlay controller={makeController()} firstRunOpen />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    // The login/first-run chat is full-screen: full-bleed edge-to-edge.
    expect(sheet.getAttribute("data-maximized")).toBe("true");
    expect(sheet.getAttribute("data-chat-state")).toBe("MAXIMIZED");
    expect(screen.queryByTestId("chat-sheet-grabber")).toBeNull();
    expect(screen.queryByTestId("chat-maximize-restore-zone")).toBeNull();
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

  it("does not render the grabber while onboarding is active", () => {
    render(
      <ContinuousChatOverlay controller={makeController()} firstRunOpen />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(screen.queryByTestId("chat-sheet-grabber")).toBeNull();
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(sheet.getAttribute("data-detent")).toBe("full");
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

    // All three location chips render — including the Remote third option.
    expect(
      screen.getByTestId("choice-__first_run__:runtime:remote"),
    ).toBeTruthy();
    const localChoice = screen.getByTestId(
      "choice-__first_run__:runtime:local",
    );
    expect(localChoice.hasAttribute("disabled")).toBe(false);
    fireEvent.click(localChoice);
    expect(sendActionMessage).toHaveBeenCalledWith(
      "__first_run__:runtime:local",
    );
  });

  it("does NOT wrap a first-run CHOICE turn in a role=button bubble (keeps the choices in the AX tree for VoiceOver + on-device automation)", () => {
    seedAppStoreWithActionSpy();
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

    // The tap-to-reveal bubble wrapper (a role=button with a "message actions"
    // label) collapses its subtree into a single atomic AX node in WKWebView,
    // hiding the choices. A choice-bearing turn must therefore NOT render it.
    expect(
      screen.queryByRole("button", { name: /message actions/i }),
    ).toBeNull();
    // The choice buttons stay individually present + focusable (not tabIndex -1).
    const cloud = screen.getByTestId("choice-__first_run__:runtime:cloud");
    expect(cloud.closest('[role="button"]')).toBeNull();
    expect(cloud.getAttribute("tabindex")).not.toBe("-1");
  });

  it("renders onboarding transcript turns through the normal thread row", () => {
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

    const message = screen.getByTestId("thread-line");
    expect(message.getAttribute("data-role")).toBe("assistant");
    expect(
      screen.getByText("Hi — I'm Eliza. First, where should your agent run?"),
    ).toBeTruthy();
    expect(screen.queryByText("Agent")).toBeNull();
  });

  it("renders one fallback sign-in turn if onboarding opens before the conductor seeds messages", () => {
    vi.useFakeTimers();
    seedAppStoreWithActionSpy();
    try {
      render(
        <ContinuousChatOverlay controller={makeController()} firstRunOpen />,
      );

      expect(screen.queryByText(FIRST_RUN_GREETING)).toBeNull();

      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(screen.getByText(FIRST_RUN_GREETING)).toBeTruthy();
      expect(screen.getAllByText("Sign in to Eliza Cloud")).toHaveLength(1);
      expect(
        screen.getByTestId("choice-__first_run__:runtime:cloud"),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the fallback if the conductor seeds the real sign-in greeting first", () => {
    vi.useFakeTimers();
    seedAppStoreWithActionSpy();
    const realGreeting = {
      id: "first-run:greeting",
      role: "assistant",
      content: [
        FIRST_RUN_GREETING,
        "",
        "[CHOICE:first-run id=runtime]",
        "__first_run__:runtime:cloud=Sign in to Eliza Cloud",
        "[/CHOICE]",
      ].join("\n"),
      createdAt: 1,
    } as const;

    try {
      const { rerender } = render(
        <ContinuousChatOverlay controller={makeController()} firstRunOpen />,
      );

      act(() => {
        vi.advanceTimersByTime(300);
      });

      rerender(
        <ContinuousChatOverlay
          controller={makeController({
            messages: [realGreeting],
          } as unknown as Partial<ShellController>)}
          firstRunOpen
        />,
      );

      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(screen.getByText(FIRST_RUN_GREETING)).toBeTruthy();
      expect(screen.getAllByText("Sign in to Eliza Cloud")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows only the latest first-run sign-in turn so stale greetings do not create a second sign-in", () => {
    seedAppStoreWithActionSpy();
    const controller = makeController({
      messages: [
        {
          id: "first-run:greeting",
          role: "assistant",
          content: [
            FIRST_RUN_GREETING,
            "",
            "[CHOICE:first-run id=runtime]",
            "__first_run__:runtime:cloud=Sign in to Eliza Cloud",
            "[/CHOICE]",
          ].join("\n"),
          createdAt: 1,
        },
        {
          id: "first-run:cloud-oauth",
          role: "assistant",
          content: [
            FIRST_RUN_GREETING,
            "",
            "[CHOICE:first-run id=runtime]",
            "__first_run__:runtime:cloud=Sign in to Eliza Cloud",
            "[/CHOICE]",
          ].join("\n"),
          createdAt: 2,
        },
      ],
    } as unknown as Partial<ShellController>);

    render(<ContinuousChatOverlay controller={controller} firstRunOpen />);

    expect(screen.getAllByText("Sign in to Eliza Cloud")).toHaveLength(1);
    expect(screen.queryAllByText(FIRST_RUN_GREETING).length).toBe(1);
  });

  it("exposes the sr-only onboarding-state probe with the current step + choice ids while onboarding is open", () => {
    seedAppStoreWithActionSpy();
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
    const { rerender } = render(
      <ContinuousChatOverlay controller={controller} firstRunOpen />,
    );
    const probe = screen.getByTestId("onboarding-state-probe");
    expect(probe.textContent).toContain("onboarding-step:runtime");
    expect(probe.textContent).toContain("__first_run__:runtime:cloud");
    expect(probe.textContent).toContain("__first_run__:runtime:remote");

    // Once onboarding completes the probe is gone.
    rerender(
      <ContinuousChatOverlay controller={controller} firstRunOpen={false} />,
    );
    expect(screen.queryByTestId("onboarding-state-probe")).toBeNull();
  });

  it("settles to half exactly once on the completion edge, unlocks the composer, and re-arms Escape", () => {
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
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(sheet.getAttribute("data-detent")).toBe("half");
    expect(overlay.getAttribute("data-open")).toBe("true");

    // The composer unlocks.
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe("Ask Eliza");

    // A later re-render with onboarding still complete must NOT force another
    // detent change — the half-settle is a one-shot falling edge.
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
