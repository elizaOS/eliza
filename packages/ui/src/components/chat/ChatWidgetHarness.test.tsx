// @vitest-environment jsdom
//
// The backend-free chat harness mounts the REAL ContinuousChatOverlay with a
// scripted conversation. These tests render it in jsdom (API client stubbed —
// no network) and assert the onboarding opening, that composer sends advance
// the script entirely in local state, and that the onboarding pin releases.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  client: {
    fetch: vi.fn().mockRejectedValue(new Error("no api in test")),
    getCodingAgentTaskThread: vi.fn().mockRejectedValue(new Error("no api in test")),
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
      "[FOLLOWUPS]",
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
