/**
 * Renders AutoTopUpCard through SettingsSwitchRow and asserts load, draft
 * toggle, and save persist. jsdom, mocked billing settings API.
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

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? key,
}));

import { AutoTopUpCard } from "./auto-top-up-card";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  apiMock.mockReset();
});

const loadedSettings = {
  settings: {
    autoTopUp: {
      enabled: false,
      amount: 25,
      threshold: 10,
      hasPaymentMethod: true,
    },
    limits: {
      minAmount: 5,
      maxAmount: 500,
      minThreshold: 1,
      maxThreshold: 200,
    },
  },
};

describe("AutoTopUpCard", () => {
  it("loads the enable switch as SettingsSwitchRow inside the BrandCard editor", async () => {
    apiMock.mockResolvedValueOnce(loadedSettings);

    render(<AutoTopUpCard />);

    expect(await screen.findByText("Auto Top-Up (Card)")).toBeTruthy();
    expect(screen.getByText("Enable card auto top-up")).toBeTruthy();
    const toggle = await screen.findByRole("switch");
    expect(toggle.getAttribute("id")).toBe("cloud-billing-auto-top-up");
    expect(
      toggle.getAttribute("data-state") ?? toggle.getAttribute("aria-checked"),
    ).toMatch(/unchecked|false/);
    expect(apiMock).toHaveBeenCalledWith("/api/v1/billing/settings");
    expect(screen.getByText("Top-up amount")).toBeTruthy();
    expect(screen.getByText("Trigger threshold")).toBeTruthy();
    expect(
      screen.getByTestId("cloud-billing-auto-top-up-amount"),
    ).toHaveProperty("value", "25");
    expect(
      screen.getByTestId("cloud-billing-auto-top-up-threshold"),
    ).toHaveProperty("value", "10");
    expect(screen.getByRole("button", { name: /save/i })).toBeTruthy();
  });

  it("shows the amount error on the amount field when the value is below the limit", async () => {
    apiMock.mockResolvedValueOnce(loadedSettings);

    render(<AutoTopUpCard />);
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);
    fireEvent.change(screen.getByTestId("cloud-billing-auto-top-up-amount"), {
      target: { value: "1" },
    });

    const alert = await screen.findByRole("alert");
    expect(alert.id).toBe("cloud-billing-auto-top-up-amount-error");
    expect(alert.textContent).toMatch(/Enter at least/i);
    const save = screen.getByRole("button", { name: /save/i });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    expect(document.activeElement).toBe(
      screen.getByTestId("cloud-billing-auto-top-up-amount"),
    );
  });

  it("keeps the toggle as draft until Save PUTs the autoTopUp payload", async () => {
    apiMock
      .mockResolvedValueOnce(loadedSettings)
      .mockResolvedValueOnce(loadedSettings);

    render(<AutoTopUpCard />);
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);

    expect(apiMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(apiMock).toHaveBeenLastCalledWith("/api/v1/billing/settings", {
        method: "PUT",
        json: {
          autoTopUp: {
            enabled: true,
            amount: 25,
            threshold: 10,
          },
        },
      });
    });
  });

  it("disables the enable switch when no payment method is saved", async () => {
    apiMock.mockResolvedValueOnce({
      settings: {
        autoTopUp: {
          enabled: false,
          amount: 25,
          threshold: 10,
          hasPaymentMethod: false,
        },
        limits: loadedSettings.settings.limits,
      },
    });

    render(<AutoTopUpCard />);
    const toggle = await screen.findByRole("switch");
    expect(toggle).toHaveProperty("disabled", true);
    expect(screen.getByText(/No saved payment method/i)).toBeTruthy();
  });
});
