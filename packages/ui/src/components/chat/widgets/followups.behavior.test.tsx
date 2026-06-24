// @vitest-environment jsdom

/**
 * Real behavior tests for {@link FollowupsWidget} (#9304). Each test renders the
 * actual widget, clicks a real chip with user-event, and asserts the concrete
 * effect: the exact callback payload fired, the row locking after a `reply`, the
 * row dismissing after a `navigate` or the X button, and the `prompt`
 * onPrompt→onChoose fallback. The widget's branching (handleAct in
 * followups.tsx:58-137) runs unmocked.
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FollowupOption } from "./followups";
import { FollowupsWidget } from "./followups";

afterEach(cleanup);

const replyA: FollowupOption = {
  kind: "reply",
  payload: "Yes, schedule it",
  label: "Yes, schedule it",
};
const replyB: FollowupOption = {
  kind: "reply",
  payload: "Not right now",
  label: "Not right now",
};
const navigate: FollowupOption = {
  kind: "navigate",
  payload: "/calendar",
  label: "Open calendar",
};
const promptOpt: FollowupOption = {
  kind: "prompt",
  payload: "Draft a follow-up email",
  label: "Draft email",
};

describe("FollowupsWidget — reply chip", () => {
  it("fires onChoose with the reply payload and locks the whole row", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    const onNavigate = vi.fn();
    render(
      <FollowupsWidget
        id="fu-reply"
        options={[replyA, replyB, navigate]}
        onChoose={onChoose}
        onNavigate={onNavigate}
      />,
    );

    await user.click(screen.getByTestId("followup-reply-Yes, schedule it"));

    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith("Yes, schedule it");

    // the chosen reply now shows a "Selected:" status and the dismiss X is gone
    expect(screen.getByRole("status").textContent).toMatch(/Yes, schedule it/);
    expect(screen.queryByTestId("followups-dismiss")).toBeNull();

    // every chip — including the untouched ones — is disabled (row locked)
    expect(
      (screen.getByTestId("followup-reply-Not right now") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("followup-navigate-/calendar") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // a second click on a locked chip is a no-op (one decision per prompt)
    await user.click(screen.getByTestId("followup-reply-Not right now"));
    await user.click(screen.getByTestId("followup-navigate-/calendar"));
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("FollowupsWidget — navigate chip", () => {
  it("fires onNavigate with the payload and dismisses the row", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    const onNavigate = vi.fn();
    render(
      <FollowupsWidget
        id="fu-nav"
        options={[navigate, replyA]}
        onChoose={onChoose}
        onNavigate={onNavigate}
      />,
    );

    await user.click(screen.getByTestId("followup-navigate-/calendar"));

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("/calendar");
    expect(onChoose).not.toHaveBeenCalled();

    // navigate dismisses the entire row → component returns null
    expect(screen.queryByLabelText("Suggested follow-ups")).toBeNull();
    expect(screen.queryByTestId("followup-reply-Yes, schedule it")).toBeNull();
  });
});

describe("FollowupsWidget — prompt chip", () => {
  it("fires onPrompt (not onChoose) when onPrompt is provided", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    const onPrompt = vi.fn();
    render(
      <FollowupsWidget
        id="fu-prompt"
        options={[promptOpt]}
        onChoose={onChoose}
        onPrompt={onPrompt}
      />,
    );

    await user.click(
      screen.getByTestId("followup-prompt-Draft a follow-up email"),
    );

    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt).toHaveBeenCalledWith("Draft a follow-up email");
    expect(onChoose).not.toHaveBeenCalled();

    // prompt does not lock or dismiss — the row stays interactive
    expect(screen.getByLabelText("Suggested follow-ups")).toBeTruthy();
    expect(screen.getByTestId("followups-dismiss")).toBeTruthy();
    expect(
      (
        screen.getByTestId(
          "followup-prompt-Draft a follow-up email",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("falls back to onChoose with the payload when onPrompt is absent", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    render(
      <FollowupsWidget
        id="fu-prompt-fallback"
        options={[promptOpt]}
        onChoose={onChoose}
      />,
    );

    await user.click(
      screen.getByTestId("followup-prompt-Draft a follow-up email"),
    );

    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith("Draft a follow-up email");

    // the fallback path is NOT a reply, so it does not lock the row
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("followups-dismiss")).toBeTruthy();
  });
});

describe("FollowupsWidget — dismiss button", () => {
  it("unmounts the row without firing any callback", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    const onNavigate = vi.fn();
    const onPrompt = vi.fn();
    render(
      <FollowupsWidget
        id="fu-dismiss"
        options={[replyA, navigate, promptOpt]}
        onChoose={onChoose}
        onNavigate={onNavigate}
        onPrompt={onPrompt}
      />,
    );

    expect(screen.getByLabelText("Suggested follow-ups")).toBeTruthy();

    await user.click(screen.getByTestId("followups-dismiss"));

    // the whole fieldset is gone (component returned null)
    expect(screen.queryByLabelText("Suggested follow-ups")).toBeNull();
    expect(screen.queryByTestId("followup-reply-Yes, schedule it")).toBeNull();
    expect(onChoose).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onPrompt).not.toHaveBeenCalled();
  });
});
