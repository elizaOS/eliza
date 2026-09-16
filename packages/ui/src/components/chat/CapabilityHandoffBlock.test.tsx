// @vitest-environment jsdom
/** Verifies the real capability-handoff card records continuation and navigates within the app without opening an external browser. */

import type { CapabilityHandoffRequest } from "@elizaos/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenForNavigateViewRequests } from "../../events";
import { CapabilityHandoffBlock } from "./CapabilityHandoffBlock";

const request: CapabilityHandoffRequest = {
  version: 1,
  kind: "capability_handoff",
  capabilityId: "calendar",
  label: "Calendar",
  availability: "needs_workspace",
  reason: "Calendar needs setup before it can be used safely.",
  currentTier: "shared",
  requiredTier: "personal",
  nextAction: "upgrade_workspace",
  requiresConfirmation: true,
  cta: {
    label: "Set up personal workspace",
    href: "/cloud/agents/agent-1",
  },
  continuation: { originalIntent: "Move tomorrow's meeting to 3." },
};

describe("CapabilityHandoffBlock", () => {
  afterEach(cleanup);

  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("shows concise value and preserves explicit review after same-app setup", async () => {
    const opened = vi.spyOn(window, "open");
    const navigate = vi.fn((_event: Event) => true);
    const stopListening = listenForNavigateViewRequests(navigate);
    render(
      <MemoryRouter>
        <CapabilityHandoffBlock request={request} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Set up Calendar")).toBeTruthy();
    expect(screen.getByText(/put your request back/i)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Set up personal workspace" }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({
      viewId: "cloud",
      viewPath: "/cloud/agents/agent-1",
    });
    expect(opened).not.toHaveBeenCalled();
    expect(
      window.sessionStorage.getItem("eliza:capability-handoff:pending"),
    ).toContain("Move tomorrow's meeting to 3.");
    stopListening();
  });

  it("clears the continuation when contained setup is unavailable", async () => {
    render(<CapabilityHandoffBlock request={request} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Set up personal workspace" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Setup can’t open inside this app yet",
    );
    expect(
      window.sessionStorage.getItem("eliza:capability-handoff:pending"),
    ).toBeNull();
  });
});
