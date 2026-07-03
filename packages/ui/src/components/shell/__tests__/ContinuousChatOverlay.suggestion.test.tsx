// @vitest-environment jsdom
//
// Proactive-suggestion affordance on the SHIPPED chat surface (#8792/#11387):
// the ContinuousChatOverlay ThreadLine must render the distinct Suggestion
// treatment (data-proactive-suggestion + "Do it" + dismiss) for assistant
// turns with source "proactive-interaction" — the overlay is the only chat
// surface mounted in the app shell, so without this the decider's suggestions
// rendered as plain replies with no accept/dismiss affordance.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../../state/app-store";
import { AppContext } from "../../../state/useApp";
import type { ShellMessage } from "../shell-state";

vi.mock("@elizaos/ui", () => ({
  Button: (props: Record<string, unknown>) => <button {...props} />,
}));

const clientMock = vi.hoisted(() => ({
  getPermission: vi.fn(() => Promise.resolve({ state: "granted" })),
  getPlugins: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../../../api/client", () => ({ client: clientMock }));

// The overlay module renders inline widgets; import after the mocks.
import { __renderThreadLineForParity } from "../ContinuousChatOverlay";

function withApp(node: React.ReactElement) {
  const appValue = {
    t: (key: string, vars?: Record<string, unknown>) =>
      String(vars?.defaultValue ?? key),
    loadPlugins: vi.fn(() => Promise.resolve()),
    sendActionMessage: vi.fn(),
    setActionNotice: vi.fn(),
    setTab: vi.fn(),
    handleChatRetry: vi.fn(),
  } as never;
  __setAppValueForTests(appValue);
  return render(
    <AppContext.Provider value={appValue}>{node}</AppContext.Provider>,
  );
}

function makeMessage(overrides: Partial<ShellMessage> = {}): ShellMessage {
  return {
    id: "sg-1",
    role: "assistant",
    content: "Want me to pull your latest balances?",
    createdAt: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  vi.clearAllMocks();
});

describe("ContinuousChatOverlay ThreadLine proactive suggestion (#8792)", () => {
  it("renders the Suggestion affordance for source proactive-interaction", () => {
    withApp(
      __renderThreadLineForParity(
        makeMessage({ source: "proactive-interaction" }),
        { onAcceptSuggestion: vi.fn(), onDismissSuggestion: vi.fn() },
      ),
    );
    expect(screen.getByText("Suggestion")).toBeTruthy();
    expect(
      document.querySelector('[data-proactive-suggestion="true"]'),
    ).toBeTruthy();
    expect(screen.getByLabelText("Do it")).toBeTruthy();
    expect(screen.getByLabelText("Dismiss suggestion")).toBeTruthy();
  });

  it("does NOT mark a normal assistant reply as a suggestion", () => {
    withApp(
      __renderThreadLineForParity(makeMessage(), {
        onAcceptSuggestion: vi.fn(),
        onDismissSuggestion: vi.fn(),
      }),
    );
    expect(screen.queryByText("Suggestion")).toBeNull();
    expect(
      document.querySelector('[data-proactive-suggestion="true"]'),
    ).toBeNull();
  });

  it("does NOT mark a USER turn as a suggestion even with the source tag", () => {
    withApp(
      __renderThreadLineForParity(
        makeMessage({ role: "user", source: "proactive-interaction" }),
        { onAcceptSuggestion: vi.fn(), onDismissSuggestion: vi.fn() },
      ),
    );
    expect(
      document.querySelector('[data-proactive-suggestion="true"]'),
    ).toBeNull();
  });

  it("dismiss removes by id; accept receives the full message", () => {
    const onAcceptSuggestion = vi.fn();
    const onDismissSuggestion = vi.fn();
    const message = makeMessage({ source: "proactive-interaction" });
    withApp(
      __renderThreadLineForParity(message, {
        onAcceptSuggestion,
        onDismissSuggestion,
      }),
    );
    fireEvent.click(screen.getByLabelText("Dismiss suggestion"));
    expect(onDismissSuggestion).toHaveBeenCalledWith("sg-1");
    fireEvent.click(screen.getByLabelText("Do it"));
    expect(onAcceptSuggestion).toHaveBeenCalledWith(message);
  });

  it("hides the accept/dismiss controls when no handlers are wired", () => {
    withApp(
      __renderThreadLineForParity(
        makeMessage({ source: "proactive-interaction" }),
      ),
    );
    expect(screen.getByText("Suggestion")).toBeTruthy();
    expect(screen.queryByLabelText("Do it")).toBeNull();
    expect(screen.queryByLabelText("Dismiss suggestion")).toBeNull();
  });
});
