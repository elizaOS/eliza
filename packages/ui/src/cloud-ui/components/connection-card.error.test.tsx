/** Verifies ConnectionCard — error state (#12784/#13419) through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * ConnectionCard three-state error surface (#12784/#13419).
 *
 * A failed connector status probe renders `status="error"` instead of
 * collapsing into the "disconnected" setup form. Provider rows stay quiet and
 * collapsed while one section-owned notice aggregates recovery.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionCard,
  ConnectionStatusNotice,
  ConnectionStatusProvider,
} from "./connection-card";

afterEach(() => {
  cleanup();
});

describe("ConnectionCard — error state (#12784/#13419)", () => {
  it("keeps an unavailable provider collapsed without repeating its diagnostic", () => {
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

    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("We couldn't load Twilio status.")).toBeNull();
    expect(screen.queryByText("SETUP FORM")).toBeNull();
    expect(screen.queryByText("CONNECTED PANEL")).toBeNull();
    expect(screen.queryByRole("button", { name: /Twilio/ })).toBeNull();
  });

  it("keeps a genuine disconnected setup compact until the user opens it", async () => {
    render(
      <ConnectionCard
        name="Twilio"
        icon={<span>icon</span>}
        description="desc"
        status="disconnected"
        setupContent={<div>SETUP FORM</div>}
      />,
    );

    expect(screen.queryByText("SETUP FORM")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Set up Twilio" }),
    );
    expect(screen.getByText("SETUP FORM")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Close Twilio" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("aggregates failed probes into one compact section-level retry", async () => {
    const retryTwilio = vi.fn();
    const retryTelegram = vi.fn();
    render(
      <ConnectionStatusProvider>
        <ConnectionStatusNotice />
        <ConnectionCard
          name="Twilio"
          icon={<span>icon</span>}
          description="desc"
          status="error"
          errorMessage="API server unavailable"
          onRetry={retryTwilio}
        />
        <ConnectionCard
          name="Telegram"
          icon={<span>icon</span>}
          description="desc"
          status="error"
          errorMessage="API server unavailable"
          onRetry={retryTelegram}
        />
      </ConnectionStatusProvider>,
    );

    await waitFor(() => {
      expect(screen.getAllByText("Status checks unavailable")).toHaveLength(1);
    });
    expect(screen.queryByText("API server unavailable")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Retry unavailable connections" }),
    );
    expect(retryTwilio).toHaveBeenCalledTimes(1);
    expect(retryTelegram).toHaveBeenCalledTimes(1);
  });
});
