// @vitest-environment jsdom

// First-run onboarding gating for the floating chat overlay (`firstRunOpen`):
// the sheet opens pinned at FULL with an OPAQUE backdrop, every collapse path
// (Escape, outside tap, grabber pull-down/close) is a no-op, the composer TEXT
// + SEND are UNLOCKED (#12178 — typed text is answered by the in-chat conductor
// and never reaches the server) while attach + mic stay disabled, the CHOICE
// widgets stay interactive, and the sheet drops from full to the half detent
// (with the backdrop fading to the normal scrim) exactly once on the completion
// (falling) edge.

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

  it("unlocks the composer text during onboarding with an inviting placeholder; attach + mic stay inert", () => {
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} firstRunOpen />);

    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe("Ask me anything — or pick an option");

    // Attach + mic have no agent to serve them yet — still inert (pre-runtime).
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

  it("routes composer free text to the in-chat conductor during onboarding — send stays live but the server is never reached", () => {
    const sendActionMessage = seedAppStoreWithActionSpy();
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} firstRunOpen />);

    // CHAT_PREFILL_EVENT is a real non-keyboard draft entry point; the composer
    // is unlocked now, so it lands a draft and the send control goes live.
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CHAT_PREFILL_EVENT, {
          detail: { text: "free text mid-onboarding" },
        }),
      );
    });

    const send = screen.getByTestId("chat-composer-action");
    expect(send.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(send);
    // The typed text goes to the conductor via the shared action funnel — the
    // HARD rule: nothing reaches the server pre-completion.
    expect(controller.send).not.toHaveBeenCalled();
    expect(sendActionMessage).toHaveBeenCalledWith("free text mid-onboarding");
  });

  it("answers Enter-typed free text through the conductor funnel, never controller.send", () => {
    const sendActionMessage = seedAppStoreWithActionSpy();
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} firstRunOpen />);

    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "will this work yet?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(sendActionMessage).toHaveBeenCalledWith("will this work yet?");
    expect(controller.send).not.toHaveBeenCalled();
    // The composer clears after the conductor consumes the turn.
    expect(input.value).toBe("");
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
