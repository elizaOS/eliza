/** Verifies ChatOverlay first-run gating through the package's configured test harness. */
// @vitest-environment jsdom

// First-run onboarding gating for the floating chat overlay (`firstRunOpen`):
// the sheet opens pinned at the shared HALF composer detent, every collapse path
// (Escape, outside tap, drag/close) is a no-op, the drag handle is hidden, the
// composer accepts conductor-only text, transcript CHOICE widgets stay interactive,
// external sign-in minimizes to the regular compact composer, and completion
// opens the conversation at FULL.

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
    getBaseUrl: vi.fn().mockReturnValue("http://localhost:3000"),
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
import {
  FIRST_RUN_GREETING,
  FIRST_RUN_SIGN_IN_PROMPT,
} from "../../first-run/first-run-greeting";
import { __setAppValueForTests } from "../../state/app-store";
import type { AppContextValue } from "../../state/internal";
import { resetShellSurfaceForTests } from "../../state/shell-surface-store";
import { setViewChatBinding } from "../../state/view-chat-binding";
import { ChatOverlay } from "./ChatOverlay";
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
        content: "Hi, I’m Eliza. Sign in to Eliza Cloud to get started.",
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
  "Hi, I'm Eliza. First, where should your agent run?",
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

describe("ChatOverlay first-run gating", () => {
  it("pins the sheet OPEN during onboarding so the seeded choices are visible (not hidden behind a collapsed grabber)", () => {
    const controller = makeController();
    render(<ChatOverlay controller={controller} firstRunOpen />);

    // firstRunOpen must force the sheet open structurally — the mount/effect
    // openness was raceable and could settle collapsed, leaving the frozen
    // composer's "tap an option above" hint pointing at nothing.
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(screen.getByTestId("chat-thread")).toBeTruthy();
  });

  it("accepts conductor text during onboarding while attach + mic stay inert", () => {
    const controller = makeController();
    render(<ChatOverlay controller={controller} firstRunOpen />);

    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe("Hey Eliza…");
    expect(input.getAttribute("aria-describedby")).toBe("cc-first-run-hint");
    expect(screen.getByText(/answer stays in setup/i)).toBeTruthy();

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

  it("describes the active Cloud connection instead of asking for sign-in again", () => {
    const controller = makeController({
      messages: [
        {
          id: "first-run:cloud-connecting",
          role: "assistant",
          content: "Opening your personal Eliza…",
          createdAt: 2,
        },
      ],
    } as unknown as Partial<ShellController>);

    render(<ChatOverlay controller={controller} firstRunOpen />);

    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(input.placeholder).toBe("Connecting to Eliza Cloud…");
  });

  it("does not describe a failed Cloud connection as still connecting", () => {
    const controller = makeController({
      messages: [
        {
          id: "first-run:cloud-error",
          role: "assistant",
          content:
            "I couldn't finish setting up your agent: Couldn't connect to Eliza Cloud: session expired.",
          createdAt: 2,
        },
      ],
    } as unknown as Partial<ShellController>);

    render(<ChatOverlay controller={controller} firstRunOpen />);

    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(input.placeholder).toBe("Hey Eliza…");
  });

  it("ignores external prefill during onboarding while direct typing stays local", () => {
    const sendActionMessage = seedAppStoreWithActionSpy();
    const controller = makeController();
    render(<ChatOverlay controller={controller} firstRunOpen />);

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

  it("routes typed text to the onboarding conductor without sending to the agent", () => {
    const sendFirstRunText = vi.fn();
    const controller = makeController({ sendFirstRunText });
    render(<ChatOverlay controller={controller} firstRunOpen />);

    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "will this work yet?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(sendFirstRunText).toHaveBeenCalledWith("will this work yet?");
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("does not mount a first-run full-screen backdrop", () => {
    const controller = makeController();
    render(<ChatOverlay controller={controller} firstRunOpen />);

    expect(screen.queryByTestId("chat-first-run-backdrop")).toBeNull();
  });

  it("uses the same visible half-height shell as post-onboarding chat", () => {
    const onStateChange = vi.fn();
    const controller = makeController();
    const { rerender } = render(
      <ChatOverlay
        controller={controller}
        firstRunOpen
        onStateChange={onStateChange}
      />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-maximized")).toBeNull();
    expect(sheet.getAttribute("data-chat-state")).toBe("OPEN_HALF_OR_OVER");
    expect(sheet.getAttribute("data-detent")).toBe("half");
    expect(onStateChange).toHaveBeenLastCalledWith("OPEN_HALF_OR_OVER");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    expect(grabber.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByTestId("chat-first-run-grabber")).toBeNull();
    expect(screen.getByTestId("chat-sheet-rim")).toBeTruthy();
    // Onboarding owns the first card at the top of the transcript, so the
    // ordinary-chat dissolve must not obscure its choice controls. Once the
    // gate clears, the regular transcript owns that decorative fade again.
    expect(screen.queryByTestId("chat-thread-top-fade")).toBeNull();
    rerender(
      <ChatOverlay
        controller={controller}
        firstRunOpen={false}
        onStateChange={onStateChange}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    expect(screen.getByTestId("chat-thread-top-fade")).toBeTruthy();
    expect(screen.queryByTestId("chat-maximize-restore-zone")).toBeNull();
  });

  it("keeps first-run onboarding in the overlay's dark color scheme", () => {
    render(<ChatOverlay controller={makeController()} firstRunOpen />);

    const sheet = screen.getByTestId("chat-sheet");
    const surface = screen.getByTestId("chat-sheet-surface");
    expect(sheet.getAttribute("data-theme")).toBe("dark");
    expect(sheet.style.colorScheme).toBe("dark");
    expect(surface.style.backgroundColor).toBe("var(--chat-sheet-background)");
    expect(surface.style.getPropertyValue("--chat-sheet-background")).toBe(
      "var(--bg)",
    );
  });

  it("fills a desktop bottom-bar host so transparent native pixels cannot block other apps", () => {
    render(
      <ChatOverlay controller={makeController()} firstRunOpen fillHostAtHalf />,
    );

    const sheet = screen.getByTestId("chat-sheet");
    const thread = screen.getByTestId("chat-thread");
    expect(sheet.style.maxHeight).toBe("756px");
    expect(thread.style.flexBasis).toBe("756px");
  });

  it("does not apply the phone-landscape narrow width to the shallow desktop host", () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 96,
    });
    try {
      render(
        <ChatOverlay
          controller={makeController()}
          fillHostAtHalf
          initialMode="input"
        />,
      );
      expect(
        screen.getByTestId("chat-sheet").parentElement?.style.maxWidth,
      ).toBe("768px");
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: originalHeight,
      });
    }
  });

  it("opens pinned at HALF and ignores Escape while onboarding is active", () => {
    render(<ChatOverlay controller={makeController()} firstRunOpen />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(sheet.getAttribute("data-detent")).toBe("half");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(sheet.getAttribute("data-detent")).toBe("half");
  });

  it("opens a completed desktop session at the shared half-height composer", () => {
    const controller = makeController();
    render(<ChatOverlay controller={controller} initialMode="half" />);

    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-detent")).toBe("half");
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(input);
    input.focus();
    fireEvent.change(input, { target: { value: "Hello again" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(controller.send).toHaveBeenCalledWith("Hello again");
  });

  it("never lets the desktop pill host expand into a full-window chat surface", () => {
    const onStateChange = vi.fn();
    render(
      <ChatOverlay
        controller={makeController()}
        fillHostAtHalf
        initialMode="half"
        onStateChange={onStateChange}
      />,
    );

    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 760, pointerId: 17 });
    fireEvent.pointerMove(grabber, { clientY: 400, pointerId: 17 });
    fireEvent.pointerMove(grabber, { clientY: 40, pointerId: 17 });
    fireEvent.pointerMove(grabber, { clientY: 0, pointerId: 17 });
    fireEvent.pointerUp(grabber, { clientY: 0, pointerId: 17 });

    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-maximized")).toBeNull();
    expect(sheet.getAttribute("data-chat-state")).toBe("OPEN_HALF_OR_OVER");
    expect(onStateChange).not.toHaveBeenCalledWith("MAXIMIZED");
  });

  it("ignores an outside tap while onboarding is active", () => {
    render(<ChatOverlay controller={makeController()} firstRunOpen />);
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
    expect(sheet.getAttribute("data-detent")).toBe("half");
  });

  it("keeps the normal sheet handle visible but inert at the half detent", () => {
    render(<ChatOverlay controller={makeController()} firstRunOpen />);
    const sheet = screen.getByTestId("chat-sheet");
    const handle = screen.getByTestId("chat-sheet-grabber");
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(screen.queryByTestId("chat-first-run-grabber")).toBeNull();
    expect(handle.getAttribute("aria-disabled")).toBe("true");
    expect(handle.getAttribute("aria-hidden")).toBe("true");
    expect(handle.getAttribute("tabindex")).toBe("-1");
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(sheet.getAttribute("data-detent")).toBe("half");
  });

  it("keeps transcript CHOICE widgets interactive beside conductor text input", () => {
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
    render(<ChatOverlay controller={controller} firstRunOpen />);

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

  it("keeps the active setup choice visible after a conductor text reply", () => {
    seedAppStoreWithActionSpy();
    const controller = makeController({
      messages: [
        {
          id: "first-run:greeting",
          role: "assistant",
          content: RUNTIME_CHOICE_MESSAGE,
          createdAt: 1,
          source: "first_run",
        },
        {
          id: "first-run:user:1",
          role: "user",
          content: "Plan my Monday.",
          createdAt: 2,
          source: "first_run",
        },
        {
          id: "first-run:reply:choice:1",
          role: "assistant",
          content: "Choose above and I'll pick that up after setup.",
          createdAt: 3,
          source: "first_run",
        },
      ],
    } as unknown as Partial<ShellController>);

    render(<ChatOverlay controller={controller} firstRunOpen />);

    expect(
      screen.getByTestId("choice-__first_run__:runtime:cloud"),
    ).toBeTruthy();
    expect(
      screen.getByText("Choose above and I'll pick that up after setup."),
    ).toBeTruthy();
  });

  it("does not revive a stale setup choice while provisioning", () => {
    seedAppStoreWithActionSpy();
    const controller = makeController({
      messages: [
        {
          id: "first-run:greeting",
          role: "assistant",
          content: RUNTIME_CHOICE_MESSAGE,
          createdAt: 1,
          source: "first_run",
        },
        {
          id: "first-run:user:1",
          role: "user",
          content: "Plan my Monday.",
          createdAt: 2,
          source: "first_run",
        },
        {
          id: "first-run:reply:wait:1",
          role: "assistant",
          content: "I'm setting up your agent now.",
          createdAt: 3,
          source: "first_run",
        },
      ],
    } as unknown as Partial<ShellController>);

    render(<ChatOverlay controller={controller} firstRunOpen />);

    expect(
      screen.queryByTestId("choice-__first_run__:runtime:cloud"),
    ).toBeNull();
    expect(screen.getByText("I'm setting up your agent now.")).toBeTruthy();
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
    render(<ChatOverlay controller={controller} firstRunOpen />);

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
    render(<ChatOverlay controller={controller} firstRunOpen />);

    const message = screen.getByTestId("thread-line");
    expect(message.getAttribute("data-role")).toBe("assistant");
    expect(
      screen.getByText("Hi, I'm Eliza. First, where should your agent run?"),
    ).toBeTruthy();
    expect(screen.queryByText("Agent")).toBeNull();
  });

  it("renders the established greeting and sign-in bubbles if onboarding opens before the conductor seeds messages", () => {
    vi.useFakeTimers();
    seedAppStoreWithActionSpy();
    try {
      render(<ChatOverlay controller={makeController()} firstRunOpen />);

      expect(screen.queryByText(FIRST_RUN_GREETING)).toBeNull();

      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(screen.getAllByTestId("thread-line")[0]?.textContent).toContain(
        FIRST_RUN_GREETING,
      );
      expect(screen.getAllByTestId("thread-line")[1]?.textContent).toContain(
        FIRST_RUN_SIGN_IN_PROMPT,
      );
      expect(screen.getAllByText("Sign in to Eliza Cloud")).toHaveLength(1);
      // Both prompts are ordinary assistant rows in the shared transcript,
      // never a special setup panel below the composer.
      expect(screen.getAllByTestId("thread-line")).toHaveLength(2);
      expect(
        screen.getByTestId("choice-__first_run__:runtime:cloud"),
      ).toBeTruthy();
      const composer = screen.getByTestId(
        "chat-composer-textarea",
      ) as HTMLTextAreaElement;
      expect(composer.disabled).toBe(true);
      expect(composer.placeholder).toBe("Sign in to get started");
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
        <ChatOverlay controller={makeController()} firstRunOpen />,
      );

      act(() => {
        vi.advanceTimersByTime(300);
      });

      rerender(
        <ChatOverlay
          controller={makeController({
            messages: [realGreeting],
          } as unknown as Partial<ShellController>)}
          firstRunOpen
        />,
      );

      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(screen.getByTestId("thread-line").textContent).toContain(
        FIRST_RUN_GREETING,
      );
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
          content: FIRST_RUN_GREETING,
          createdAt: 1,
        },
        {
          id: "first-run:cloud-oauth",
          role: "assistant",
          content: [
            FIRST_RUN_SIGN_IN_PROMPT,
            "",
            "[CHOICE:first-run id=runtime]",
            "__first_run__:runtime:cloud=Sign in to Eliza Cloud",
            "[/CHOICE]",
          ].join("\n"),
          createdAt: 2,
        },
      ],
    } as unknown as Partial<ShellController>);

    render(<ChatOverlay controller={controller} firstRunOpen />);

    const signIn = screen.getByText("Sign in to Eliza Cloud");
    expect(signIn.closest('[data-chat-message-bubble="true"]')).toBeTruthy();
    expect(screen.getAllByTestId("thread-line")[0]?.textContent).toContain(
      FIRST_RUN_GREETING,
    );
    expect(screen.getAllByTestId("thread-line").at(-1)?.textContent).toContain(
      FIRST_RUN_SIGN_IN_PROMPT,
    );
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
      <ChatOverlay controller={controller} firstRunOpen />,
    );
    const probe = screen.getByTestId("onboarding-state-probe");
    expect(probe.textContent).toContain("onboarding-step:runtime");
    expect(probe.textContent).toContain("__first_run__:runtime:cloud");
    expect(probe.textContent).toContain("__first_run__:runtime:remote");

    // Once onboarding completes the probe is gone.
    rerender(<ChatOverlay controller={controller} firstRunOpen={false} />);
    expect(screen.queryByTestId("onboarding-state-probe")).toBeNull();
  });

  it("uses the regular compact composer during external sign-in, then opens full on authentication", () => {
    const waitingController = makeController({
      messages: [
        {
          id: "first-run:cloud-login-waiting",
          role: "assistant",
          content:
            "Waiting for sign-in in the browser we opened… Finish there, then this chat will continue.",
          createdAt: 2,
        },
      ],
    } as unknown as Partial<ShellController>);
    const onStateChange = vi.fn();
    const { rerender } = render(
      <ChatOverlay
        controller={waitingController}
        firstRunOpen
        onStateChange={onStateChange}
      />,
    );
    const sheet = screen.getByTestId("chat-sheet");

    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    expect(sheet.getAttribute("data-chat-state")).toBe("INPUT");
    expect(onStateChange).toHaveBeenLastCalledWith("INPUT");
    expect(screen.getByTestId("chat-composer-plus")).toBeTruthy();
    expect(
      (screen.getByTestId("chat-composer-textarea") as HTMLTextAreaElement)
        .placeholder,
    ).toBe("Waiting for sign-in…");
    expect(screen.getByTestId("chat-pill").getAttribute("aria-hidden")).toBe(
      "true",
    );

    // The compact composer is an initial state, not a trap: clicking the
    // read-only waiting field reopens the shared transcript where the immediate
    // retry action lives. This must not depend on a fresh focus event because a
    // read-only field can already own focus when the user clicks it again.
    fireEvent.click(screen.getByTestId("chat-composer-textarea"));
    expect(sheet.getAttribute("data-detent")).toBe("half");
    expect(sheet.getAttribute("data-chat-state")).toBe("OPEN_HALF_OR_OVER");

    rerender(
      <ChatOverlay
        controller={waitingController}
        firstRunOpen={false}
        releaseFirstRunToFull
        onStateChange={onStateChange}
      />,
    );
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(sheet.getAttribute("data-detent")).toBe("full");
    expect(onStateChange).toHaveBeenLastCalledWith("OPEN_HALF_OR_OVER");
  });

  it("never idle-collapses first-run sign-in recovery into the handle-only pill", () => {
    vi.useFakeTimers();
    try {
      const waitingController = makeController({
        messages: [
          {
            id: "first-run:cloud-login-waiting",
            role: "assistant",
            content:
              "Waiting for sign-in in the browser we opened… Finish there, then this chat will continue.",
            createdAt: 2,
          },
        ],
      } as unknown as Partial<ShellController>);
      render(
        <ChatOverlay
          controller={waitingController}
          firstRunOpen
          fillHostAtHalf
        />,
      );
      const sheet = screen.getByTestId("chat-sheet");
      expect(sheet.getAttribute("data-detent")).toBe("collapsed");

      act(() => vi.advanceTimersByTime(30_000));
      expect(sheet.getAttribute("data-detent")).toBe("collapsed");
      expect(sheet.getAttribute("data-chat-state")).toBe("INPUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reopens half when an external sign-in attempt expires with a retry choice", () => {
    const retryController = makeController({
      messages: [
        {
          id: "first-run:cloud-login-waiting",
          role: "assistant",
          content:
            "That sign-in window didn't finish. Otherwise, try again: [CHOICE:first-run id=runtime]",
          createdAt: 3,
        },
      ],
    } as unknown as Partial<ShellController>);

    render(<ChatOverlay controller={retryController} firstRunOpen />);

    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(sheet.getAttribute("data-detent")).toBe("half");
  });

  it("opens full exactly once on the completion edge, unlocks the composer, and re-arms Escape", () => {
    const controller = makeController();
    const { rerender } = render(
      <ChatOverlay controller={controller} firstRunOpen />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    const overlay = screen.getByTestId("chat-overlay");
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(overlay.getAttribute("data-open")).toBe("true");

    // Onboarding completes with the parent's mounted transcript-epoch proof.
    rerender(
      <ChatOverlay
        controller={controller}
        firstRunOpen={false}
        releaseFirstRunToFull
      />,
    );
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(sheet.getAttribute("data-detent")).toBe("full");
    expect(overlay.getAttribute("data-open")).toBe("true");

    // The composer unlocks.
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe("Message Eliza");
    input.focus();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "What should I do next?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(controller.send).toHaveBeenCalledWith("What should I do next?");

    // A later re-render with onboarding still complete must NOT force another
    // detent change — the full-open is a one-shot falling edge.
    fireEvent.focus(input);
    expect(sheet.getAttribute("data-variant")).toBe("open");
    rerender(<ChatOverlay controller={controller} firstRunOpen={false} />);
    expect(sheet.getAttribute("data-variant")).toBe("open");

    // The collapse gate is released: Escape closes the sheet again.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("returns to INPUT when a false probe clears without mounted transcript authority", () => {
    const controller = makeController();
    const { rerender } = render(
      <ChatOverlay controller={controller} firstRunOpen />,
    );

    rerender(<ChatOverlay controller={controller} firstRunOpen={false} />);

    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    expect(sheet.getAttribute("data-chat-state")).toBe("INPUT");
  });

  it("never auto-collapses a session where onboarding was not active", () => {
    const controller = makeController();
    const { rerender } = render(
      <ChatOverlay controller={controller} firstRunOpen={false} />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    rerender(<ChatOverlay controller={controller} firstRunOpen={false} />);
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("settles a remounted overlay when the parent retained the completion edge", () => {
    const onHandled = vi.fn();
    render(
      <ChatOverlay
        controller={makeController()}
        firstRunOpen={false}
        releaseFirstRunToFull
        onFirstRunReleaseHandled={onHandled}
      />,
    );

    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-detent")).toBe("full");
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(onHandled).toHaveBeenCalledTimes(1);
  });
});
