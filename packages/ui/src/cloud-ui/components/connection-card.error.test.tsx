// @vitest-environment jsdom

/**
 * ConnectionCard three-state error surface (#12784/#13419).
 *
 * A failed connector status probe now renders `status="error"` — a
 * distinguishable state with an alert + retry — instead of collapsing into the
 * "disconnected" setup form. These tests pin that the error branch renders its
 * own content (not the setup form), and that the retry affordance is wired.
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionCard } from "./connection-card";

afterEach(() => {
  cleanup();
});

describe("ConnectionCard — error state (#12784/#13419)", () => {
  it("renders a distinguishable alert (not the setup form) when status is error", () => {
    render(
      <ConnectionCard
        name="Twilio"
        icon={<span>icon</span>}
        description="desc"
        status="error"
        errorMessage="We couldn't load Twilio status."
        setupContent={<div>SETUP FORM</div>}
        connectedContent={<div>CONNECTED PANEL</div>}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "We couldn't load Twilio status.",
    );
    // The regression this guards: an errored probe must NOT show the setup form
    // (which would read as a healthy "not connected" connector).
    expect(screen.queryByText("SETUP FORM")).toBeNull();
    expect(screen.queryByText("CONNECTED PANEL")).toBeNull();
  });

  it("still renders the setup form for a genuine disconnected status", () => {
    render(
      <ConnectionCard
        name="Twilio"
        icon={<span>icon</span>}
        description="desc"
        status="disconnected"
        setupContent={<div>SETUP FORM</div>}
      />,
    );

    expect(screen.getByText("SETUP FORM")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("invokes onRetry when the retry button is pressed", async () => {
    const onRetry = vi.fn();
    render(
      <ConnectionCard
        name="Twilio"
        icon={<span>icon</span>}
        description="desc"
        status="error"
        errorMessage="boom"
        onRetry={onRetry}
        retryLabel="Try again"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
