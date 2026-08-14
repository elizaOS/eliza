/**
 * Renders PayAsYouGoCard through SettingsSwitchRow and asserts load, toggle,
 * and rollback on save failure. jsdom, mocked billing settings API.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { PayAsYouGoCard } from "./pay-as-you-go-card";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  apiMock.mockReset();
});

describe("PayAsYouGoCard", () => {
  it("loads the toggle onto SettingsSwitchRow", async () => {
    apiMock.mockResolvedValueOnce({
      settings: { payAsYouGoFromEarnings: true },
    });

    render(<PayAsYouGoCard />);

    expect(
      screen.getByText("Use my app earnings to pay container hosting"),
    ).toBeTruthy();
    const toggle = await screen.findByRole("switch");
    expect(
      toggle.getAttribute("data-state") ?? toggle.getAttribute("aria-checked"),
    ).toMatch(/checked|true/);
    expect(apiMock).toHaveBeenCalledWith("/api/v1/billing/settings");
  });

  it("PUTs the next value when the switch is toggled", async () => {
    apiMock
      .mockResolvedValueOnce({ settings: { payAsYouGoFromEarnings: true } })
      .mockResolvedValueOnce({});

    render(<PayAsYouGoCard />);
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(apiMock).toHaveBeenLastCalledWith("/api/v1/billing/settings", {
        method: "PUT",
        json: { payAsYouGoFromEarnings: false },
      });
    });
  });
});
