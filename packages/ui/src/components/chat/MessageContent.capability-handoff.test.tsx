/** Verifies the inline workspace gate and its in-app, resumable setup handoff. */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api/client-types-chat";
import { CAPABILITY_WORKSPACE_HANDOFF_STORAGE_KEY } from "../../capability-workspace-handoff";
import { NAVIGATE_VIEW_EVENT } from "../../events";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";

vi.mock("../../api/client", () => ({ client: {} }));

import { MessageContent } from "./MessageContent";

function withApp(node: React.ReactElement) {
  const appValue = {
    t: (key: string, vars?: Record<string, unknown>) =>
      String(vars?.defaultValue ?? key),
    sendActionMessage: vi.fn(),
  } as never;
  __setAppValueForTests(appValue);
  return render(
    <AppContext.Provider value={appValue}>{node}</AppContext.Provider>,
  );
}

describe("MessageContent capability workspace handoff", () => {
  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    __setAppValueForTests(null);
  });

  it("renders an inline card, preserves intent, and navigates inside the app", () => {
    const navigations: CustomEvent[] = [];
    const onNavigate = (event: Event) => navigations.push(event as CustomEvent);
    window.addEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
    const message: ConversationMessage = {
      id: "assistant-1",
      role: "assistant",
      text: "Calendar needs your personal workspace. I'll keep this ready.",
      timestamp: 1_700_000_000_000,
      capabilityHandoff: {
        version: 1,
        kind: "capability_handoff",
        capabilityId: "calendar",
        label: "Calendar",
        availability: "needs_workspace",
        reason: "Calendar needs your personal workspace.",
        currentTier: "shared",
        requiredTier: "personal",
        nextAction: "upgrade_workspace",
        requiresConfirmation: false,
        cta: {
          label: "Set up personal workspace",
          href: "/cloud/agents/agent-1",
        },
        continuation: { originalIntent: "Move tomorrow's meeting to 3pm" },
      },
    };

    withApp(<MessageContent message={message} />);
    expect(screen.getByTestId("capability-workspace-setup")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Set up personal workspace" }),
    );

    expect(navigations.at(-1)?.detail).toEqual({
      viewId: "cloud",
      viewPath: "/cloud/agents/agent-1",
    });
    expect(
      JSON.parse(
        window.sessionStorage.getItem(
          CAPABILITY_WORKSPACE_HANDOFF_STORAGE_KEY,
        ) ?? "null",
      ),
    ).toMatchObject({
      handoff: {
        capabilityId: "calendar",
        continuation: { originalIntent: "Move tomorrow's meeting to 3pm" },
      },
    });
    window.removeEventListener(NAVIGATE_VIEW_EVENT, onNavigate);
  });
});
